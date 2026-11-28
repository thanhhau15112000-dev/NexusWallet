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
    /** 24-hour sliding-window ceiling per mint, in human token units. A mint without an entry has no daily limit. */
    maxTokenAmountPerDayByMint: z.record(z.string(), z.number().nonnegative()).default({}),
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
    'The owner must approve this transfer in the nexusPay dashboard, or wait until the 24-hour limit has remaining capacity (see details.remainingSol, or details.remainingAmount for a token). Do not split it into smaller transfers to stay under the limit.',
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

function windowFilter(now: number | string | Date, windowMs: number): (req: PaymentRequest) => boolean {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const cutoff = nowMs - windowMs;
  return (req) => {
    const createdAtMs = new Date(req.createdAt).getTime();
    return !Number.isNaN(createdAtMs) && createdAtMs >= cutoff && createdAtMs <= nowMs;
  };
}

export function spentLamportsInWindow(
  requests: readonly PaymentRequest[],
  now: number | string | Date = Date.now(),
  windowMs: number = DEFAULT_DAILY_WINDOW_MS,
): number {
  const inWindow = windowFilter(now, windowMs);
  let spent = 0;
  for (const req of requests) {
    if (inWindow(req) && isCountedSolSpend(req) && req.decision?.resolved?.type === 'transfer_sol') {
      spent += req.decision.resolved.lamports;
    }
  }
  return spent;
}

/**
 * Token amounts that count toward each mint's 24-hour limit, keyed by mint address. Sums are exact
 * decimal strings: token amounts are human units, so adding them as floats would drift (0.1 + 0.2).
 */
export function spentTokensInWindow(
  requests: readonly PaymentRequest[],
  now: number | string | Date = Date.now(),
  windowMs: number = DEFAULT_DAILY_WINDOW_MS,
): Record<string, string> {
  const inWindow = windowFilter(now, windowMs);
  const amounts = new Map<string, Array<number | string>>();
  for (const req of requests) {
    const resolved = req.decision?.resolved;
    if (inWindow(req) && mayHaveMovedFunds(req) && resolved?.type === 'transfer_spl') {
      amounts.set(resolved.mint, [...(amounts.get(resolved.mint) ?? []), resolved.amount]);
    }
  }
  return Object.fromEntries([...amounts].map(([mint, values]) => [mint, decimalSum(values)]));
}

type Decimal = { digits: bigint; scale: number };

/** A number or decimal string as digits x 10^-scale. `String(number)` is the shortest round-trip form, so this is exact. */
function parseDecimal(value: number | string): Decimal {
  const [mantissa = '0', exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole = '0', fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const digits = BigInt(whole + fraction);
  return scale >= 0 ? { digits, scale } : { digits: digits * 10n ** BigInt(-scale), scale: 0 };
}

/** Values as integers on one common scale, so they add and compare exactly. */
function toCommonScale(values: Array<number | string>): { units: bigint[]; scale: number } {
  const parsed = values.map(parseDecimal);
  const scale = Math.max(0, ...parsed.map((d) => d.scale));
  return { units: parsed.map((d) => d.digits * 10n ** BigInt(scale - d.scale)), scale };
}

function formatDecimal(units: bigint, scale: number): string {
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** What is left of a token daily limit after `spent` (an exact decimal string from `spentTokensInWindow`), never below 0. */
export function remainingTokenAmount(limit: number, spent: string): number {
  const {
    units: [limitUnits = 0n, spentUnits = 0n],
    scale,
  } = toCommonScale([limit, spent]);
  return Number(formatDecimal(limitUnits > spentUnits ? limitUnits - spentUnits : 0n, scale));
}

function decimalSum(values: Array<number | string>): string {
  const { units, scale } = toCommonScale(values);
  return formatDecimal(units.reduce((a, b) => a + b, 0n), scale);
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
  usage?: { spentLamports24h: number; spentTokens24h?: Record<string, string> },
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

  const dailyCap = policy.maxTokenAmountPerDayByMint[mint.address];
  if (dailyCap !== undefined) {
    const spent = usage?.spentTokens24h?.[mint.address] ?? '0';
    const {
      units: [spentUnits = 0n, requestedUnits = 0n, capUnits = 0n],
      scale,
    } = toCommonScale([spent, action.amount, dailyCap]);
    if (spentUnits + requestedUnits > capUnits) {
      const spentAmount = Number(formatDecimal(spentUnits, scale));
      const remainingAmount = remainingTokenAmount(dailyCap, spent);
      return {
        verdict: 'require_approval',
        policyVersion: version,
        reasons: [
          `amount ${action.amount} exceeds the 24-hour limit for mint ${mint.label} (${spentAmount} spent of ${dailyCap} limit, ${remainingAmount} remaining)`,
        ],
        resolved,
        limit: { limit: dailyCap, requested: action.amount, unit: 'token' },
        code: 'DAILY_LIMIT_EXCEEDED',
        details: {
          mint: mint.address,
          mintLabel: mint.label,
          limitAmount: dailyCap,
          spentAmount,
          requestedAmount: action.amount,
          remainingAmount,
        },
      };
    }
  }

  return {
    verdict: 'allow',
    policyVersion: version,
    reasons: [
      `mint "${mint.label}" allowlisted`,
      `amount within the ${cap} per-transaction limit`,
      ...(dailyCap !== undefined ? [`amount within the ${dailyCap} 24-hour limit`] : []),
    ],
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
    maxTokenAmountPerDayByMint: {},
    updatedAt: new Date().toISOString(),
  };
}
