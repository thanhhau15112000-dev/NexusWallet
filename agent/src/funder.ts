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
      // Estimate transaction fee ~5000 lamports.
      if (balance < params.amountLamports + 5000) {
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
