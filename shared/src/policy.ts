/**
 * The policy engine: the only component that may authorise a signature.
 *
 * Pure and synchronous - the same policy and the same action always produce the
 * same verdict, which is what makes it testable and auditable.
 */
import { z } from 'zod';
import {
  PubkeySchema,
  formatSol,
  lamportsToSol,
  solToLamports,
  type ModelAction,
  type PaymentRequest,
  type ResolvedAction,
} from './contract.js';

export const AllowlistEntrySchema = z.object({
  label: z.string().trim().min(1).max(32),
  address: PubkeySchema,
});
export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

export const PolicySchema = z
  .object({
    /** Bumped on every write. Approvals are bound to the version that issued them. */
    version: z.number().int().nonnegative(),
    agentId: z.string().trim().min(1).max(64),
    /** Per-transaction ceiling the agent may sign for on its own. */
    maxSolLamportsPerTx: z.number().int().nonnegative(),
    /** Daily ceiling across a 24-hour sliding window. null means unlimited. */
    maxSolLamportsPerDay: z.number().int().nonnegative().nullable().default(null),
    allowedRecipients: z.array(AllowlistEntrySchema).max(32).default([]),
    allowedMints: z.array(AllowlistEntrySchema).max(16).default([]),
    /** Per-transaction ceiling per mint, in human token units, keyed by mint address. */
    maxTokenAmountByMint: z.record(z.string(), z.number().nonnegative()).default({}),
    updatedAt: z.string().datetime(),
  })
  .superRefine((policy, ctx) => {
    for (const [field, entries] of [
      ['allowedRecipients', policy.allowedRecipients],
      ['allowedMints', policy.allowedMints],
    ] as const) {
      const labels = new Map<string, number>();
      const addresses = new Map<string, number>();
      entries.forEach((entry, index) => {
        const label = entry.label.toLowerCase();
        const previousLabel = labels.get(label);
        if (previousLabel !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, 'label'],
            message: `duplicate label; already declared at index ${previousLabel}`,
          });
        } else {
          labels.set(label, index);
        }

        const previousAddress = addresses.get(entry.address);
        if (previousAddress !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, index, 'address'],
            message: `duplicate address; already declared at index ${previousAddress}`,
          });
        } else {
          addresses.set(entry.address, index);
        }
      });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;

export type PolicyVerdict = 'allow' | 'require_approval' | 'deny';

/** Machine-readable codes an agent can branch on. The display strings in `reasons` are derived from the same values. */
export type AgentErrorCode =
  | 'RECIPIENT_NOT_IN_ALLOWLIST'
  | 'MINT_NOT_IN_ALLOWLIST'
  | 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'INVALID_AMOUNT'
  | 'NO_EXECUTABLE_ACTION'
  | 'MODEL_PLAN_MISMATCH'
  | 'INSUFFICIENT_FUNDS_INCLUDING_FEES'
  | 'PENDING_APPROVAL_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AGENT_FROZEN'
  | 'RATE_LIMITED';

export const AGENT_ERROR_REMEDIATION: Record<AgentErrorCode, string> = {
  RECIPIENT_NOT_IN_ALLOWLIST:
    'Use a label or address from details.allowedRecipients. Only the owner can add recipients, in the nexusPay dashboard.',
  MINT_NOT_IN_ALLOWLIST:
    'Use a label or address from details.allowedMints. Only the owner can add mints, in the nexusPay dashboard.',
  AMOUNT_EXCEEDS_TRANSACTION_LIMIT:
    'The owner must approve this transfer in the nexusPay dashboard. Do not split it into smaller transfers to stay under the limit.',
  DAILY_LIMIT_EXCEEDED:
    'The owner must approve this transfer in the nexusPay dashboard, or wait until the 24-hour limit has remaining capacity (see details.remainingSol). Do not split it into smaller transfers to stay under the limit.',
  INVALID_AMOUNT: 'Send a positive amount. SOL amounts must be at least 0.000000001 SOL.',
  NO_EXECUTABLE_ACTION: 'Ask for a transfer or a balance check with an explicit recipient and amount.',
  MODEL_PLAN_MISMATCH: 'Restate the command with an explicit recipient label and amount.',
  INSUFFICIENT_FUNDS_INCLUDING_FEES:
    'The agent wallet cannot cover the amount plus the fee reserve. Ask the owner to top up the agent wallet, or send at most details.maxSendableSol.',
  PENDING_APPROVAL_REQUIRED:
    'Wait for the owner to approve at approval.dashboardUrl. Poll nexuspay_get_request every approval.pollIntervalMs until the status changes or approval.expiresAt passes. Do not resubmit or split the transfer.',
  IDEMPOTENCY_CONFLICT:
    'This idempotencyKey was already used for a different transfer. Omit idempotencyKey for a new transfer; reuse a key only to retry the identical transfer.',
  AGENT_FROZEN:
    'The owner has frozen this agent. Do not retry or change parameters; ask the owner to unfreeze the agent in the nexusPay dashboard.',
  RATE_LIMITED:
    'Too many requests. Wait details.retryAfterSeconds seconds, then retry. To retry a transfer, reuse the same idempotencyKey; do not change the amount.',
};

