import bs58 from 'bs58';
import { Connection, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { solToLamports } from '@nexus/shared';

type PhantomPublicKey = { toString(): string };

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PhantomPublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
  signAndSendTransaction(transaction: unknown): Promise<{ signature: string }>;
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
}): Promise<string> {
  const provider = getPhantom();
  if (!provider) throw new Error('Phantom is not installed');

  const connection = new Connection(params.rpcUrl, 'confirmed');
  const from = new PublicKey(params.fromPubkey);
  const to = new PublicKey(params.toPubkey);
  const lamports = solToLamports(params.amountSol);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports,
    }),
  );

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = from;

  const result = await provider.signAndSendTransaction(tx);
  return result.signature;
}
