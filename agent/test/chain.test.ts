import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMintMock, getOrCreateAssociatedTokenAccountMock, splTransferMock } = vi.hoisted(() => ({
  getMintMock: vi.fn(),
  getOrCreateAssociatedTokenAccountMock: vi.fn(),
  splTransferMock: vi.fn(),
}));

vi.mock('@solana/spl-token', () => ({
  getMint: getMintMock,
  getOrCreateAssociatedTokenAccount: getOrCreateAssociatedTokenAccountMock,
  transfer: splTransferMock,
}));

import { toBaseUnits, transferSpl, withRpcRetry } from '../src/chain.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toBaseUnits', () => {
  it('converts representable decimal amounts without float drift', () => {
    expect(toBaseUnits(1.23, 2)).toBe(123n);
    expect(toBaseUnits(0.1, 9)).toBe(100_000_000n);
  });

  it('rejects amounts that would be rounded before signing', () => {
    expect(() => toBaseUnits(1.239, 2)).toThrow(/more precision/i);
    expect(() => toBaseUnits(0.000000001, 2)).toThrow(/more precision/i);
  });
});

describe('withRpcRetry', () => {
  it('succeeds immediately on happy path', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRpcRetry(fn, { attempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors (429, 503, timeout, fetch failed) and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce('recovered');

    const result = await withRpcRetry(fn, { attempts: 4, baseDelayMs: 1 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries have an upper bound and throw when exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(withRpcRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      /503 Service Unavailable/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on non-transient error (insufficient funds) without retrying', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error('agent wallet has 0.01 SOL, needs 0.1 SOL including fees'));

    await expect(withRpcRetry(fn, { attempts: 4, baseDelayMs: 1 })).rejects.toThrow(
      /needs 0.1 SOL/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on rejected instruction or invalid signature without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Transaction simulation failed: Error processing Instruction 0'));

    await expect(withRpcRetry(fn, { attempts: 4, baseDelayMs: 1 })).rejects.toThrow(
      /Transaction simulation failed/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('transferSpl submission retry safety', () => {
  it('does not re-submit after an ambiguous timeout', async () => {
    getMintMock.mockResolvedValue({ decimals: 0 });
    getOrCreateAssociatedTokenAccountMock.mockResolvedValue({ address: 'token-account', amount: '10' });
    splTransferMock.mockRejectedValue(new Error('timeout after broadcast'));

    await expect(
      transferSpl({
        connection: {} as never,
        payer: { publicKey: { toBase58: () => '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' } } as never,
        recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        mint: 'So11111111111111111111111111111111111111112',
        amount: 1,
      }),
    ).rejects.toThrow('timeout after broadcast');

    expect(splTransferMock).toHaveBeenCalledTimes(1);
  });
});