export type PolicyDecision = {
  verdict: PolicyVerdict;
  policyVersion: number;
  reasons: string[];
  /** Present when the action resolved to something executable. */
  resolved: ResolvedAction | null;
  limit?: { limit: number; requested: number; unit: 'lamports' | 'token' };
  /** Set for deny and require_approval verdicts. Absent on decisions stored before codes existed. */
  code?: AgentErrorCode;
  details?: Record<string, unknown>;
};

function publicEntries(entries: AllowlistEntry[]): AllowlistEntry[] {
  return entries.map(({ label, address }) => ({ label, address }));
}

function findEntry(entries: AllowlistEntry[], value: string): AllowlistEntry | undefined {
  const needle = value.trim();
  const lower = needle.toLowerCase();
  return entries.find((e) => e.address === needle || e.label.toLowerCase() === lower);
}

export const DEFAULT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function spentLamportsInWindow(
  requests: readonly PaymentRequest[],
  now: number | string | Date = Date.now(),
  windowMs: number = DEFAULT_DAILY_WINDOW_MS,
): number {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const cutoff = nowMs - windowMs;
  let spent = 0;

  for (const req of requests) {
    const createdAtMs = new Date(req.createdAt).getTime();
    if (Number.isNaN(createdAtMs) || createdAtMs < cutoff || createdAtMs > nowMs) {
      continue;
    }
    if (isCountedSolSpend(req) && req.decision?.resolved?.type === 'transfer_sol') {
      spent += req.decision.resolved.lamports;
    }
  }

  return spent;
}

/**
 * A SOL or SPL transfer that moved, or may have moved, money: it reached the signer and either
 * confirmed or failed during execution (outcome unknown). The store keeps these for the whole
 * 24-hour window so retries keep their idempotency key; see `Store.prune` in the agent.
 */
export function mayHaveMovedFunds(req: PaymentRequest): boolean {
  const reachedSigner =
    req.status === 'auto_approved' ||
    req.status === 'approved' ||
    req.status === 'confirmed' ||
    (req.status === 'failed' && req.error?.code === 'execution_failed');
  const type = req.decision?.resolved?.type;
  return reachedSigner && (type === 'transfer_sol' || type === 'transfer_spl');
}

/** The SOL subset of `mayHaveMovedFunds`: what counts toward the 24-hour SOL limit. */
export function isCountedSolSpend(req: PaymentRequest): boolean {
  return mayHaveMovedFunds(req) && req.decision?.resolved?.type === 'transfer_sol';
}

/**
 * Ordering matters: an allowlist violation is a DENY and is checked before the
 * amount ceiling, so "large transfer to an unknown address" is refused outright
 * instead of being escalated to the owner for approval.
 */
