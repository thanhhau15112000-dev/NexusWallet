import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getMintMock,
  getAccountMock,
  getAssociatedTokenAddressMock,
  createAtaMock,
  createTransferCheckedMock,
  tokenProgramId,
  token2022ProgramId,
} = vi.hoisted(() => ({
  getMintMock: vi.fn(),
  getAccountMock: vi.fn(),
  getAssociatedTokenAddressMock: vi.fn(),
  createAtaMock: vi.fn(() => ({
    keys: [],
    programId: { toBase58: () => '11111111111111111111111111111111' },
    data: Buffer.alloc(0),
  })),
  createTransferCheckedMock: vi.fn(() => ({
    keys: [],
    programId: { toBase58: () => '11111111111111111111111111111111' },
    data: Buffer.alloc(0),
  })),
  tokenProgramId: { kind: 'classic-token-program', toBase58: () => '11111111111111111111111111111111' },
  token2022ProgramId: { kind: 'token-2022-program', toBase58: () => '11111111111111111111111111111111' },
}));

vi.mock('@solana/spl-token', () => ({
  getMint: getMintMock,
  getAccount: getAccountMock,
  getAssociatedTokenAddress: getAssociatedTokenAddressMock,
  TOKEN_PROGRAM_ID: tokenProgramId,
  TOKEN_2022_PROGRAM_ID: token2022ProgramId,
  ASSOCIATED_TOKEN_PROGRAM_ID: { toBase58: () => '11111111111111111111111111111111' },
  createAssociatedTokenAccountIdempotentInstruction: createAtaMock,
  createTransferCheckedInstruction: createTransferCheckedMock,
}));

import { Keypair, PublicKey } from '@solana/web3.js';
import { calculatePriorityFee, toBaseUnits, transferSpl, withRpcRetry } from '../src/chain.js';

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

describe('calculatePriorityFee', () => {
  it('uses a bounded median and returns zero for an empty sample', () => {
    expect(calculatePriorityFee([])).toBe(0);
    expect(calculatePriorityFee([{ prioritizationFee: 90 }, { prioritizationFee: 10 }, { prioritizationFee: 30 }])).toBe(30);
    expect(calculatePriorityFee([{ prioritizationFee: 999_999 }], 100_000)).toBe(100_000);
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
    getAccountMock.mockResolvedValue({ amount: 10n });
    getAssociatedTokenAddressMock.mockResolvedValue(new PublicKey('11111111111111111111111111111111'));
    const payer = Keypair.generate();
    const connection = {
      getAccountInfo: vi.fn().mockResolvedValue({ owner: { equals: (value: { kind?: string }) => value.kind === 'classic-token-program' } }),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendTransaction: vi.fn().mockRejectedValue(new Error('timeout after broadcast')),
    };

    await expect(
      transferSpl({
        connection: connection as never,
        payer,
        recipient: payer.publicKey.toBase58(),
        mint: payer.publicKey.toBase58(),
        amount: 1,
      }),
    ).rejects.toThrow('timeout after broadcast');

    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('selects Token-2022 for mint lookup and transfer instructions', async () => {
    getMintMock.mockResolvedValue({ decimals: 0 });
    getAccountMock.mockResolvedValue({ amount: 10n });
    getAssociatedTokenAddressMock.mockResolvedValue(new PublicKey('11111111111111111111111111111111'));
    const payer = Keypair.generate();
    const connection = {
      getAccountInfo: vi.fn().mockResolvedValue({ owner: { equals: (value: { kind?: string }) => value === token2022ProgramId } }),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
      getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
      simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
      sendTransaction: vi.fn().mockResolvedValue('signature'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
      getSignatureStatus: vi.fn().mockResolvedValue({ value: { slot: 7 } }),
    };

    const result = await transferSpl({
      connection: connection as never,
      payer,
      recipient: payer.publicKey.toBase58(),
      mint: payer.publicKey.toBase58(),
      amount: 1,
    });

    expect(result).toEqual({ signature: 'signature', slot: 7 });
    expect(getMintMock).toHaveBeenCalledWith(
      connection,
      expect.any(PublicKey),
      'confirmed',
      token2022ProgramId,
    );
    expect(createAtaMock).toHaveBeenCalledWith(
      payer.publicKey,
      expect.any(PublicKey),
      expect.any(PublicKey),
      expect.any(PublicKey),
      token2022ProgramId,
      expect.anything(),
    );
    expect(createTransferCheckedMock).toHaveBeenCalledWith(
      expect.any(PublicKey),
      expect.any(PublicKey),
      expect.any(PublicKey),
      payer.publicKey,
      1n,
      0,
      [],
      token2022ProgramId,
    );
  });
});
