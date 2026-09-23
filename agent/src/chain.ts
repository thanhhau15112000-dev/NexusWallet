/**
 * Every Solana RPC call the service makes. Keeping them in one file means the
 * blast radius of the signer is a single import away from being auditable.
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getMint,
  getOrCreateAssociatedTokenAccount,
  transfer as splTransfer,
} from '@solana/spl-token';

export type Cluster = 'devnet';

export type TransferResult = { signature: string; slot: number | null };

/** Upper bound for a single-signature transfer fee, used for pre-flight checks. */
const FEE_BUFFER_LAMPORTS = 10_000;

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

export function explorerTxUrl(signature: string, cluster: Cluster): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function explorerAddressUrl(address: string, cluster: Cluster): string {
  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
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
    throw new Error(
      `agent wallet has ${balance / LAMPORTS_PER_SOL} SOL, needs ${
        (lamports + FEE_BUFFER_LAMPORTS) / LAMPORTS_PER_SOL
      } SOL including fees`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(recipient),
      lamports,
    }),
  );

  const signature = await withRpcRetry(() =>
    sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed', maxRetries: 3 }),
  );

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
  const info = await withRpcRetry(() => getMint(connection, mintKey));
  const baseUnits = toBaseUnits(amount, info.decimals);

  const source = await getOrCreateAssociatedTokenAccount(connection, payer, mintKey, payer.publicKey);
  const sourceAmount = BigInt(source.amount);
  if (sourceAmount < baseUnits) {
    throw new Error(`agent token account holds ${sourceAmount} base units, needs ${baseUnits}`);
  }

  const destination = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mintKey,
    new PublicKey(recipient),
  );

  // The SPL helper builds a fresh transaction on every call. An outer retry
  // after a timeout could therefore submit a second transfer if the first was
  // accepted but its confirmation response was lost.
  const signature = await splTransfer(
    connection,
    payer,
    source.address,
    destination.address,
    payer,
    baseUnits,
  );

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
