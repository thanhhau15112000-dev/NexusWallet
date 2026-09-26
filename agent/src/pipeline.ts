/**
 * The request lifecycle: understand -> plan -> policy -> execute, hold, or deny.
 *
 * Nothing between a model and the chain can bypass `evaluatePolicy`. The signer
 * is reachable from exactly two places: an `allow` verdict here, and a verified
 * owner signature in `approvals.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  buildApprovalMessage,
  evaluatePolicy,
  solToLamports,
  type ApprovalPayload,
  type ExecutionRecord,
  type ModelContext,
  type PaymentRequest,
  type ResolvedAction,
} from '@nexus/shared';
import {
  TransactionSimulationError,
  explorerTxUrl,
  getLamportBalance,
  transferSol,
  transferSpl,
} from './chain.js';
import type { AppContext } from './context.js';
import { randomNonce } from './crypto.js';

function modelContext(ctx: AppContext): ModelContext {
  const policy = ctx.store.getPolicy();
  return {
    agentId: policy.agentId,
    cluster: ctx.config.SOLANA_CLUSTER,
    maxSolPerTx: policy.maxSolLamportsPerTx,
    recipients: policy.allowedRecipients,
    mints: policy.allowedMints,
  };
}

function newRequest(agentId: string, prompt: string, idempotencyKey: string | null): PaymentRequest {
  const now = new Date().toISOString();
  return {
    id: `req_${randomUUID().slice(0, 12)}`,
    agentId,
    createdAt: now,
    updatedAt: now,
    status: 'planned',
    prompt,
    idempotencyKey,
    intent: null,
    plan: null,
    decision: null,
    modelTrace: null,
    approval: null,
    execution: null,
    balanceLamports: null,
    error: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function planMatchesIntent(
  intent: NonNullable<PaymentRequest['intent']>,
  action: NonNullable<PaymentRequest['plan']>['action'],
  policy: ReturnType<AppContext['store']['getPolicy']>,
): boolean {
  if (intent.operation === 'unknown') return action.type === 'request_manual_approval';

  if (intent.operation === 'get_balance') return action.type === 'get_balance';

  const { recipient, amount, asset } = intent.entities;
  if (!recipient || amount === undefined) return false;

  const sameConfiguredReference = (
    expected: string,
    planned: string,
    entries: { label: string; address: string }[],
  ): boolean => {
    const expectedValue = expected.trim();
    const plannedValue = planned.trim();
    if (expectedValue === plannedValue) return true;

    const resolve = (value: string) =>
      entries.find(
        (entry) =>
          entry.address === value || entry.label.toLowerCase() === value.toLowerCase(),
      )?.address;
    const expectedAddress = resolve(expectedValue);
    return expectedAddress !== undefined && expectedAddress === resolve(plannedValue);
  };

  if (intent.operation === 'transfer_sol') {
    if (action.type !== 'transfer_sol') return false;
    const amountIsLamports = /^lamports?$/i.test(asset ?? '');
    const requestedLamports = amountIsLamports ? Math.round(amount) : solToLamports(amount);
    return (
      Number.isSafeInteger(requestedLamports) &&
      requestedLamports === solToLamports(action.amountSol) &&
      sameConfiguredReference(recipient, action.recipient, policy.allowedRecipients)
    );
  }

  if (action.type !== 'transfer_spl' || !asset) return false;
  return (
    amount === action.amount &&
    sameConfiguredReference(recipient, action.recipient, policy.allowedRecipients) &&
    sameConfiguredReference(asset, action.mint, policy.allowedMints)
  );
}

const inFlightCommands = new WeakMap<AppContext, Map<string, Promise<PaymentRequest>>>();

async function processCommand(
  ctx: AppContext,
  input: { prompt: string; idempotencyKey?: string | null },
  idempotencyKey: string | null,
): Promise<PaymentRequest> {
  const policy = ctx.store.getPolicy();
  let request = ctx.store.putRequest(newRequest(policy.agentId, input.prompt, idempotencyKey));
  ctx.audit.record('request.created', request.id, { prompt: input.prompt });

  const mctx = modelContext(ctx);
  // The pipeline falls back to the deterministic parser instead of throwing, but
  // a throw here would otherwise leave the request stuck in `planned`.
  let intent;
  let plan;
  try {
    intent = await ctx.model.understand(input.prompt, mctx);
    plan = await ctx.model.plan(intent.value, mctx);
  } catch (err) {
    ctx.audit.record('model.failed', request.id, { error: errorMessage(err) });
    return ctx.store.putRequest({
      ...request,
      status: 'failed',
      error: { code: 'model_error', message: errorMessage(err) },
    });
  }

  request = ctx.store.putRequest({
    ...request,
    intent: intent.value,
    plan: plan.value,
    modelTrace: { stage1: intent.meta, stage2: plan.meta },
  });
  ctx.audit.record('model.planned', request.id, {
    intent: intent.value,
    plan: plan.value,
    trace: { stage1: intent.meta, stage2: plan.meta },
  });

  // The model call can take long enough for the policy to change. Evaluate
  // against the latest policy, not the snapshot used to build the prompt.
  const currentPolicy = ctx.store.getPolicy();
  const baseDecision = planMatchesIntent(intent.value, plan.value.action, currentPolicy)
    ? evaluatePolicy(currentPolicy, plan.value.action)
    : {
        verdict: 'deny' as const,
        policyVersion: currentPolicy.version,
        reasons: ['model plan does not match the classified intent'],
        resolved: null,
      };
  const decision =
    intent.value.requiresHuman &&
    baseDecision.verdict === 'allow' &&
    baseDecision.resolved?.type !== 'get_balance'
      ? {
          ...baseDecision,
          verdict: 'require_approval' as const,
          reasons: [...baseDecision.reasons, 'model requested human approval'],
        }
      : baseDecision;
  request = ctx.store.putRequest({ ...request, decision });
  ctx.audit.record('policy.decided', request.id, {
    verdict: decision.verdict,
    reasons: decision.reasons,
    policyVersion: decision.policyVersion,
  });

  if (decision.verdict === 'deny' || !decision.resolved) {
    return ctx.store.putRequest({
      ...request,
      status: 'denied',
      error: { code: 'policy_denied', message: decision.reasons.join('; ') },
    });
  }

  if (decision.verdict === 'require_approval') {
    const resolved = decision.resolved;
    if (resolved.type === 'get_balance') {
      return ctx.store.putRequest({
        ...request,
        status: 'denied',
        error: { code: 'policy_denied', message: 'action is not approvable' },
      });
    }

    const payload: ApprovalPayload = {
      requestId: request.id,
      agentId: currentPolicy.agentId,
      policyVersion: currentPolicy.version,
      actionType: resolved.type,
      recipient: resolved.recipient,
      amount: resolved.type === 'transfer_sol' ? resolved.lamports : resolved.amount,
      mint: resolved.type === 'transfer_sol' ? 'native' : resolved.mint,
      nonce: randomNonce(),
      expiresAt: new Date(Date.now() + ctx.config.APPROVAL_TTL_SECONDS * 1000).toISOString(),
    };

    request = ctx.store.putRequest({
      ...request,
      status: 'pending_approval',
      approval: {
        payload,
        message: buildApprovalMessage(payload),
        signature: null,
        signerPubkey: null,
        signedAt: null,
        consumedAt: null,
      },
    });
    ctx.audit.record('approval.requested', request.id, { payload });
    return request;
  }

  return execute(ctx, ctx.store.putRequest({ ...request, status: 'auto_approved' }));
}

/**
 * Return the same in-flight result for concurrent retries carrying one key.
 * The persisted store handles retries after completion; this map closes the
 * async gap between the initial lookup and the first state write.
 */
