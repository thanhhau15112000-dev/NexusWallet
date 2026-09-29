import { describe, expect, it } from 'vitest';
import {
  defaultPolicy,
  evaluatePolicy,
  formatSol,
  PolicySchema,
  solToLamports,
  spentLamportsInWindow,
  type ModelAction,
  type PaymentRequest,
  type Policy,
} from '@nexus/shared';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OUTSIDER = '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM';
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [{ label: 'usdc', address: MINT }],
    maxTokenAmountByMint: { [MINT]: 10 },
    ...overrides,
  };
}

const transfer = (recipient: string, amountSol: number): ModelAction => ({
  type: 'transfer_sol',
  recipient,
  amountSol,
});

describe('evaluatePolicy - SOL', () => {
  it('allows a transfer under the per-transaction limit', () => {
    const decision = evaluatePolicy(policy(), transfer(TREASURY, 0.05));
    expect(decision.verdict).toBe('allow');
    expect(decision.resolved).toMatchObject({ recipient: TREASURY, lamports: 50_000_000 });
  });

  it('allows a transfer exactly at the limit', () => {
    expect(evaluatePolicy(policy(), transfer(TREASURY, 0.1)).verdict).toBe('allow');
  });

  it('escalates a transfer one lamport over the limit', () => {
    const decision = evaluatePolicy(policy(), transfer(TREASURY, 0.100000001));
    expect(decision.verdict).toBe('require_approval');
    expect(decision.limit).toMatchObject({ limit: 100_000_000, requested: 100_000_001 });
    expect(decision.reasons).toEqual(['amount 0.100000001 SOL exceeds the per-transaction limit of 0.1 SOL']);
    expect(formatSol(100_000_001)).toBe('0.100000001 SOL');
    // The action still resolves, so the approval can be bound to concrete values.
    expect(decision.resolved).not.toBeNull();
  });

  it('states limits in SOL and keeps integer lamports in details', () => {
    const decision = evaluatePolicy(policy(), transfer(TREASURY, 0.5));
    expect(decision.reasons).toEqual(['amount 0.5 SOL exceeds the per-transaction limit of 0.1 SOL']);
    expect(decision.details).toEqual({
      requestedSol: 0.5,
      requestedLamports: 500_000_000,
      limitSol: 0.1,
      limitLamports: 100_000_000,
    });
    expect(evaluatePolicy(policy(), transfer(TREASURY, 0.05)).reasons.join(' ')).not.toMatch(/lamports/);
  });

  it('escalates a transfer far over the limit', () => {
    expect(evaluatePolicy(policy(), transfer(TREASURY, 0.5)).verdict).toBe('require_approval');
  });

  it('denies an unknown recipient outright, even under the limit', () => {
    const decision = evaluatePolicy(policy(), transfer(OUTSIDER, 0.001));
    expect(decision.verdict).toBe('deny');
    expect(decision.resolved).toBeNull();
  });

  it('denies an unknown recipient before considering the amount', () => {
    // A large transfer to a stranger must not become an approvable request.
    const decision = evaluatePolicy(policy(), transfer(OUTSIDER, 999));
    expect(decision.verdict).toBe('deny');
  });

  it('resolves an allowlist label to its address', () => {
    const decision = evaluatePolicy(policy(), transfer('Treasury', 0.01));
    expect(decision.verdict).toBe('allow');
    expect(decision.resolved).toMatchObject({ recipient: TREASURY, recipientLabel: 'treasury' });
  });

  it('denies a zero amount', () => {
    expect(evaluatePolicy(policy(), transfer(TREASURY, 0.0000000001)).verdict).toBe('deny');
  });

  it('denies a negative SOL amount', () => {
    expect(evaluatePolicy(policy(), transfer(TREASURY, -0.05)).verdict).toBe('deny');
  });

  it('denies a non-finite SOL amount', () => {
    expect(evaluatePolicy(policy(), transfer(TREASURY, Number.NaN)).verdict).toBe('deny');
  });

  it('denies every transfer when the allowlist is empty', () => {
    const empty = policy({ allowedRecipients: [] });
    expect(evaluatePolicy(empty, transfer(TREASURY, 0.001)).verdict).toBe('deny');
  });

  it('escalates everything when the limit is zero', () => {
    const locked = policy({ maxSolLamportsPerTx: 0 });
    expect(evaluatePolicy(locked, transfer(TREASURY, 0.000000001)).verdict).toBe('require_approval');
  });
});

