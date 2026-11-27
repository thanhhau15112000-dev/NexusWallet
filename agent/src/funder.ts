import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import { PublicKey, SystemInstruction, SystemProgram, Transaction, type Keypair } from '@solana/web3.js';
import { loadOrCreateAgentKey } from './crypto.js';
import { getLamportBalance, keypairFromSecret, type Connection } from './chain.js';
import type { PendingInitialFunding } from './store.js';

export function loadOrCreateMasterFunder(params: {
  masterFunderPath: string;
  legacyKeystorePath: string;
  passphrase: string;
}): { keypair: Keypair; pubkey: string } {
  mkdirSync(dirname(params.masterFunderPath), { recursive: true });

  // If master-funder.json doesn't exist yet, but legacy agent-keystore.json exists,
  // copy it so we reuse the funded keypair (~3.9 SOL) as the Master Funder.
  if (!existsSync(params.masterFunderPath) && existsSync(params.legacyKeystorePath)) {
    copyFileSync(params.legacyKeystorePath, params.masterFunderPath);
  }

  const key = loadOrCreateAgentKey(params.masterFunderPath, params.passphrase);
  const keypair = keypairFromSecret(key.secretKey);
  return {
    keypair,
    pubkey: key.publicKey,
  };
}

/** What one initial seed hands out: 0.1 SOL. */
export const INITIAL_SEED_LAMPORTS = 100_000_000;
/** Fee the Master Funder pays for one seed transfer. */
export const SEED_FEE_LAMPORTS = 5_000;

/** Whether a funder balance covers one more seed and its fee. */
export function canFundSeed(lamports: number): boolean {
  return lamports >= INITIAL_SEED_LAMPORTS + SEED_FEE_LAMPORTS;
}

export type FunderProbe = {
  checkedAt: string;
  rpcOk: boolean;
  latencyMs: number | null;
  lamports: number | null;
  error: string | null;
};

const PROBE_TTL_MS = 15_000;

/**
 * Reads the Master Funder balance at most once per 15 seconds and shares the read between callers.
 * The same read tells whether the RPC answers, so readiness and the dashboard poll cost one call per window.
 */
export function createFunderProbe(
  connection: Connection,
  funderPubkey: string,
  now: () => number = Date.now,
): () => Promise<FunderProbe> {
  let cached: { at: number; value: FunderProbe } | null = null;
  let inFlight: Promise<FunderProbe> | null = null;
  return () => {
    if (cached && now() - cached.at < PROBE_TTL_MS) return Promise.resolve(cached.value);
    inFlight ??= (async () => {
      const started = now();
      let value: FunderProbe;
      try {
        const lamports = await getLamportBalance(connection, funderPubkey);
        value = { checkedAt: new Date(started).toISOString(), rpcOk: true, latencyMs: now() - started, lamports, error: null };
      } catch (err) {
        value = {
          checkedAt: new Date(started).toISOString(),
          rpcOk: false,
          latencyMs: null,
          lamports: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      // A failed read is cached too, so an RPC outage is not hammered by every poll.
      cached = { at: started, value };
      inFlight = null;
      return value;
    })();
    return inFlight;
  };
}

let funderQueue: Promise<unknown> = Promise.resolve();

export class SeedTransferFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTransferFailedError';
  }
}

export class SeedTransferOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedTransferOutcomeUnknownError';
  }
}

type SignatureStatusValue = Awaited<ReturnType<Connection['getSignatureStatuses']>>['value'][number];

function assertPendingTransferMatches(
  pending: PendingInitialFunding,
  params: { funder: Keypair; recipientPubkey: string; amountLamports: number },
): Buffer {
  if (pending.recipientPubkey !== params.recipientPubkey || pending.amountLamports !== params.amountLamports) {
    throw new Error('stored seed transaction does not match this agent wallet');
  }

  try {
    const rawTransaction = Buffer.from(pending.serializedTransaction, 'base64');
    const transaction = Transaction.from(rawTransaction);
    const instruction = transaction.instructions[0];
    if (!instruction || transaction.instructions.length !== 1 || !instruction.programId.equals(SystemProgram.programId)) {
      throw new Error('unexpected instruction');
    }

    const transfer = SystemInstruction.decodeTransfer(instruction);
    const signature = transaction.signature ? bs58.encode(transaction.signature) : '';
    if (
      transaction.feePayer?.toBase58() !== params.funder.publicKey.toBase58() ||
      transaction.recentBlockhash !== pending.blockhash ||
      signature !== pending.signature ||
      !transaction.verifySignatures(true) ||
      transfer.fromPubkey.toBase58() !== params.funder.publicKey.toBase58() ||
      transfer.toPubkey.toBase58() !== params.recipientPubkey ||
      transfer.lamports !== BigInt(params.amountLamports)
    ) {
      throw new Error('transaction fields or signature do not match');
    }
    return rawTransaction;
  } catch {
    throw new Error('stored seed transaction is invalid; refusing to submit it');
  }
}

