import { describe, expect, it, vi } from 'vitest';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { getSignedTransactionState, signX402Transfer } from '../src/chain.js';

function encodeMintAccount(decimals: number): Buffer {
  // SPL Mint layout: 36 (mintAuthorityOption+key) + 8 (supply) + 1 (decimals) + 1 (isInitialized) + 36 (freezeAuthority) = 82 bytes
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(1, 0);
  buf.writeBigUInt64LE(1_000_000_000n, 36);
  buf.writeUInt8(decimals, 44);
  buf.writeUInt8(1, 45);
  return buf;
}

function encodeTokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  // SPL Account layout: 32 (mint) + 32 (owner) + 8 (amount) + ... = 165 bytes
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(amount, 64);
  buf.writeUInt8(1, 108); // state = Initialized
  return buf;
}

describe('signX402Transfer transaction layout & getSignedTransactionState', () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);

  function fakeConnection(opts?: { sourceAmount?: bigint; hasDestAta?: boolean; blockHeight?: number; sigStatus?: any }) {
    return {
      getAccountInfo: vi.fn(async (pubkey: PublicKey) => {
        if (pubkey.equals(mint)) {
          return { owner: TOKEN_PROGRAM_ID, data: encodeMintAccount(6), executable: false, lamports: 1_000_000 };
        }
        if (pubkey.equals(sourceAta)) {
          return {
            owner: TOKEN_PROGRAM_ID,
            data: encodeTokenAccount(mint, payer.publicKey, opts?.sourceAmount ?? 100_000n),
            executable: false,
            lamports: 1_000_000,
          };
        }
        if (pubkey.equals(destinationAta)) {
          return opts?.hasDestAta === false
            ? null
            : {
                owner: TOKEN_PROGRAM_ID,
                data: encodeTokenAccount(mint, recipient, 0n),
                executable: false,
                lamports: 1_000_000,
              };
        }
        return null;
      }),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: bs58.encode(Buffer.alloc(32, 7)),
        lastValidBlockHeight: 500,
      })),
      getSignatureStatuses: vi.fn(async () => ({ value: [opts?.sigStatus ?? null] })),
      getBlockHeight: vi.fn(async () => opts?.blockHeight ?? 400),
    } as any;
  }

  it('builds ComputeBudget(40_000, 1 microLamport) + TransferChecked with no Memo and agent as fee payer', async () => {
    const connection = fakeConnection();
    const signed = await signX402Transfer({
      connection,
      payer,
      recipient: recipient.toBase58(),
      mint: mint.toBase58(),
      baseUnits: 10_000n,
      claimed: { decimals: 6, tokenProgram: TOKEN_PROGRAM_ID.toBase58() },
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(signed.transaction, 'base64'));
    const decompiled = TransactionMessage.decompile(tx.message);

    expect(decompiled.payerKey.equals(payer.publicKey)).toBe(true);
    expect(signed.lastValidBlockHeight).toBe(500);
    expect(signed.signature).toBe(bs58.encode(tx.signatures[0]!));

    expect(decompiled.instructions).toHaveLength(3);
    const [ix0, ix1, ix2] = decompiled.instructions;
    expect(ix0!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ix0!.data[0]).toBe(2); // SetComputeUnitLimit
    expect(ix0!.data.readUInt32LE(1)).toBe(40_000);

    expect(ix1!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(ix1!.data[0]).toBe(3); // SetComputeUnitPrice
    expect(ix1!.data.readBigUInt64LE(1)).toBe(1n);

    expect(ix2!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix2!.data[0]).toBe(12); // TransferChecked
    expect(ix2!.data.readBigUInt64LE(1)).toBe(10_000n);
    expect(ix2!.data.readUInt8(9)).toBe(6);
    expect(ix2!.keys[0]!.pubkey.equals(sourceAta)).toBe(true);
    expect(ix2!.keys[1]!.pubkey.equals(mint)).toBe(true);
    expect(ix2!.keys[2]!.pubkey.equals(destinationAta)).toBe(true);
    expect(ix2!.keys[3]!.pubkey.equals(payer.publicKey)).toBe(true);
  });

  it('rejects mismatched decimals or missing payee ATA', async () => {
    await expect(
      signX402Transfer({
        connection: fakeConnection(),
        payer,
        recipient: recipient.toBase58(),
        mint: mint.toBase58(),
        baseUnits: 10_000n,
        claimed: { decimals: 9 },
      }),
    ).rejects.toThrow(/decimals/);

    await expect(
      signX402Transfer({
        connection: fakeConnection({ hasDestAta: false }),
        payer,
        recipient: recipient.toBase58(),
        mint: mint.toBase58(),
        baseUnits: 10_000n,
        claimed: { decimals: 6 },
      }),
    ).rejects.toThrow(/no token account/);
  });

  it('classifies signed transaction state as landed, failed, pending, or expired', async () => {
    expect(
      await getSignedTransactionState(fakeConnection({ sigStatus: { err: null, confirmationStatus: 'confirmed' } }), 'sig', 500),
    ).toBe('landed');
    expect(
      await getSignedTransactionState(fakeConnection({ sigStatus: { err: null, confirmationStatus: 'finalized' } }), 'sig', 500),
    ).toBe('landed');
    expect(
      await getSignedTransactionState(fakeConnection({ sigStatus: { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' } }), 'sig', 500),
    ).toBe('failed');
    expect(
      await getSignedTransactionState(fakeConnection({ sigStatus: null, blockHeight: 500 }), 'sig', 500),
    ).toBe('pending');
    expect(
      await getSignedTransactionState(fakeConnection({ sigStatus: null, blockHeight: 501 }), 'sig', 500),
    ).toBe('expired');
  });
});