describe('evaluatePolicy - SPL', () => {
  const splAction = (mint: string, amount: number): ModelAction => ({
    type: 'transfer_spl',
    recipient: TREASURY,
    mint,
    amount,
  });

  it('allows an allowlisted mint under its cap', () => {
    expect(evaluatePolicy(policy(), splAction('usdc', 5)).verdict).toBe('allow');
  });

  it('escalates an allowlisted mint over its cap', () => {
    expect(evaluatePolicy(policy(), splAction(MINT, 50)).verdict).toBe('require_approval');
  });

  it('denies a mint that is not allowlisted', () => {
    expect(evaluatePolicy(policy(), splAction(OUTSIDER, 1)).verdict).toBe('deny');
  });

  it('escalates when a mint is allowlisted but has no cap configured', () => {
    const noCap = policy({ maxTokenAmountByMint: {} });
    expect(evaluatePolicy(noCap, splAction(MINT, 0.5)).verdict).toBe('require_approval');
  });

  it('denies a zero SPL amount', () => {
    expect(evaluatePolicy(policy(), splAction('usdc', 0)).verdict).toBe('deny');
  });

  it('denies a negative SPL amount', () => {
    expect(evaluatePolicy(policy(), splAction('usdc', -10)).verdict).toBe('deny');
  });

  it('denies a non-finite SPL amount', () => {
    expect(evaluatePolicy(policy(), splAction('usdc', Number.NaN)).verdict).toBe('deny');
  });
});

describe('evaluatePolicy - non-transfer actions', () => {
  it('allows a balance read', () => {
    expect(evaluatePolicy(policy(), { type: 'get_balance' }).verdict).toBe('allow');
  });

  it('denies request_manual_approval since it carries no executable action', () => {
    const decision = evaluatePolicy(policy(), {
      type: 'request_manual_approval',
      reason: 'ambiguous',
    });
    expect(decision.verdict).toBe('deny');
    expect(decision.resolved).toBeNull();
  });
});

describe('PolicySchema - allowlist integrity', () => {
  it('rejects duplicate labels case-insensitively', () => {
    expect(() =>
      PolicySchema.parse({
        ...policy(),
        allowedRecipients: [
          { label: 'Treasury', address: TREASURY },
          { label: 'treasury', address: OUTSIDER },
        ],
      }),
    ).toThrow(/duplicate label/i);
  });

  it('rejects duplicate allowlist addresses', () => {
    expect(() =>
      PolicySchema.parse({
        ...policy(),
        allowedRecipients: [
          { label: 'treasury-a', address: TREASURY },
          { label: 'treasury-b', address: TREASURY },
        ],
      }),
    ).toThrow(/duplicate address/i);
  });
});

describe('formatSol', () => {
  it('prints exact decimals without float artifacts', () => {
    expect(formatSol(100_000_001)).toBe('0.100000001 SOL');
    expect(formatSol(100_000_000)).toBe('0.1 SOL');
    expect(formatSol(2_000_000_000)).toBe('2 SOL');
    expect(formatSol(0)).toBe('0 SOL');
    expect(formatSol(1)).toBe('0.000000001 SOL');
  });
});