function confirmedResult(signature: string, status: SignatureStatusValue): { signature: string; slot: number | null } | null {
  if (!status) return null;
  if (status.err) {
    throw new SeedTransferFailedError(`seed transaction failed on chain: ${JSON.stringify(status.err)}`);
  }
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' || status.confirmations === null) {
    return { signature, slot: status.slot };
  }
  return null;
}

async function readSeedSignatureStatus(connection: Connection, pending: PendingInitialFunding): Promise<SignatureStatusValue> {
  try {
    const { value: [status] } = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true });
    return status ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SeedTransferOutcomeUnknownError(`could not check seed transaction status: ${message}`);
  }
}

function unknownOutcome(err: unknown): SeedTransferOutcomeUnknownError {
  const message = err instanceof Error ? err.message : String(err);
  return new SeedTransferOutcomeUnknownError(
    `seed transfer outcome is unknown; the signed transaction is retained to prevent a duplicate payment: ${message}`,
  );
}

async function confirmPendingTransfer(
  connection: Connection,
  pending: PendingInitialFunding,
): Promise<{ signature: string; slot: number | null }> {
  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature: pending.signature,
        blockhash: pending.blockhash,
        lastValidBlockHeight: pending.lastValidBlockHeight,
      },
      'confirmed',
    );
    if (confirmation.value.err) {
      throw new SeedTransferFailedError(`seed transaction failed on chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return { signature: pending.signature, slot: confirmation.context.slot };
  } catch (err) {
    if (err instanceof SeedTransferFailedError) throw err;
    const status = await readSeedSignatureStatus(connection, pending);
    const result = confirmedResult(pending.signature, status);
    if (result) return result;
    throw unknownOutcome(err);
  }
}

async function submitPendingTransfer(
  connection: Connection,
  pending: PendingInitialFunding,
  rawTransaction: Buffer,
): Promise<{ signature: string; slot: number | null }> {
  const knownStatus = await readSeedSignatureStatus(connection, pending);
  const knownResult = confirmedResult(pending.signature, knownStatus);
  if (knownResult) return knownResult;
  if (knownStatus) return confirmPendingTransfer(connection, pending);

  let blockHeight: number;
  try {
    blockHeight = await connection.getBlockHeight('confirmed');
  } catch (err) {
    throw unknownOutcome(err);
  }
  if (blockHeight > pending.lastValidBlockHeight) {
    const historicalStatus = await readSeedSignatureStatus(connection, pending);
    const historicalResult = confirmedResult(pending.signature, historicalStatus);
    if (historicalResult) return historicalResult;
    throw new SeedTransferOutcomeUnknownError(
      'seed transaction expired without a conclusive signature status; it remains pending to prevent a duplicate payment',
    );
  }

  try {
    const sentSignature = await connection.sendRawTransaction(rawTransaction, { maxRetries: 3 });
    if (sentSignature !== pending.signature) {
      throw new Error('RPC returned a different seed transaction signature');
    }
  } catch (err) {
    if (err instanceof SeedTransferOutcomeUnknownError) throw err;
    const status = await readSeedSignatureStatus(connection, pending);
    const result = confirmedResult(pending.signature, status);
    if (result) return result;
    if (status) return confirmPendingTransfer(connection, pending);
    throw unknownOutcome(err);
  }

  return confirmPendingTransfer(connection, pending);
}

export function dispenseInitialSeed(params: {
  connection: Connection;
  funder: Keypair;
  recipientPubkey: string;
  amountLamports: number;
  pending?: PendingInitialFunding;
  persistPending: (pending: PendingInitialFunding) => void;
}): Promise<{ signature: string; slot: number | null }> {
  const op = funderQueue.then(async () => {
    let pending = params.pending;
    if (!pending) {
      const funderPubkey = params.funder.publicKey.toBase58();
      const balance = await getLamportBalance(params.connection, funderPubkey);
      if (balance < params.amountLamports + SEED_FEE_LAMPORTS) {
        throw new Error(
          `Master Funder wallet (${funderPubkey}) does not have enough Devnet SOL (${balance / 1e9} SOL available). Please fund it.`,
        );
      }

      const latestBlockhash = await params.connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        feePayer: params.funder.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
      }).add(
        SystemProgram.transfer({
          fromPubkey: params.funder.publicKey,
          toPubkey: new PublicKey(params.recipientPubkey),
          lamports: params.amountLamports,
        }),
      );
      transaction.sign(params.funder);
      if (!transaction.signature) throw new Error('could not sign seed transaction');

      pending = {
        signature: bs58.encode(transaction.signature),
        serializedTransaction: transaction.serialize().toString('base64'),
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        recipientPubkey: params.recipientPubkey,
        amountLamports: params.amountLamports,
      };
      params.persistPending(pending);
    }

    const rawTransaction = assertPendingTransferMatches(pending, params);
    return submitPendingTransfer(params.connection, pending, rawTransaction);
  });

  funderQueue = op.catch(() => {});
  return op;
}
