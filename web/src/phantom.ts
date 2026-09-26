import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { solToLamports } from '@nexus/shared';

type PhantomPublicKey = { toString(): string };

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PhantomPublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(transaction: VersionedTransaction): Promise<{ signature: string }>;
  on(event: 'connect' | 'disconnect' | 'accountChanged', handler: (arg: unknown) => void): void;
  off?(event: string, handler: (arg: unknown) => void): void;
};

type PhantomWindow = Window & {
  phantom?: { solana?: PhantomProvider };
  solana?: PhantomProvider;
};

export function getPhantom(): PhantomProvider | null {
  const w = window as PhantomWindow;
  const provider = w.phantom?.solana ?? w.solana;
  return provider?.isPhantom ? provider : null;
}

export const PHANTOM_INSTALL_URL = 'https://phantom.app/download';

function calculatePriorityFee(samples: { prioritizationFee: number }[]): number {
  const fees = samples
    .map((sample) => sample.prioritizationFee)
    .filter((fee) => Number.isFinite(fee) && fee >= 0)
    .sort((a, b) => a - b);
  if (!fees.length) return 0;
  const middle = Math.floor(fees.length / 2);
  const median = fees.length % 2 === 0
    ? Math.round(((fees[middle - 1] ?? 0) + (fees[middle] ?? 0)) / 2)
    : (fees[middle] ?? 0);
  return Math.min(median, 100_000);
}

export async function buildVersionedSolTransfer(params: {
  connection: Connection;
  from: PublicKey;
  to: PublicKey;
  lamports: number;
}): Promise<VersionedTransaction> {
  const [{ blockhash }, recentFees] = await Promise.all([
    params.connection.getLatestBlockhash('confirmed'),
    params.connection.getRecentPrioritizationFees(),
  ]);
  const message = new TransactionMessage({
    payerKey: params.from,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: calculatePriorityFee(recentFees) }),
      SystemProgram.transfer({
        fromPubkey: params.from,
        toPubkey: params.to,
        lamports: params.lamports,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/**
 * Ask Phantom to sign a UTF-8 message. Phantom returns a raw 64-byte signature;
 * the agent service verifies it base58-encoded against the owner key.
 */
export async function signPhantomMessage(message: string): Promise<string> {
  const provider = getPhantom();
  if (!provider) throw new Error('Phantom is not installed');
  const encoded = new TextEncoder().encode(message);
  const { signature } = await provider.signMessage(encoded, 'utf8');
  return bs58.encode(signature);
}

/**
 * Send SOL directly from the connected Phantom wallet to a recipient (e.g. Agent wallet).
 */
export async function sendSolFromPhantom(params: {
  rpcUrl: string;
  fromPubkey: string;
  toPubkey: string;
  amountSol: number;
  provider?: PhantomProvider;
}): Promise<string> {
  const provider = params.provider ?? getPhantom();
  if (!provider) throw new Error('Phantom is not installed');

  const connection = new Connection(params.rpcUrl, 'confirmed');
  const from = new PublicKey(params.fromPubkey);
  const to = new PublicKey(params.toPubkey);
  const lamports = solToLamports(params.amountSol);

  const tx = await buildVersionedSolTransfer({ connection, from, to, lamports });
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    const logs = simulation.value.logs?.join(' | ') ?? 'no simulation logs';
    throw new Error(`transaction simulation failed: ${JSON.stringify(simulation.value.err)}; ${logs}`);
  }

  const result = await provider.signAndSendTransaction(tx);
  return result.signature;
}