describe('evaluatePolicy - daily cap', () => {
  const capPolicy = (dailyCapSol: number | null = 0.2, perTxSol = 0.5) =>
    policy({
      maxSolLamportsPerTx: solToLamports(perTxSol),
      maxSolLamportsPerDay: dailyCapSol === null ? null : solToLamports(dailyCapSol),
    });

  it('allows a transfer when total spent remains under the daily cap', () => {
    const decision = evaluatePolicy(capPolicy(0.2), transfer(TREASURY, 0.05), {
      spentLamports24h: solToLamports(0.1),
    });
    expect(decision.verdict).toBe('allow');
    expect(decision.resolved).toMatchObject({ lamports: 50_000_000 });
  });

  it('allows a transfer that brings total spent exactly to the daily cap', () => {
    const decision = evaluatePolicy(capPolicy(0.2), transfer(TREASURY, 0.1), {
      spentLamports24h: solToLamports(0.1),
    });
    expect(decision.verdict).toBe('allow');
  });

  it('escalates a transfer that exceeds the daily cap by 1 lamport with DAILY_LIMIT_EXCEEDED', () => {
    const p = capPolicy(0.2); // 200,000,000 lamports
    const decision = evaluatePolicy(p, transfer(TREASURY, 0.050000001), {
      spentLamports24h: 150_000_000,
    });
    expect(decision.verdict).toBe('require_approval');
    expect(decision.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(decision.limit).toMatchObject({ limit: 200_000_000, requested: 50_000_001 });
    expect(decision.reasons[0]).toContain('exceeds the 24-hour limit');
    expect(decision.details).toEqual({
      limitSol: 0.2,
      limitLamports: 200_000_000,
      spentSol: 0.15,
      spentLamports: 150_000_000,
      requestedSol: 0.050000001,
      requestedLamports: 50_000_001,
      remainingSol: 0.05,
      remainingLamports: 50_000_000,
    });
  });

  it('keeps remainingLamports non-negative when spent already exceeds daily cap', () => {
    const p = capPolicy(0.1); // 100M
    const decision = evaluatePolicy(p, transfer(TREASURY, 0.01), {
      spentLamports24h: 150_000_000,
    });
    expect(decision.verdict).toBe('require_approval');
    expect(decision.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(decision.details?.remainingLamports).toBe(0);
    expect(decision.details?.remainingSol).toBe(0);
  });

  it('prioritises per-tx limit over daily limit when an action exceeds both', () => {
    const p = capPolicy(0.2, 0.05); // per-tx: 0.05 SOL, daily: 0.2 SOL
    // requested: 0.08 SOL (> per-tx 0.05), spent: 0.15 SOL (0.15 + 0.08 = 0.23 > daily 0.2)
    const decision = evaluatePolicy(p, transfer(TREASURY, 0.08), {
      spentLamports24h: solToLamports(0.15),
    });
    expect(decision.verdict).toBe('require_approval');
    expect(decision.code).toBe('AMOUNT_EXCEEDS_TRANSACTION_LIMIT');
  });

  it('does not enforce a daily limit when maxSolLamportsPerDay is null', () => {
    const p = capPolicy(null, 1.0);
    const decision = evaluatePolicy(p, transfer(TREASURY, 0.5), {
      spentLamports24h: solToLamports(100),
    });
    expect(decision.verdict).toBe('allow');
  });
});

describe('spentLamportsInWindow', () => {
  const baseReq = (overrides: Partial<PaymentRequest>): PaymentRequest => ({
    id: 'req_test',
    agentId: 'agent-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'confirmed',
    prompt: 'test',
    idempotencyKey: null,
    intent: null,
    plan: null,
    decision: {
      verdict: 'allow',
      policyVersion: 1,
      reasons: [],
      resolved: {
        type: 'transfer_sol',
        recipient: TREASURY,
        recipientLabel: 'treasury',
        lamports: 10_000_000,
      },
    },
    modelTrace: null,
    approval: null,
    execution: null,
    balanceLamports: null,
    error: null,
    ...overrides,
  });

  it('counts auto_approved, approved, confirmed, and execution_failed failed requests within window', () => {
    const now = Date.now();
    const reqs: PaymentRequest[] = [
      baseReq({ id: '1', status: 'auto_approved', createdAt: new Date(now - 1_000).toISOString() }),
      baseReq({ id: '2', status: 'approved', createdAt: new Date(now - 10_000).toISOString() }),
      baseReq({ id: '3', status: 'confirmed', createdAt: new Date(now - 30_000).toISOString() }),
      baseReq({
        id: '4',
        status: 'failed',
        error: { code: 'execution_failed', message: 'rpc error' },
        createdAt: new Date(now - 60_000).toISOString(),
      }),
    ];
    expect(spentLamportsInWindow(reqs, now)).toBe(40_000_000);
  });

  it('ignores requests with uncounted statuses or pre-flight failures', () => {
    const now = Date.now();
    const reqs: PaymentRequest[] = [
      baseReq({ id: '1', status: 'denied', createdAt: new Date(now - 1_000).toISOString() }),
      baseReq({ id: '2', status: 'pending_approval', createdAt: new Date(now - 2_000).toISOString() }),
      baseReq({ id: '3', status: 'expired', createdAt: new Date(now - 3_000).toISOString() }),
      baseReq({
        id: '4',
        status: 'failed',
        error: { code: 'INSUFFICIENT_FUNDS_INCLUDING_FEES', message: 'low balance' },
        createdAt: new Date(now - 4_000).toISOString(),
      }),
      baseReq({
        id: '5',
        status: 'failed',
        error: { code: 'model_error', message: 'model crashed' },
        createdAt: new Date(now - 5_000).toISOString(),
      }),
    ];
    expect(spentLamportsInWindow(reqs, now)).toBe(0);
  });

  it('ignores requests outside the 24h sliding window', () => {
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    const reqs: PaymentRequest[] = [
      baseReq({ id: '1', status: 'confirmed', createdAt: new Date(now - windowMs - 1_000).toISOString() }),
      baseReq({ id: '2', status: 'confirmed', createdAt: new Date(now - windowMs + 1_000).toISOString() }),
    ];
    expect(spentLamportsInWindow(reqs, now)).toBe(10_000_000);
  });

  it('ignores get_balance and transfer_spl actions', () => {
    const now = Date.now();
    const reqs: PaymentRequest[] = [
      baseReq({
        id: '1',
        status: 'confirmed',
        decision: {
          verdict: 'allow',
          policyVersion: 1,
          reasons: [],
          resolved: { type: 'get_balance' },
        },
      }),
      baseReq({
        id: '2',
        status: 'confirmed',
        decision: {
          verdict: 'allow',
          policyVersion: 1,
          reasons: [],
          resolved: {
            type: 'transfer_spl',
            recipient: TREASURY,
            recipientLabel: 'treasury',
            mint: MINT,
            mintLabel: 'usdc',
            amount: 5,
          },
        },
      }),
    ];
    expect(spentLamportsInWindow(reqs, now)).toBe(0);
  });
});

describe('PolicySchema - backwards compatibility', () => {
  it('defaults maxSolLamportsPerDay to null when omitted in older state files', () => {
    const rawOldPolicy = {
      version: 1,
      agentId: 'agent-old',
      maxSolLamportsPerTx: 100_000_000,
      allowedRecipients: [],
      allowedMints: [],
      maxTokenAmountByMint: {},
      updatedAt: new Date().toISOString(),
    };
    const parsed = PolicySchema.parse(rawOldPolicy);
    expect(parsed.maxSolLamportsPerDay).toBeNull();
  });

  it('defaultPolicy initializes maxSolLamportsPerDay as null', () => {
    const p = defaultPolicy('agent-new');
    expect(p.maxSolLamportsPerDay).toBeNull();
  });
});
