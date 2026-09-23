import {
  ActionPlanSchema,
  IntentEnvelopeSchema,
  lamportsToSol,
  type ActionPlan,
  type IntentEnvelope,
  type ModelContext,
} from '@nexus/shared';

const AMOUNT_RE = /(?<![\p{L}\p{N}_-])(\d+(?:[.,]\d+)?)(?:\s*(sol|lamports?|token[s]?))?(?![\p{L}\p{N}_-])/iu;
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

/** Upper bound mirrors the ActionPlan schema, so the parser cannot emit a value the schema rejects. */
const MAX_PARSED_AMOUNT = 1_000_000;

function parseAmount(text: string): { amount: number; unit: string } | null {
  const match = AMOUNT_RE.exec(text);
  if (!match?.[1]) return null;
  const amount = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PARSED_AMOUNT) return null;
  return { amount, unit: (match[2] ?? 'sol').toLowerCase() };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a configured label as a complete token, not as a substring of another word. */
function containsLabel(text: string, label: string): boolean {
  const escaped = escapeRegExp(label.trim());
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'iu').test(text);
}

function parseRecipient(text: string, ctx: ModelContext): string | undefined {
  const address = BASE58_RE.exec(text)?.[0];
  if (address) return address;
  const label = ctx.recipients.find((r) => containsLabel(text, r.label));
  if (label) return label.label;
  const named = /\b(?:to|for|tới|đến|cho)\s+([\w-]{2,32})/i.exec(text)?.[1];
  return named;
}

/**
 * Deterministic fallback used when no provider key is configured, when a
 * provider call fails, or in tests. It keeps the demo runnable offline and
 * makes the pipeline's behaviour reproducible.
 */
export function mockUnderstand(prompt: string, ctx: ModelContext): IntentEnvelope {
  const text = prompt.trim();
  const lower = text.toLowerCase();

  if (/balance|số dư|so du|how much/.test(lower)) {
    return IntentEnvelopeSchema.parse({
      goal: 'Read the agent wallet balance',
      operation: 'get_balance',
      entities: {},
      riskNotes: [],
      confidence: 0.9,
      requiresHuman: false,
    });
  }

  const amount = parseAmount(text);
  const recipient = parseRecipient(text, ctx);
  const isToken = ctx.mints.some((m) => containsLabel(text, m.label));

  if (!amount || !recipient) {
    return IntentEnvelopeSchema.parse({
      goal: text.slice(0, 200) || 'unclear request',
      operation: 'unknown',
      entities: {
        ...(recipient ? { recipient } : {}),
        ...(amount ? { amount: amount.amount } : {}),
      },
      riskNotes: ['mock parser could not extract both an amount and a recipient'],
      confidence: 0.2,
      requiresHuman: true,
    });
  }

  const asset = isToken
    ? (ctx.mints.find((m) => containsLabel(text, m.label))?.label ?? 'token')
    : 'SOL';
  const normalised = amount.unit.startsWith('lamport')
    ? lamportsToSol(amount.amount)
    : amount.amount;

  return IntentEnvelopeSchema.parse({
    goal: `Send ${normalised} ${asset} to ${recipient}`,
    operation: isToken ? 'transfer_spl' : 'transfer_sol',
    entities: { recipient, amount: normalised, asset },
    riskNotes:
      normalised > lamportsToSol(ctx.maxSolPerTx) && !isToken
        ? ['amount looks larger than the configured per-transaction limit']
        : [],
    confidence: 0.75,
    requiresHuman: false,
  });
}

export function mockPlan(intent: IntentEnvelope, ctx: ModelContext): ActionPlan {
  const { recipient, amount, asset } = intent.entities;

  if (intent.operation === 'get_balance') {
    return ActionPlanSchema.parse({
      action: { type: 'get_balance' },
      rationale: 'read-only balance lookup',
      confidence: 0.9,
    });
  }

  const usableAmount = typeof amount === 'number' && amount > 0 && amount <= MAX_PARSED_AMOUNT;

  if (intent.operation === 'transfer_sol' && recipient && amount && usableAmount) {
    return ActionPlanSchema.parse({
      action: { type: 'transfer_sol', recipient, amountSol: amount },
      rationale: 'user asked for a SOL transfer',
      confidence: 0.8,
    });
  }

  if (intent.operation === 'transfer_spl' && recipient && amount && usableAmount) {
    const mint = ctx.mints.find((m) => m.label.toLowerCase() === (asset ?? '').toLowerCase());
    return ActionPlanSchema.parse({
      action: {
        type: 'transfer_spl',
        recipient,
        mint: mint?.label ?? asset ?? 'unknown',
        amount,
      },
      rationale: 'user asked for an SPL token transfer',
      confidence: 0.7,
    });
  }

  return ActionPlanSchema.parse({
    action: {
      type: 'request_manual_approval',
      reason: intent.riskNotes[0] ?? 'intent could not be turned into a concrete action',
    },
    rationale: 'not enough information for an automatic action',
    confidence: 0.3,
  });
}
