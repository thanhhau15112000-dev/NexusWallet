import {
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  AGENT_ERROR_REMEDIATION,
  ActionGetResponseSchema,
  ActionPostResponseSchema,
  spentLamportsInWindow,
  type ActionExecutionResult,
  type ActionGetResponse,
  type ActionInspectionResult,
} from '@nexus/shared';
import type { AppContext } from './context.js';
import { randomNonce } from './crypto.js';
import { buildApprovalMessage, type ApprovalPayload, type PaymentRequest } from '@nexus/shared';
import { randomUUID } from 'node:crypto';

export async function fetchActionMetadata(actionUrl: string): Promise<ActionGetResponse> {
  const res = await fetch(actionUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Solana Action metadata: HTTP ${res.status}`);
  }
  const json = await res.json();
  return ActionGetResponseSchema.parse(json);
}

export async function fetchActionTransaction(
  actionUrl: string,
  agentPubkey: string,
  params?: Record<string, unknown>,
): Promise<{ transactionBase64: string; message?: string }> {
  const res = await fetch(actionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ account: agentPubkey, ...params }),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Solana Action transaction: HTTP ${res.status}`);
  }
  const json = await res.json();
  const parsed = ActionPostResponseSchema.parse(json);
  return { transactionBase64: parsed.transaction, message: parsed.message };
}

export function decodeTransaction(rawBase64: string): {
  versioned?: VersionedTransaction;
  legacy?: Transaction;
  allAccountKeys: string[];
} {
  const buffer = Buffer.from(rawBase64, 'base64');
  try {
    const versioned = VersionedTransaction.deserialize(buffer);
    const keys = versioned.message.staticAccountKeys.map((k) => k.toBase58());
    return { versioned, allAccountKeys: keys };
  } catch {
    const legacy = Transaction.from(buffer);
    const keys = legacy.instructions.flatMap((ix) => ix.keys.map((k) => k.pubkey.toBase58()));
    return { legacy, allAccountKeys: [...new Set(keys)] };
  }
}

export function extractTargetRecipients(
  decoded: ReturnType<typeof decodeTransaction>,
  agentPubkey: string,
): string[] {
  const systemId = SystemProgram.programId.toBase58();
  const tokenIds = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]);
  const recipients: string[] = [];

  if (decoded.legacy) {
    for (const ix of decoded.legacy.instructions) {
      const prog = ix.programId.toBase58();
      if (prog === systemId) {
        // System transfer: keys[0] = from, keys[1] = to
        if (ix.keys.length >= 2 && ix.keys[0]?.pubkey.toBase58() === agentPubkey) {
          recipients.push(ix.keys[1]!.pubkey.toBase58());
        }
      } else if (tokenIds.has(prog)) {
        // SPL token transfer destination
        if (ix.keys.length >= 2) {
          recipients.push(ix.keys[1]!.pubkey.toBase58());
        }
      }
    }
  } else if (decoded.versioned) {
    const msg = decoded.versioned.message;
    for (const ix of msg.compiledInstructions) {
      const progKey = msg.staticAccountKeys[ix.programIdIndex]?.toBase58();
      if (progKey === systemId && ix.accountKeyIndexes.length >= 2) {
        const from = msg.staticAccountKeys[ix.accountKeyIndexes[0]!]?.toBase58();
        const to = msg.staticAccountKeys[ix.accountKeyIndexes[1]!]?.toBase58();
        if (from === agentPubkey && to) {
          recipients.push(to);
        }
      }
    }
  }

  // If no explicit system transfer detected, include any writable non-system account that is not the agent
  if (recipients.length === 0) {
    const ignored = new Set([
      agentPubkey,
      systemId,
      'ComputeBudget111111111111111111111111111111',
      'SysvarRent111111111111111111111111111111111',
    ]);
    for (const key of decoded.allAccountKeys) {
      if (!ignored.has(key)) recipients.push(key);
    }
  }

  return [...new Set(recipients)];
}

export async function inspectAndSimulateAction(
  ctx: AppContext,
  actionUrl: string,
  params?: Record<string, unknown>,
): Promise<ActionInspectionResult> {
  const metadata = await fetchActionMetadata(actionUrl);
  const { transactionBase64 } = await fetchActionTransaction(actionUrl, ctx.agentPubkey, params);
  const decoded = decodeTransaction(transactionBase64);
  const detectedRecipients = extractTargetRecipients(decoded, ctx.agentPubkey);

  const preBalance = await ctx.connection.getBalance(new PublicKey(ctx.agentPubkey), 'confirmed');

  const txToSimulate = decoded.versioned ?? decoded.legacy!;
  const sim = await ctx.connection.simulateTransaction(txToSimulate as never, {
    sigVerify: false,
    commitment: 'confirmed',
    accounts: {
      encoding: 'base64',
      addresses: [ctx.agentPubkey],
    },
  });

  if (sim.value.err) {
    throw new Error(
      `Solana Action simulation failed: ${JSON.stringify(sim.value.err)}; logs: ${(sim.value.logs ?? []).join(' | ')}`,
    );
  }

  const postLamports = sim.value.accounts?.[0]?.lamports ?? preBalance;
  const simulatedSolOutflowLamports = Math.max(0, preBalance - postLamports);

  return {
    actionMetadata: metadata,
    transactionBase64,
    simulatedSolOutflowLamports,
    detectedRecipients,
    detectedMints: [],
    simulationLogs: sim.value.logs ?? [],
  };
}

