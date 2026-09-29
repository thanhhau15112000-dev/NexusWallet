import { buildApprovalMessage, type PaymentRequest } from '@nexus/shared';
import { safeEqual, verifyMessageSignature } from './crypto.js';
import type { AppContext } from './context.js';
import { execute } from './pipeline.js';

export class ApprovalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function markApprovalExpired(ctx: AppContext, request: PaymentRequest): PaymentRequest {
  if (request.status !== 'pending_approval' || !request.approval) return request;
  const updated = ctx.store.putRequest({
    ...request,
    status: 'expired',
    error: { code: 'expired', message: 'approval window closed' },
  });
  ctx.audit.record('approval.expired', request.id, {
    expiresAt: request.approval.payload.expiresAt,
  });
  return updated;
}

/** Persist approval expirations as a terminal request state whenever requests are read. */
export function expirePendingApprovals(ctx: AppContext, now = Date.now()): PaymentRequest[] {
  const expired: PaymentRequest[] = [];
  for (const request of ctx.store.listRequests()) {
    if (
      request.status !== 'pending_approval'
      || !request.approval
      || new Date(request.approval.payload.expiresAt).getTime() > now
    ) continue;
    expired.push(markApprovalExpired(ctx, request));
  }
  return expired;
}

/**
 * Owner withdraws a transfer that is still waiting for approval. Nothing was signed, so this only
 * closes the request; it can never be approved afterwards (approve requires `pending_approval`).
 */
export function cancelRequest(ctx: AppContext, requestId: string): PaymentRequest {
  const request = ctx.store.getRequest(requestId);
  if (!request) throw new ApprovalError('not_found', 'request not found');
  if (request.status !== 'pending_approval' || !request.approval) {
    throw new ApprovalError('bad_status', `request is ${request.status}, not pending_approval`);
  }
  const updated = ctx.store.putRequest({
    ...request,
    status: 'denied',
    error: { code: 'cancelled', message: 'cancelled by owner' },
  });
  ctx.audit.record('approval.cancelled', request.id, {});
  return updated;
}

const inFlightApprovals = new WeakMap<AppContext, Map<string, Promise<PaymentRequest>>>();

/**
 * Verify an owner approval and, only then, run the transfer the policy engine
 * refused to auto-approve.
 *
 * Every check below is a hard gate:
 *  - the request must still be waiting for approval (no re-execution)
 *  - the approval must not have been consumed (no replay)
 *  - the approval must not have expired
 *  - the signer must be the bound owner wallet (no third-party approval)
 *  - the policy version must be unchanged since the approval was issued
 *  - the signed message must be byte-identical to the one the agent issued
 */
async function approveRequestOnce(
  ctx: AppContext,
  input: { requestId: string; signature: string; signerPubkey: string },
): Promise<PaymentRequest> {
  const request = ctx.store.getRequest(input.requestId);
  if (!request) throw new ApprovalError('not_found', 'request not found');
  if (!request.approval) throw new ApprovalError('no_approval', 'request has no pending approval');

  const reject = (code: string, message: string): never => {
    ctx.audit.record('approval.rejected', request.id, { code, message, signer: input.signerPubkey });
    throw new ApprovalError(code, message);
  };

  if (Boolean(ctx.store.isFrozen?.())) {
    reject('agent_frozen', 'agent is frozen by owner');
  }

  if (request.status !== 'pending_approval') {
    reject('bad_status', `request is ${request.status}, not pending_approval`);
  }
  if (request.approval.consumedAt) {
    reject('replay', 'this approval was already used');
  }
  if (new Date(request.approval.payload.expiresAt).getTime() <= Date.now()) {
    markApprovalExpired(ctx, request);
    reject('expired', 'approval expired; re-run the command to get a fresh one');
  }

  const owner = ctx.store.getOwner();
  if (!owner) reject('no_owner', 'no owner wallet is bound to this agent');
  if (!safeEqual(owner as string, input.signerPubkey)) {
    reject('wrong_signer', 'signature is not from the bound owner wallet');
  }

  const policy = ctx.store.getPolicy();
  if (policy.version !== request.approval.payload.policyVersion) {
    reject(
      'policy_changed',
      `approval was issued under policy v${request.approval.payload.policyVersion}, current is v${policy.version}`,
    );
  }

  const action = request.decision?.resolved;
  const payload = request.approval.payload;
  const matchesAction =
    action?.type === 'transfer_sol'
      ? payload.actionType === 'transfer_sol' &&
        payload.requestId === request.id &&
        payload.agentId === request.agentId &&
        payload.recipient === action.recipient &&
        payload.amount === action.lamports &&
        payload.mint === 'native'
      : action?.type === 'transfer_spl'
        ? payload.actionType === 'transfer_spl' &&
          payload.requestId === request.id &&
          payload.agentId === request.agentId &&
          payload.recipient === action.recipient &&
          payload.amount === action.amount &&
          payload.mint === action.mint
        : false;
  if (!matchesAction) {
    reject('approval_mismatch', 'approval payload does not match the executable action');
  }

  // Rebuild the message from the stored payload rather than trusting the copy
  // held by the client, so a tampered message cannot be swapped in.
  const expected = buildApprovalMessage(request.approval.payload);
  if (expected !== request.approval.message) {
    reject('message_mismatch', 'stored approval message does not match its payload');
  }
  if (
    !verifyMessageSignature({
      message: expected,
      signatureBase58: input.signature,
      pubkeyBase58: input.signerPubkey,
    })
  ) {
    reject('bad_signature', 'signature does not verify against the approval message');
  }

  const now = new Date().toISOString();
  const approved = ctx.store.putRequest({
    ...request,
    status: 'approved',
    approval: {
      ...request.approval,
      signature: input.signature,
      signerPubkey: input.signerPubkey,
      signedAt: now,
      // Consumed before execution: a crash mid-send cannot be retried into a
      // second transfer with the same signature.
      consumedAt: now,
    },
  });
  ctx.audit.record('approval.accepted', request.id, {
    signer: input.signerPubkey,
    policyVersion: policy.version,
  });

  return execute(ctx, approved);
}

/** Serialize approval attempts for one request so two concurrent HTTP retries cannot execute twice. */
export function approveRequest(
  ctx: AppContext,
  input: { requestId: string; signature: string; signerPubkey: string },
): Promise<PaymentRequest> {
  let pending = inFlightApprovals.get(ctx);
  if (!pending) {
    pending = new Map();
    inFlightApprovals.set(ctx, pending);
  }

  const current = pending.get(input.requestId);
  if (current) return current;

  const promise = approveRequestOnce(ctx, input).finally(() => {
    pending?.delete(input.requestId);
  });
  pending.set(input.requestId, promise);
  return promise;
}
