/**
 * Every Solana RPC call the service makes. Keeping them in one file means the
 * blast radius of the signer is a single import away from being auditable.
 */
import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
} from '@solana/spl-token';

export type Cluster = 'devnet';

export type TransferResult = { signature: string; slot: number | null };

export type PriorityFeeSample = { prioritizationFee: number };

/** A bounded median keeps a single congested validator from setting an extreme fee. */
export function calculatePriorityFee(samples: PriorityFeeSample[], maxMicroLamports = 100_000): number {
  const fees = samples
    .map((sample) => sample.prioritizationFee)
    .filter((fee) => Number.isFinite(fee) && fee >= 0)
    .sort((a, b) => a - b);
  if (fees.length === 0) return 0;
  const middle = Math.floor(fees.length / 2);
  const median = fees.length % 2 === 0
    ? Math.round(((fees[middle - 1] ?? 0) + (fees[middle] ?? 0)) / 2)
    : (fees[middle] ?? 0);
  return Math.min(Math.max(0, median), maxMicroLamports);
}

export class TransactionSimulationError extends Error {
  readonly code = 'simulation_failed';

  constructor(
    readonly simulationError: unknown,
    readonly logs: string[],
  ) {
    super(`transaction simulation failed: ${JSON.stringify(simulationError)}${logs.length ? `; ${logs.join(' | ')}` : ''}`);
  }
}

/**
 * Upper bound for a SOL transfer fee, used for pre-flight checks: 5,000 lamports base fee plus
 * the priority fee cap (50,000 compute units at 100,000 micro-lamports).
 */
export const FEE_BUFFER_LAMPORTS = 10_000;

export class InsufficientFundsError extends Error {
  constructor(
    readonly balanceLamports: number,
    readonly requiredLamports: number,
  ) {
    super(
      `agent wallet has ${balanceLamports / LAMPORTS_PER_SOL} SOL, needs ${
        requiredLamports / LAMPORTS_PER_SOL
      } SOL including fees`,
    );
    this.name = 'InsufficientFundsError';
  }
}

const RETRYABLE = [/429/, /rate limit/i, /503/, /502/, /timeout/i, /ECONNRESET/, /fetch failed/i];

/**
 * Retry transient RPC failures with exponential backoff. Non-transient errors
 * (insufficient funds, rejected instruction) surface immediately so they are
 * never silently retried into a duplicate transfer.
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 400;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!RETRYABLE.some((re) => re.test(message)) || attempt === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

export function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed');
}

export function keypairFromSecret(secretKey: Uint8Array): Keypair {
  return Keypair.fromSecretKey(secretKey);
}

export function isValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

type BuiltTransaction = {
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
};

async function buildVersionedTransaction(params: {
  connection: Connection;
  payer: PublicKey;
  instructions: TransactionInstruction[];
  computeUnitLimit: number;
}): Promise<BuiltTransaction> {
  const [latest, recentFees] = await Promise.all([
    withRpcRetry(() => params.connection.getLatestBlockhash('confirmed')),
    withRpcRetry(() => params.connection.getRecentPrioritizationFees()),
  ]);
  const priorityFee = calculatePriorityFee(recentFees);
  const message = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: latest.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...params.instructions,
    ],
  }).compileToV0Message();
  return {
    transaction: new VersionedTransaction(message),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

async function simulateAndSend(
  connection: Connection,
  payer: Keypair,
  built: BuiltTransaction,
): Promise<string> {
  const simulation = await withRpcRetry(() => connection.simulateTransaction(built.transaction));
  if (simulation.value.err) {
    throw new TransactionSimulationError(simulation.value.err, simulation.value.logs ?? []);
  }

  built.transaction.sign([payer]);
  // Do not retry this call: a timeout can happen after the validator accepted
  // the transaction, and resubmitting a freshly signed transfer could duplicate it.
  const signature = await connection.sendTransaction(built.transaction, {
    maxRetries: 3,
    skipPreflight: true,
  });
  const confirmation = await withRpcRetry(() =>
    connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    ),
  );
  if (confirmation.value.err) {
    throw new Error(`transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

export function explorerTxUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function explorerAddressUrl(address: string, cluster: Cluster): string {
  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}

export type AgentHistoryItem = {
  signature: string;
  blockTime: number | null;
  status: 'confirmed' | 'failed';
  /** Net change of the wallet's SOL balance in this transaction, fee included. Negative when SOL left. */
  deltaLamports: number;
  balanceAfterLamports: number;
  feeLamports: number;
  explorerUrl: string;
};

export type AgentHistoryPage = {
  items: AgentHistoryItem[];
  /** Signature to pass as `before` for the next (older) page, or null when this page reached the end. */
  nextBefore: string | null;
};

/**
 * One page of transactions that touched `address`, newest first, with the wallet's own SOL change and
 * balance after each one, read from the transaction's pre/post balances. Transactions the RPC has not
 * indexed yet are skipped. Pass the previous page's `nextBefore` as `before` to go back in time.
 */