export async function executeSolanaActionGuard(
  ctx: AppContext,
  actionUrl: string,
  params?: Record<string, unknown>,
): Promise<ActionExecutionResult> {
  if (ctx.store.isFrozen?.()) {
    return {
      status: 'denied',
      code: 'AGENT_FROZEN',
      message: 'Agent is frozen by owner. No actions can be executed.',
      remediation: AGENT_ERROR_REMEDIATION.AGENT_FROZEN,
    };
  }

  let inspection: ActionInspectionResult;
  try {
    inspection = await inspectAndSimulateAction(ctx, actionUrl, params);
  } catch (err) {
    return {
      status: 'denied',
      code: 'SIMULATION_FAILED',
      message: err instanceof Error ? err.message : String(err),
      remediation: 'Ensure the Solana Action generates a valid transaction on the current cluster.',
    };
  }

  const policy = ctx.store.getPolicy();
  const allowedAddresses = new Set(
    policy.allowedRecipients.map((r) => r.address).concat(policy.allowedRecipients.map((r) => r.label.toLowerCase())),
  );

  // Validate recipients if funds leave the wallet
  if (inspection.simulatedSolOutflowLamports > 0 && inspection.detectedRecipients.length > 0) {
    const unallowed = inspection.detectedRecipients.filter(
      (r) => !allowedAddresses.has(r) && !allowedAddresses.has(r.toLowerCase()),
    );
    if (unallowed.length > 0) {
      return {
        status: 'denied',
        code: 'RECIPIENT_NOT_IN_ALLOWLIST',
        message: `Action recipient "${unallowed.join(', ')}" is not in the allowlist`,
        remediation: AGENT_ERROR_REMEDIATION.RECIPIENT_NOT_IN_ALLOWLIST,
        details: { unallowedRecipients: unallowed, allowedRecipients: policy.allowedRecipients },
      };
    }
  }

  // Check spend caps
  const spent24h = spentLamportsInWindow(ctx.store.listRequests());
  const exceedsTx = inspection.simulatedSolOutflowLamports > policy.maxSolLamportsPerTx;
  const exceedsDaily =
    policy.maxSolLamportsPerDay !== null &&
    spent24h + inspection.simulatedSolOutflowLamports > policy.maxSolLamportsPerDay;

  const dashboardUrl = ctx.config.allowedOrigins?.[0] ?? ctx.config.WEB_ORIGIN;

  if (exceedsTx || exceedsDaily) {
    const requestId = `req_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const primaryRecipient = inspection.detectedRecipients[0] ?? policy.agentId;

    const payload: ApprovalPayload = {
      requestId,
      agentId: policy.agentId,
      policyVersion: policy.version,
      actionType: 'transfer_sol',
      recipient: primaryRecipient,
      amount: inspection.simulatedSolOutflowLamports,
      mint: 'native',
      nonce: randomNonce(),
      expiresAt: new Date(Date.now() + ctx.config.APPROVAL_TTL_SECONDS * 1000).toISOString(),
    };

    const request: PaymentRequest = {
      id: requestId,
      agentId: policy.agentId,
      createdAt: now,
      updatedAt: now,
      status: 'pending_approval',
      prompt: `[solana_action] ${inspection.actionMetadata.title} (${actionUrl})`,
      idempotencyKey: `action:${actionUrl}:${payload.nonce}`,
      intent: null,
      plan: {
        action: {
          type: 'transfer_sol',
          recipient: primaryRecipient,
          amountSol: inspection.simulatedSolOutflowLamports / 1e9,
          memo: `action:${inspection.actionMetadata.title.slice(0, 50)}`,
        },
        rationale: `Solana Action: ${inspection.actionMetadata.title}`,
        confidence: 1,
      },
      decision: {
        verdict: 'require_approval',
        policyVersion: policy.version,
        reasons: [exceedsTx ? 'amount exceeds single-tx limit' : 'amount exceeds 24-hour limit'],
        resolved: {
          type: 'transfer_sol',
          recipient: primaryRecipient,
          recipientLabel: primaryRecipient,
          lamports: inspection.simulatedSolOutflowLamports,
        },
      },
      modelTrace: null,
      approval: {
        payload,
        message: buildApprovalMessage(payload),
        signature: null,
        signerPubkey: null,
        signedAt: null,
        consumedAt: null,
      },
      execution: null,
      balanceLamports: null,
      error: null,
    };

    ctx.store.putRequest(request);
    ctx.audit.record('approval.requested', requestId, { payload, actionUrl });

    return {
      status: 'pending_approval',
      code: 'ACTION_APPROVAL_REQUIRED',
      message: 'Solana Action payment exceeds policy limit and requires owner approval in dashboard.',
      remediation: AGENT_ERROR_REMEDIATION.PENDING_APPROVAL_REQUIRED,
      approvalUrl: `${dashboardUrl}/#requests`,
      requestId,
      actionMetadata: inspection.actionMetadata,
      solOutflowLamports: inspection.simulatedSolOutflowLamports,
    };
  }

  // Auto-approved path: sign and send transaction
  const decoded = decodeTransaction(inspection.transactionBase64);
  let signature: string;

  if (decoded.versioned) {
    decoded.versioned.sign([ctx.signer]);
    signature = await ctx.connection.sendTransaction(decoded.versioned, {
      maxRetries: 3,
      skipPreflight: true,
    });
  } else {
    decoded.legacy!.sign(ctx.signer);
    signature = await ctx.connection.sendRawTransaction(decoded.legacy!.serialize(), {
      maxRetries: 3,
      skipPreflight: true,
    });
  }

  ctx.audit.record('action.executed', signature, {
    actionUrl,
    title: inspection.actionMetadata.title,
    solOutflowLamports: inspection.simulatedSolOutflowLamports,
  });

  return {
    status: 'completed',
    signature,
    actionMetadata: inspection.actionMetadata,
    solOutflowLamports: inspection.simulatedSolOutflowLamports,
  };
}
