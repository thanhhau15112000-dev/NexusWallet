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
import nacl from 'tweetnacl';
import { getX402TransactionState, signX402Transfer } from '../src/chain.js';

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

describe('signX402Transfer transaction layout & getX402TransactionState', () => {
  const payer = Keypair.generate();
  const feePayer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const destinationAta = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID);
  const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

  function fakeConnection(opts?: { sourceAmount?: bigint; hasDestAta?: boolean }) {
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
    } as any;
  }

  const sign = (connection = fakeConnection(), memo?: string) =>
    signX402Transfer({
      connection,
      payer,
      recipient: recipient.toBase58(),
      mint: mint.toBase58(),
      baseUnits: 10_000n,
      feePayer: feePayer.toBase58(),
      memo,
    });

  it('builds ComputeBudget(40_000, 1) + TransferChecked + Memo with the facilitator as fee payer, signed only by the agent', async () => {
    const signed = await sign();
    const tx = VersionedTransaction.deserialize(Buffer.from(signed.transaction, 'base64'));
    const decompiled = TransactionMessage.decompile(tx.message);

    expect(decompiled.payerKey.equals(feePayer)).toBe(true);
    expect(signed.lastValidBlockHeight).toBe(500);
    // Fee payer slot is left for the facilitator; the agent's slot holds a valid signature.
    expect(tx.signatures[0]!.every((byte) => byte === 0)).toBe(true);
    const payerIndex = tx.message.staticAccountKeys.findIndex((key) => key.equals(payer.publicKey));
    expect(signed.payerSignature).toBe(bs58.encode(tx.signatures[payerIndex]!));
    expect(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[payerIndex]!, payer.publicKey.toBytes())).toBe(true);

    expect(decompiled.instructions).toHaveLength(4);
    const [ix0, ix1, ix2, ix3] = decompiled.instructions;
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

    expect(ix3!.programId.toBase58()).toBe(MEMO);
    expect(ix3!.keys).toHaveLength(0);
    expect(ix3!.data.toString('utf8')).toMatch(/^[0-9a-f]{32}$/);

    // Fee payer isolation: the facilitator is referenced by no instruction.
    for (const ix of decompiled.instructions) expect(ix.keys.some((k) => k.pubkey.equals(feePayer))).toBe(false);
  });

  it('uses the seller memo when given, and a fresh nonce otherwise', async () => {
    const memoOf = (b64: string) =>
      TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(b64, 'base64')).message).instructions[3]!.data.toString('utf8');
    expect(memoOf((await sign(fakeConnection(), 'order-42')).transaction)).toBe('order-42');
    expect(memoOf((await sign()).transaction)).not.toBe(memoOf((await sign()).transaction));
  });

  it('refuses when the agent lacks the tokens or the payee has no token account', async () => {
    await expect(sign(fakeConnection({ sourceAmount: 1n }))).rejects.toThrow(/needs 10000/);
    await expect(sign(fakeConnection({ hasDestAta: false }))).rejects.toThrow(/no token account/);
  });

  describe('getX402TransactionState', () => {
    const agent = payer.publicKey.toBase58();
    function chain(opts: { history?: string[]; txs?: Record<string, { signatures: string[]; err?: unknown }>; blockHeight?: number }) {
      return {
        getBlockHeight: vi.fn(async () => opts.blockHeight ?? 400),
        getSignaturesForAddress: vi.fn(async () => (opts.history ?? []).map((signature) => ({ signature }))),
        getTransactions: vi.fn(async (ids: string[]) =>
          ids.map((id) => {
            const tx = opts.txs?.[id];
            return tx ? { transaction: { signatures: tx.signatures }, meta: { err: tx.err ?? null } } : null;
          }),
        ),
      } as any;
    }

    it('confirms the reported transaction only when it carries the agent signature', async () => {
      const connection = chain({ txs: { TX1: { signatures: ['FAC', 'MINE'] } } });
      expect(await getX402TransactionState(connection, { payer: agent, payerSignature: 'MINE', lastValidBlockHeight: 500, txId: 'TX1' })).toEqual({
        state: 'landed',
        txId: 'TX1',
      });
      expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
    });

    it('falls back to the agent history when the reported id does not hold the agent signature', async () => {
      const connection = chain({
        history: ['OTHER', 'TX2'],
        txs: { FAKE: { signatures: ['FAC', 'SOMEONE'] }, OTHER: { signatures: ['X'] }, TX2: { signatures: ['FAC', 'MINE'], err: { InstructionError: [2, 'Custom'] } } },
      });
      expect(await getX402TransactionState(connection, { payer: agent, payerSignature: 'MINE', lastValidBlockHeight: 500, txId: 'FAKE' })).toEqual({
        state: 'failed',
        txId: 'TX2',
      });
    });

    it('is pending until the blockhash expires, then expired', async () => {
      const args = { payer: agent, payerSignature: 'MINE', lastValidBlockHeight: 500 };
      expect(await getX402TransactionState(chain({ history: ['OTHER'], blockHeight: 500 }), args)).toEqual({ state: 'pending' });
      expect(await getX402TransactionState(chain({ history: [], blockHeight: 501 }), args)).toEqual({ state: 'expired' });
    });
  });
});
