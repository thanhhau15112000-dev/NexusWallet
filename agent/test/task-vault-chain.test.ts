import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { submitTaskVaultInstruction } from '../src/task-vault-chain.js';

describe('Task Vault transaction submission', () => {
  it('signs, submits, and confirms the instruction before returning its signature', async () => {
    const signer = Keypair.generate();
    const instruction = SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    const sendTransaction = vi.fn().mockResolvedValue('confirmed-signature');
    const confirmTransaction = vi.fn().mockResolvedValue({ value: { err: null } });
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 7 }),
      sendTransaction,
      confirmTransaction,
    } as never;

    await expect(submitTaskVaultInstruction(connection, instruction, signer)).resolves.toBe('confirmed-signature');
    const transaction = sendTransaction.mock.calls[0]![0];
    expect(transaction.feePayer?.toBase58()).toBe(signer.publicKey.toBase58());
    expect(transaction.instructions).toEqual([instruction]);
    expect(sendTransaction.mock.calls[0]![1]).toEqual([signer]);
    expect(confirmTransaction).toHaveBeenCalledWith({
      signature: 'confirmed-signature',
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 7,
    }, 'confirmed');
  });

  it('does not report success when the confirmation contains an execution error', async () => {
    const signer = Keypair.generate();
    const connection = {
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 7 }),
      sendTransaction: vi.fn().mockResolvedValue('failed-signature'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: { InstructionError: [0, 'Custom'] } } }),
    } as never;

    await expect(
      submitTaskVaultInstruction(connection, new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [],
        data: Buffer.alloc(0),
      }), signer),
    ).rejects.toThrow('Task Vault transaction failed');
  });
});