export function runCommand(
  ctx: AppContext,
  input: { prompt: string; idempotencyKey?: string | null },
): Promise<PaymentRequest> {
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (!idempotencyKey) return processCommand(ctx, input, null);

  const pending = inFlightCommands.get(ctx);
  const current = pending?.get(idempotencyKey);
  if (current) return current;

  const existing = ctx.store.findByIdempotencyKey(idempotencyKey);
  if (existing) return Promise.resolve(existing);

  const commands = pending ?? new Map<string, Promise<PaymentRequest>>();
  if (!pending) inFlightCommands.set(ctx, commands);

  const promise = processCommand(ctx, { ...input, idempotencyKey }, idempotencyKey).finally(() => {
    commands.delete(idempotencyKey);
  });
  commands.set(idempotencyKey, promise);
  return promise;
}

/**
 * Sign and submit. Shared tail for the auto-approved path and the owner-approved
 * path; it is never called without a policy verdict behind it.
 */
export async function execute(ctx: AppContext, request: PaymentRequest): Promise<PaymentRequest> {
  const action: ResolvedAction | null | undefined = request.decision?.resolved;
  if (!action) {
    return ctx.store.putRequest({
      ...request,
      status: 'failed',
      error: { code: 'no_action', message: 'request has no resolved action' },
    });
  }

  if (
    action.type !== 'get_balance' &&
    request.decision?.policyVersion !== ctx.store.getPolicy().version
  ) {
    const message = 'policy changed before execution; re-run the command';
    ctx.audit.record('tx.blocked', request.id, { reason: 'policy_changed' });
    return ctx.store.putRequest({
      ...request,
      status: 'denied',
      error: { code: 'policy_changed', message },
    });
  }

  try {
    if (action.type === 'get_balance') {
      const lamports = await getLamportBalance(ctx.connection, ctx.agentPubkey);
      return ctx.store.putRequest({ ...request, status: 'confirmed', balanceLamports: lamports });
    }

    const submittedAt = new Date().toISOString();
    const result =
      action.type === 'transfer_sol'
        ? await transferSol({
            connection: ctx.connection,
            payer: ctx.signer,
            recipient: action.recipient,
            lamports: action.lamports,
          })
        : await transferSpl({
            connection: ctx.connection,
            payer: ctx.signer,
            recipient: action.recipient,
            mint: action.mint,
            amount: action.amount,
          });

    const execution: ExecutionRecord = {
      signature: result.signature,
      explorerUrl: explorerTxUrl(result.signature, ctx.config.SOLANA_CLUSTER),
      submittedAt,
      confirmedAt: new Date().toISOString(),
      slot: result.slot,
    };
    ctx.audit.record('tx.confirmed', request.id, { action, ...execution });

    return ctx.store.putRequest({ ...request, status: 'confirmed', execution });
  } catch (err) {
    if (err instanceof TransactionSimulationError) {
      ctx.audit.record('tx.simulation_failed', request.id, {
        error: err.simulationError,
        logs: err.logs,
      });
    }
    ctx.audit.record('tx.failed', request.id, { error: errorMessage(err) });
    return ctx.store.putRequest({
      ...request,
      status: 'failed',
      error: { code: 'execution_failed', message: errorMessage(err) },
    });
  }
}
