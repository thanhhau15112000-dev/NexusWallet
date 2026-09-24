import bs58 from 'bs58';

type PhantomPublicKey = { toString(): string };

export type PhantomProvider = {
  isPhantom?: boolean;
  publicKey: PhantomPublicKey | null;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PhantomPublicKey }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>;
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
