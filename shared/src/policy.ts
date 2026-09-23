/**
 * The policy engine: the only component that may authorise a signature.
 *
 * Pure and synchronous - the same policy and the same action always produce the
 * same verdict, which is what makes it testable and auditable.
 */
import { z } from 'zod';
import { PubkeySchema, solToLamports, type ModelAction, type ResolvedAction } from './contract.js';

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

export type PolicyDecision = {
  verdict: PolicyVerdict;
  policyVersion: number;
  reasons: string[];
  /** Present when the action resolved to something executable. */
  resolved: ResolvedAction | null;
  limit?: { limit: number; requested: number; unit: 'lamports' | 'token' };
};

function findEntry(entries: AllowlistEntry[], value: string): AllowlistEntry | undefined {
  const needle = value.trim();
  const lower = needle.toLowerCase();
  return entries.find((e) => e.address === needle || e.label.toLowerCase() === lower);
}

/**
 * Ordering matters: an allowlist violation is a DENY and is checked before the
 * amount ceiling, so "large transfer to an unknown address" is refused outright
 * instead of being escalated to the owner for approval.
 */
export function evaluatePolicy(policy: Policy, action: ModelAction): PolicyDecision {
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
    };
  }

  const recipient = findEntry(policy.allowedRecipients, action.recipient);
  if (!recipient) {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: [`recipient "${action.recipient}" is not on the allowlist`],
      resolved: null,
    };
  }

  if (action.type === 'transfer_sol') {
    let lamports: number;
    try {
      lamports = solToLamports(action.amountSol);
    } catch {
      return { verdict: 'deny', policyVersion: version, reasons: ['invalid SOL amount'], resolved: null };
    }
    if (lamports <= 0) {
      return {
        verdict: 'deny',
        policyVersion: version,
        reasons: ['amount must be greater than zero'],
        resolved: null,
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
          `amount ${lamports} lamports exceeds the per-transaction limit of ${policy.maxSolLamportsPerTx} lamports`,
        ],
        resolved,
        limit: { limit: policy.maxSolLamportsPerTx, requested: lamports, unit: 'lamports' },
      };
    }

    return {
      verdict: 'allow',
      policyVersion: version,
      reasons: [
        `recipient "${recipient.label}" allowlisted`,
        `amount within the ${policy.maxSolLamportsPerTx} lamports per-transaction limit`,
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
    };
  }

  if (!Number.isFinite(action.amount) || action.amount <= 0) {
    return {
      verdict: 'deny',
      policyVersion: version,
      reasons: ['amount must be greater than zero'],
      resolved: null,
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
    allowedRecipients: [],
    allowedMints: [],
    maxTokenAmountByMint: {},
    updatedAt: new Date().toISOString(),
  };
}
