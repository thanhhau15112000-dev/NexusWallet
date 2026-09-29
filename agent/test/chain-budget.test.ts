import { Keypair, type Connection } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import {
  calculateMaxSendableLamports,
  InsufficientFundsError,
  transferSol,
} from '../src/chain.js';

const BALANCE_LAMPORTS = 99_990_000;
const RENT_RESERVE_LAMPORTS = 650_240;

function makeConnection(balanceLamports = BALANCE_LAMPORTS) {
  return {
    getBalance: vi.fn().mockResolvedValue(balanceLamports),
    getMinimumBalanceForRentExemption: vi.fn().mockResolvedValue(RENT_RESERVE_LAMPORTS),
    getLatestBlockhash: vi.fn().mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    simulateTransaction: vi.fn().mockResolvedValue({ value: { err: null, logs: [] } }),
    sendTransaction: vi.fn().mockResolvedValue('test-signature'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    getSignatureStatus: vi.fn().mockResolvedValue({ value: { slot: 321 } }),
  } as unknown as Connection & {
    getMinimumBalanceForRentExemption: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
  };
}

describe('SOL transfer reserves', () => {
  it('includes the dynamic rent-exempt reserve in maxSendableSol', () => {
    expect(calculateMaxSendableLamports(BALANCE_LAMPORTS, RENT_RESERVE_LAMPORTS)).toBe(99_329_760);
  });

  it('rejects an unaffordable transfer before simulation and reports the rent reserve', async () => {
    const connection = makeConnection();
    const payer = Keypair.generate();

    await expect(
      transferSol({ connection, payer, recipient: Keypair.generate().publicKey.toBase58(), lamports: 100_000_000 }),
    ).rejects.toMatchObject({
      name: 'InsufficientFundsError',
      balanceLamports: BALANCE_LAMPORTS,
      requiredLamports: 100_660_240,
      rentReserveLamports: RENT_RESERVE_LAMPORTS,
      maxSendableLamports: 99_329_760,
    } satisfies Partial<InsufficientFundsError>);

    expect(connection.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(0, 'confirmed');
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });

  it('sends the exact maxSendable amount while preserving rent exemption and the fee reserve', async () => {
    const connection = makeConnection();
    const payer = Keypair.generate();
    const amount = calculateMaxSendableLamports(BALANCE_LAMPORTS, RENT_RESERVE_LAMPORTS);

    await expect(
      transferSol({ connection, payer, recipient: Keypair.generate().publicKey.toBase58(), lamports: amount }),
    ).resolves.toEqual({ signature: 'test-signature', slot: 321 });

    expect(connection.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendTransaction).toHaveBeenCalledTimes(1);
  });
});
