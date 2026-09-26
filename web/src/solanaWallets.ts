import bs58 from 'bs58';
import { SolanaSignAndSendTransaction, SolanaSignMessage } from '@solana/wallet-standard-features';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { solToLamports } from '@nexus/shared';
import { PublicKey, SystemProgram, Transaction, Connection } from '@solana/web3.js';
import { getPhantom, sendSolFromPhantom, type PhantomProvider } from './phantom.js';

type StandardConnectFeature = {
  connect(options?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
};

type StandardDisconnectFeature = { disconnect(): Promise<void> };

type StandardEventsFeature = {
  on(
    event: 'change',
    listener: (properties: { accounts?: readonly WalletAccount[] }) => void,
  ): () => void;
};

type SignMessageOutput = {
  signedMessage: Uint8Array;
  signature: Uint8Array;
  signatureType?: 'ed25519';
};

type SignAndSendOutput = { signature: Uint8Array };

export type WalletChoice =
  | { kind: 'standard'; id: string; name: string; icon: string; wallet: Wallet }
  | { kind: 'phantom'; id: 'phantom-legacy'; name: 'Phantom'; icon: ''; provider: PhantomProvider };

export type ConnectedWallet =
  | { kind: 'standard'; wallet: Wallet; account: WalletAccount; address: string }
  | { kind: 'phantom'; provider: PhantomProvider; address: string };

function hasFeature(wallet: Wallet, feature: string): boolean {
  return feature in wallet.features;
}

function supportsSignIn(wallet: Wallet): boolean {
  return (
    wallet.chains.some((chain) => chain.startsWith('solana:')) &&
    hasFeature(wallet, 'standard:connect') &&
    hasFeature(wallet, SolanaSignMessage)
  );
}

export function discoverWallets(): WalletChoice[] {
  const standardWallets = getWallets()
    .get()
    .filter(supportsSignIn)
    .map((wallet) => ({
      kind: 'standard' as const,
      id: `standard:${wallet.name}`,
      name: wallet.name,
      icon: wallet.icon,
      wallet,
    }));

  const choices: WalletChoice[] = [...standardWallets];
  const phantom = getPhantom();
  if (phantom && !standardWallets.some((choice) => choice.name.toLowerCase() === 'phantom')) {
    choices.push({ kind: 'phantom', id: 'phantom-legacy', name: 'Phantom', icon: '', provider: phantom });
  }
  return choices;
}

export async function connectWallet(choice: WalletChoice, silent = false): Promise<ConnectedWallet> {
  if (choice.kind === 'phantom') {
    const result = await choice.provider.connect(silent ? { onlyIfTrusted: true } : undefined);
    const address = result.publicKey.toString();
    if (!address) throw new Error('Phantom did not return a Solana address');
    return { kind: 'phantom', provider: choice.provider, address };
  }

  const connect = choice.wallet.features['standard:connect'] as StandardConnectFeature | undefined;
  if (!connect) throw new Error(`${choice.name} does not support wallet connection`);
  const result = await connect.connect(silent ? { silent: true } : undefined);
  const account = result.accounts.find(
    (candidate) =>
      candidate.chains.some((chain) => chain.startsWith('solana:')) &&
      candidate.features.includes(SolanaSignMessage),
  );
  if (!account) throw new Error(`${choice.name} has no connected Solana account that can sign messages`);
  return { kind: 'standard', wallet: choice.wallet, account, address: account.address };
}

export async function signMessageWithWallet(
  connected: ConnectedWallet,
  message: string,
): Promise<string> {
  if (connected.kind === 'phantom') {
    const encoded = new TextEncoder().encode(message);
    const { signature } = await connected.provider.signMessage(encoded, 'utf8');
    if (signature.length !== 64) throw new Error('The wallet returned an invalid message signature');
    return bs58.encode(signature);
  }

  const feature = connected.wallet.features[SolanaSignMessage] as
    | { signMessage(...inputs: readonly { account: WalletAccount; message: Uint8Array }[]): Promise<readonly SignMessageOutput[]> }
    | undefined;
  if (!feature) throw new Error(`${connected.wallet.name} no longer supports message signing`);

  const expectedMessage = new TextEncoder().encode(message);
  const [result] = await feature.signMessage({ account: connected.account, message: expectedMessage });
  if (!result) throw new Error(`${connected.wallet.name} returned no message signature`);
  if (result.signature.length !== 64) throw new Error('The wallet returned an invalid message signature');
  if (result.signatureType && result.signatureType !== 'ed25519') {
    throw new Error('The wallet returned an unsupported signature type');
  }
  if (
    result.signedMessage.length !== expectedMessage.length ||
    result.signedMessage.some((byte, index) => byte !== expectedMessage[index])
  ) {
    throw new Error('The wallet signed a different message; refusing to use the signature');
  }
  return bs58.encode(result.signature);
}

export async function disconnectWallet(connected: ConnectedWallet | null): Promise<void> {
  if (!connected) return;
  if (connected.kind === 'phantom') {
    await connected.provider.disconnect().catch(() => undefined);
    return;
  }
  const feature = connected.wallet.features['standard:disconnect'] as StandardDisconnectFeature | undefined;
  await feature?.disconnect().catch(() => undefined);
}

export function observeWallet(connected: ConnectedWallet, onChange: (wallet: ConnectedWallet | null) => void): () => void {
  if (connected.kind === 'phantom') {
    const onDisconnect = () => onChange(null);
    const onAccountChanged = (next: unknown) => {
      const address = next ? String(next) : '';
      onChange(address ? { ...connected, address } : null);
    };
    connected.provider.on('disconnect', onDisconnect);
    connected.provider.on('accountChanged', onAccountChanged);
    return () => {
      connected.provider.off?.('disconnect', onDisconnect);
      connected.provider.off?.('accountChanged', onAccountChanged);
    };
  }

  const feature = connected.wallet.features['standard:events'] as StandardEventsFeature | undefined;
  if (!feature) return () => undefined;
  return feature.on('change', ({ accounts }) => {
    if (!accounts) return;
    const account =
      accounts.find((candidate) => candidate.address === connected.address) ??
      accounts.find(
        (candidate) =>
          candidate.chains.some((chain) => chain.startsWith('solana:')) &&
          candidate.features.includes(SolanaSignMessage),
      );
    if (!account) {
      onChange(null);
      return;
    }
    onChange({ ...connected, account, address: account.address });
  });
}

export async function sendSolFromWallet(params: {
  connected: ConnectedWallet;
  rpcUrl: string;
  fromPubkey: string;
  toPubkey: string;
  amountSol: number;
}): Promise<string> {
  if (params.connected.kind === 'phantom') {
    return sendSolFromPhantom({
      provider: params.connected.provider,
      rpcUrl: params.rpcUrl,
      fromPubkey: params.fromPubkey,
      toPubkey: params.toPubkey,
      amountSol: params.amountSol,
    });
  }

  const { wallet, account } = params.connected;
  const feature = wallet.features[SolanaSignAndSendTransaction] as
    | {
        signAndSendTransaction(...inputs: readonly {
          account: WalletAccount;
          transaction: Uint8Array;
          chain: string;
          options?: { commitment?: 'processed' | 'confirmed' | 'finalized' };
        }[]): Promise<readonly SignAndSendOutput[]>;
      }
    | undefined;
  if (!feature || !account.features.includes(SolanaSignAndSendTransaction)) {
    throw new Error(`${wallet.name} supports sign in but cannot send SOL transactions`);
  }
  const chain = account.chains.find((candidate) => candidate === 'solana:devnet');
  if (!chain) throw new Error(`${wallet.name} account is not connected to Solana Devnet`);

  const from = new PublicKey(params.fromPubkey);
  const to = new PublicKey(params.toPubkey);
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: to,
      lamports: solToLamports(params.amountSol),
    }),
  );
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = from;

  const [result] = await feature.signAndSendTransaction({
    account,
    transaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
    chain,
    options: { commitment: 'confirmed' },
  });
  if (!result) throw new Error(`${wallet.name} returned no transaction signature`);
  return bs58.encode(result.signature);
}
