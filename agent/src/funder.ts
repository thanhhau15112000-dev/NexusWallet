import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Keypair } from '@solana/web3.js';
import { loadOrCreateAgentKey } from './crypto.js';
import { getLamportBalance, keypairFromSecret, transferSol, type Connection } from './chain.js';

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

export function dispenseInitialSeed(params: {
  connection: Connection;
  funder: Keypair;
  recipientPubkey: string;
  amountLamports: number;
}): Promise<{ signature: string; slot: number | null }> {
  const op = funderQueue.then(async () => {
    const funderPubkey = params.funder.publicKey.toBase58();
    const balance = await getLamportBalance(params.connection, funderPubkey);
    // Estimate transaction fee ~5000 lamports
    if (balance < params.amountLamports + 5000) {
      throw new Error(
        `Master Funder wallet (${funderPubkey}) does not have enough Devnet SOL (${balance / 1e9} SOL available). Please fund it.`,
      );
    }

    return transferSol({
      connection: params.connection,
      payer: params.funder,
      recipient: params.recipientPubkey,
      lamports: params.amountLamports,
    });
  });

  funderQueue = op.catch(() => {});
  return op;
}