export function evaluatePolicy(
  policy: Policy,
  action: ModelAction,
  usage?: { spentLamports24h: number },
): PolicyDecision {
  const version = policy.version;

  if (action.type === 'get_balance') {
    return {
      verdict: 'allow',
      policyVersion: version,
      reasons: ['read-only action'],
      resolved: { type: 'get_balance' },
    };
  }

  if (action.type === 'request_manual_approval') {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: [`no executable action: ${action.reason}`],
      resolved: null,
      code: 'NO_EXECUTABLE_ACTION',
      details: {},
    };
  }

  const recipient = findEntry(policy.allowedRecipients, action.recipient);
  if (!recipient) {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: [`recipient "${action.recipient}" is not on the allowlist`],
      resolved: null,
      code: 'RECIPIENT_NOT_IN_ALLOWLIST',
      details: { recipient: action.recipient, allowedRecipients: publicEntries(policy.allowedRecipients) },
    };
  }

  if (action.type === 'transfer_sol') {
    let lamports: number;
    try {
      lamports = solToLamports(action.amountSol);
    } catch {
      return {
        verdict: 'deny',
        policyVersion: version,
        reasons: ['invalid SOL amount'],
        resolved: null,
        code: 'INVALID_AMOUNT',
        details: { amountSol: action.amountSol },
      };
    }
    if (lamports <= 0) {
      return {
        verdict: 'deny',
        policyVersion: version,
        reasons: ['amount must be greater than zero'],
        resolved: null,
        code: 'INVALID_AMOUNT',
        details: { amountSol: action.amountSol },
      };
    }

    const resolved: ResolvedAction = {
      type: 'transfer_sol',
      recipient: recipient.address,
      recipientLabel: recipient.label,
      lamports,
      ...(action.memo ? { memo: action.memo } : {}),
    };

    if (lamports > policy.maxSolLamportsPerTx) {
      return {
        verdict: 'require_approval',
        policyVersion: version,
        reasons: [
          `amount ${formatSol(lamports)} exceeds the per-transaction limit of ${formatSol(policy.maxSolLamportsPerTx)}`,
        ],
        resolved,
        limit: { limit: policy.maxSolLamportsPerTx, requested: lamports, unit: 'lamports' },
        code: 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT',
        details: {
          requestedSol: lamportsToSol(lamports),
          requestedLamports: lamports,
          limitSol: lamportsToSol(policy.maxSolLamportsPerTx),
          limitLamports: policy.maxSolLamportsPerTx,
        },
      };
    }

    const spentLamports = usage?.spentLamports24h ?? 0;
    if (policy.maxSolLamportsPerDay !== null && spentLamports + lamports > policy.maxSolLamportsPerDay) {
      const remainingLamports = Math.max(0, policy.maxSolLamportsPerDay - spentLamports);
      return {
        verdict: 'require_approval',
        policyVersion: version,
        reasons: [
          `amount ${formatSol(lamports)} exceeds the 24-hour limit (${formatSol(spentLamports)} spent of ${formatSol(policy.maxSolLamportsPerDay)} limit, ${formatSol(remainingLamports)} remaining)`,
        ],
        resolved,
        limit: { limit: policy.maxSolLamportsPerDay, requested: lamports, unit: 'lamports' },
        code: 'DAILY_LIMIT_EXCEEDED',
        details: {
          limitSol: lamportsToSol(policy.maxSolLamportsPerDay),
          limitLamports: policy.maxSolLamportsPerDay,
          spentSol: lamportsToSol(spentLamports),
          spentLamports,
          requestedSol: lamportsToSol(lamports),
          requestedLamports: lamports,
          remainingSol: lamportsToSol(remainingLamports),
          remainingLamports,
        },
      };
    }

    return {
      verdict: 'allow',
      policyVersion: version,
      reasons: [
        `recipient "${recipient.label}" allowlisted`,
        `amount within the ${formatSol(policy.maxSolLamportsPerTx)} per-transaction limit`,
      ],
      resolved,
    };
  }

  const mint = findEntry(policy.allowedMints, action.mint);
  if (!mint) {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: [`mint "${action.mint}" is not on the allowlist`],
      resolved: null,
      code: 'MINT_NOT_IN_ALLOWLIST',
      details: { mint: action.mint, allowedMints: publicEntries(policy.allowedMints) },
    };
  }

  if (!Number.isFinite(action.amount) || action.amount <= 0) {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: ['amount must be greater than zero'],
      resolved: null,
      code: 'INVALID_AMOUNT',
      details: { amount: action.amount },
    };
  }

  const resolved: ResolvedAction = {
    type: 'transfer_spl',
    recipient: recipient.address,
    recipientLabel: recipient.label,
    mint: mint.address,
    mintLabel: mint.label,
    amount: action.amount,
    ...(action.memo ? { memo: action.memo } : {}),
  };

  const cap = policy.maxTokenAmountByMint[mint.address] ?? 0;
  if (action.amount > cap) {
    return {
      verdict: 'require_approval',
      policyVersion: version,
      reasons: [`amount ${action.amount} exceeds the per-transaction limit of ${cap} for mint ${mint.label}`],
      resolved,
      limit: { limit: cap, requested: action.amount, unit: 'token' },
      code: 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT',
      details: { mint: mint.address, mintLabel: mint.label, requestedAmount: action.amount, limitAmount: cap },
    };
  }

  return {
    verdict: 'allow',
    policyVersion: version,
    reasons: [`mint "${mint.label}" allowlisted`, `amount within the ${cap} per-transaction limit`],
    resolved,
  };
}

export function defaultPolicy(agentId: string): Policy {
  return {
    version: 1,
    agentId,
    maxSolLamportsPerTx: solToLamports(0.1),
    maxSolLamportsPerDay: null,
    allowedRecipients: [],
    allowedMints: [],
    maxTokenAmountByMint: {},
    updatedAt: new Date().toISOString(),
  };
}
