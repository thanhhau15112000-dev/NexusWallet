import { describe, expect, it } from 'vitest';
import {
  defaultPolicy,
  evaluatePolicy,
  formatSol,
  PolicySchema,
  solToLamports,
  type ModelAction,
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