export async function getAgentHistory(
  connection: Connection,
  address: string,
  cluster: Cluster,
  options: { limit?: number; before?: string } = {},
): Promise<AgentHistoryPage> {
  const wallet = new PublicKey(address);
  const limit = options.limit ?? 10;
  const signatures = await withRpcRetry(() =>
    connection.getSignaturesForAddress(wallet, { limit, before: options.before }, 'confirmed'),
  );
  if (signatures.length === 0) return { items: [], nextBefore: null };
  // A full page means older transactions may exist; skipped rows below still count toward the page.
  const nextBefore = signatures.length === limit ? (signatures[signatures.length - 1]?.signature ?? null) : null;
  const transactions = await withRpcRetry(() =>
    connection.getParsedTransactions(
      signatures.map((entry) => entry.signature),
      { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ),
  );

  const items: AgentHistoryItem[] = [];
  transactions.forEach((tx, index) => {
    const entry = signatures[index];
    if (!tx?.meta || !entry) return;
    const at = tx.transaction.message.accountKeys.findIndex((key) => key.pubkey.equals(wallet));
    const before = tx.meta.preBalances[at];
    const after = tx.meta.postBalances[at];
    if (at < 0 || before === undefined || after === undefined) return;
    items.push({
      signature: entry.signature,
      blockTime: tx.blockTime ?? entry.blockTime ?? null,
      status: tx.meta.err || entry.err ? 'failed' : 'confirmed',
      deltaLamports: after - before,
      balanceAfterLamports: after,
      feeLamports: tx.meta.fee,
      explorerUrl: explorerTxUrl(entry.signature, cluster),
    });
  });
  return { items, nextBefore };
}

export async function getLamportBalance(connection: Connection, address: string): Promise<number> {
  return withRpcRetry(() => connection.getBalance(new PublicKey(address), 'confirmed'));
}

export async function transferSol(params: {
  connection: Connection;
  payer: Keypair;
  recipient: string;
  lamports: number;
}): Promise<TransferResult> {
  const { connection, payer, recipient, lamports } = params;

  const balance = await getLamportBalance(connection, payer.publicKey.toBase58());
  if (balance < lamports + FEE_BUFFER_LAMPORTS) {
    throw new InsufficientFundsError(balance, lamports + FEE_BUFFER_LAMPORTS);
  }

  const built = await buildVersionedTransaction({
    connection,
    payer: payer.publicKey,
    computeUnitLimit: 50_000,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(recipient),
        lamports,
      }),
    ],
  });
  const signature = await simulateAndSend(connection, payer, built);

  const status = await connection.getSignatureStatus(signature);
  return { signature, slot: status.value?.slot ?? null };
}

/** Fixed-point conversion that rejects values the mint cannot represent. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 100
  ) {
    throw new RangeError(`invalid token amount or mint decimals: ${amount}, ${decimals}`);
  }
  const fixed = amount.toFixed(decimals);
  if (Number(fixed) !== amount) {
    throw new RangeError(`token amount ${amount} has more precision than the mint allows (${decimals} decimals)`);
  }
  const [whole = '0', fraction = ''] = fixed.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/**
 * SPL transfer for an allowlisted mint. The agent pays rent to create the
 * recipient's associated token account when it does not exist yet.
 */
export async function transferSpl(params: {
  connection: Connection;
  payer: Keypair;
  recipient: string;
  mint: string;
  amount: number;
}): Promise<TransferResult> {
  const { connection, payer, recipient, mint, amount } = params;
  const mintKey = new PublicKey(mint);
  const mintAccount = await withRpcRetry(() => connection.getAccountInfo(mintKey, 'confirmed'));
  if (!mintAccount) throw new Error(`mint account ${mint} does not exist`);
  const programId = mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : mintAccount.owner.equals(TOKEN_PROGRAM_ID)
      ? TOKEN_PROGRAM_ID
      : null;
  if (!programId) throw new Error(`mint ${mint} is owned by an unsupported token program`);
  const info = await withRpcRetry(() => getMint(connection, mintKey, 'confirmed', programId));
  const baseUnits = toBaseUnits(amount, info.decimals);

  const sourceAta = await getAssociatedTokenAddress(
    mintKey,
    payer.publicKey,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const source = await withRpcRetry(() => getAccount(connection, sourceAta, 'confirmed', programId));
  const sourceAmount = BigInt(source.amount.toString());
  if (sourceAmount < baseUnits) {
    throw new Error(`agent token account holds ${sourceAmount} base units, needs ${baseUnits}`);
  }

  const recipientKey = new PublicKey(recipient);
  const destinationAta = await getAssociatedTokenAddress(
    mintKey,
    recipientKey,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const built = await buildVersionedTransaction({
    connection,
    payer: payer.publicKey,
    computeUnitLimit: 150_000,
    instructions: [
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        destinationAta,
        recipientKey,
        mintKey,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        sourceAta,
        mintKey,
        destinationAta,
        payer.publicKey,
        baseUnits,
        info.decimals,
        [],
        programId,
      ),
    ],
  });
  const signature = await simulateAndSend(connection, payer, built);

  const status = await connection.getSignatureStatus(signature);
  return { signature, slot: status.value?.slot ?? null };
}

export async function requestAirdrop(params: {
  connection: Connection;
  address: string;
  lamports: number;
}): Promise<string> {
  const { connection, address, lamports } = params;
  const signature = await withRpcRetry(
    () => connection.requestAirdrop(new PublicKey(address), lamports),
    { attempts: 2 },
  );
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

export type { Connection, Keypair };
