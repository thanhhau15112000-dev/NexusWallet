import { describe, expect, it } from 'vitest';
import {
  defaultPolicy,
  evaluatePolicy,
  remainingTokenAmount,
  spentTokensInWindow,
  type ModelAction,
  type PaymentRequest,
  type Policy,
} from '@nexus/shared';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const USDC = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const OTHER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    ...defaultPolicy('agent-001'),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [
      { label: 'usdc', address: USDC },
      { label: 'other', address: OTHER },
    ],
    maxTokenAmountByMint: { [USDC]: 10, [OTHER]: 10 },
    maxTokenAmountPerDayByMint: { [USDC]: 0.3 },
    ...overrides,
  };
}

const pay = (amount: number, mint = 'usdc'): ModelAction => ({ type: 'transfer_spl', recipient: TREASURY, mint, amount });

function request(
  id: string,
  amount: number,
  overrides: Partial<PaymentRequest> = {},
  mint = USDC,
): PaymentRequest {
  const now = new Date().toISOString();
  return {
    id,
    agentId: 'agent-001',
    createdAt: now,
    updatedAt: now,
    status: 'confirmed',
    prompt: 'test',
    idempotencyKey: null,
    intent: null,
    plan: null,
    decision: {
      verdict: 'allow',
      policyVersion: 1,
      reasons: [],
      resolved: { type: 'transfer_spl', recipient: TREASURY, recipientLabel: 'treasury', mint, mintLabel: 'usdc', amount },
    },
    modelTrace: null,
    approval: null,
    execution: null,
    balanceLamports: null,
    error: null,
    ...overrides,
  };
}

const usage = (requests: PaymentRequest[], now = Date.now()) => ({
  spentLamports24h: 0,
  spentTokens24h: spentTokensInWindow(requests, now),
});

describe('SPL 24-hour limit', () => {
  it('sums exactly, so 0.1 + 0.2 fills a 0.3 limit without going over', () => {
    const spent = usage([request('1', 0.1)]);
    expect(evaluatePolicy(policy(), pay(0.2), spent).verdict).toBe('allow');
    expect(spentTokensInWindow([request('1', 0.1), request('2', 0.2)])[USDC]).toBe('0.3');
  });

  it('requires approval once the limit would be exceeded, with token details', () => {
    const decision = evaluatePolicy(policy(), pay(0.2), usage([request('1', 0.1), request('2', 0.1)]));
    expect(decision.verdict).toBe('require_approval');
    expect(decision.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(decision.details).toMatchObject({
      mint: USDC,
      mintLabel: 'usdc',
      limitAmount: 0.3,
      spentAmount: 0.2,
      requestedAmount: 0.2,
      remainingAmount: 0.1,
    });
  });

  it('checks the per-transaction cap before the daily limit', () => {
    expect(evaluatePolicy(policy(), pay(11), usage([])).code).toBe('AMOUNT_EXCEEDS_TRANSACTION_LIMIT');
  });

  it('has no daily limit for a mint without an entry', () => {
    const spent = usage([request('1', 9, {}, OTHER), request('2', 9, {}, OTHER)]);
    expect(evaluatePolicy(policy(), pay(9, 'other'), spent).verdict).toBe('allow');
  });

  it('a limit of 0 requires approval for every transfer', () => {
    const decision = evaluatePolicy(policy({ maxTokenAmountPerDayByMint: { [USDC]: 0 } }), pay(0.01), usage([]));
    expect(decision.verdict).toBe('require_approval');
  });

  it('counts mints separately', () => {
    const spent = usage([request('1', 5, {}, OTHER)]);
    expect(evaluatePolicy(policy(), pay(0.3), spent).verdict).toBe('allow');
  });

  it('counts transfers that may have moved funds, not denied, cancelled or old ones', () => {
    const now = Date.now();
    const requests = [
      request('auto', 0.01, { status: 'auto_approved' }),
      request('approved', 0.02, { status: 'approved' }),
      request('unknown', 0.04, { status: 'failed', error: { code: 'execution_failed', message: 'rpc timeout' } }),
      request('denied', 1, { status: 'denied' }),
      request('pending', 1, { status: 'pending_approval' }),
      request('rejected', 1, { status: 'failed', error: { code: 'simulation_failed', message: 'x' } }),
      request('old', 1, { createdAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() }),
    ];
    expect(spentTokensInWindow(requests, now)).toEqual({ [USDC]: '0.07' });
  });

  it('does not count SOL transfers toward a token limit', () => {
    const sol: PaymentRequest = {
      ...request('sol', 0),
      decision: {
        verdict: 'allow',
        policyVersion: 1,
        reasons: [],
        resolved: { type: 'transfer_sol', recipient: TREASURY, recipientLabel: 'treasury', lamports: 5_000_000_000 },
      },
    };
    expect(spentTokensInWindow([sol])).toEqual({});
  });

  it('handles amounts that stringify in exponent form', () => {
    expect(spentTokensInWindow([request('1', 1e-7), request('2', 2e-7)])[USDC]).toBe('0.0000003');
    expect(remainingTokenAmount(0.3, '0.1')).toBe(0.2);
    expect(remainingTokenAmount(0.1, '0.3')).toBe(0);
  });
});
