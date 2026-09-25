import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../src/chain.js';
import { dispenseInitialSeed, SeedTransferOutcomeUnknownError } from '../src/funder.js';
import { Store, type PendingInitialFunding } from '../src/store.js';

describe('initial seed funding recovery', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nexus-seed-funder-test-'));
    statePath = join(tempDir, 'state.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the signed transaction before sending and resumes the same transaction after restart', async () => {
    const store = new Store(statePath, 'agent-001', 50);
    const funder = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const recipientPubkey = recipient.toBase58();
    const blockhash = Keypair.generate().publicKey.toBase58();
    let attemptedBytes: Buffer | undefined;

    const firstConnection = {
      getBalance: vi.fn().mockResolvedValue(2_000_000_000),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash, lastValidBlockHeight: 1000 }),
      getSignatureStatuses: vi.fn().mockResolvedValue({ context: { slot: 10 }, value: [null] }),
      getBlockHeight: vi.fn().mockResolvedValue(500),
      sendRawTransaction: vi.fn(async (raw: Buffer) => {
        attemptedBytes = Buffer.from(raw);
        throw new Error('fetch failed');
      }),
    } as unknown as Connection;

    await expect(dispenseInitialSeed({
      connection: firstConnection,
      funder,
      recipientPubkey,
      amountLamports: 100_000_000,
      pending: store.getPendingInitialFunding(),
      persistPending: (pending) => store.setPendingInitialFunding(pending),
    })).rejects.toBeInstanceOf(SeedTransferOutcomeUnknownError);

    const restartedStore = new Store(statePath, 'agent-001', 50);
    const pending = restartedStore.getPendingInitialFunding();
    expect(pending).toBeDefined();
    expect(attemptedBytes?.toString('base64')).toBe(pending?.serializedTransaction);

    const recoveryConnection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ context: { slot: 11 }, value: [null] }),
      getBlockHeight: vi.fn().mockResolvedValue(500),
      sendRawTransaction: vi.fn(async (raw: Buffer) => {
        expect(raw.toString('base64')).toBe(pending?.serializedTransaction);
        return pending!.signature;
      }),
      confirmTransaction: vi.fn().mockResolvedValue({ context: { slot: 12 }, value: { err: null } }),
    } as unknown as Connection;

    const result = await dispenseInitialSeed({
      connection: recoveryConnection,
      funder,
      recipientPubkey,
      amountLamports: 100_000_000,
      pending,
      persistPending: (nextPending) => restartedStore.setPendingInitialFunding(nextPending),
    });

    expect(result.signature).toBe(pending?.signature);
    expect(recoveryConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    restartedStore.setClaimedInitialFunding(true);
    const claimedAfterRestart = new Store(statePath, 'agent-001', 50);
    expect(claimedAfterRestart.hasClaimedInitialFunding()).toBe(true);
    expect(claimedAfterRestart.getPendingInitialFunding()).toBeUndefined();
  });

  it('keeps an expired transaction pending when RPC history cannot establish its outcome', async () => {
    const store = new Store(statePath, 'agent-001', 50);
    const funder = Keypair.generate();
    const recipient = Keypair.generate().publicKey;
    const recipientPubkey = recipient.toBase58();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const transaction = new Transaction({
      feePayer: funder.publicKey,
      recentBlockhash: blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: recipient,
        lamports: 100_000_000,
      }),
    );
    transaction.sign(funder);
    const pending: PendingInitialFunding = {
      signature: bs58.encode(transaction.signature!),
      serializedTransaction: transaction.serialize().toString('base64'),
      blockhash,
      lastValidBlockHeight: 100,
      recipientPubkey,
      amountLamports: 100_000_000,
    };
    store.setPendingInitialFunding(pending);

    const connection = {
      getSignatureStatuses: vi.fn().mockResolvedValue({ context: { slot: 11 }, value: [null] }),
      getBlockHeight: vi.fn().mockResolvedValue(101),
      sendRawTransaction: vi.fn(),
    } as unknown as Connection;

    await expect(dispenseInitialSeed({
      connection,
      funder,
      recipientPubkey,
      amountLamports: 100_000_000,
      pending,
      persistPending: (nextPending) => store.setPendingInitialFunding(nextPending),
    })).rejects.toBeInstanceOf(SeedTransferOutcomeUnknownError);

    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(new Store(statePath, 'agent-001', 50).getPendingInitialFunding()).toEqual(pending);
  });
});
