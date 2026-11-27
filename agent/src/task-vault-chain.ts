import {
  Connection,
  Keypair,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

export async function submitTaskVaultInstruction(
  connection: Connection,
  instruction: TransactionInstruction | TransactionInstruction[],
  signer: Keypair,
  coSigners: Keypair[] = [],
  /** Adds the signature of a signer whose key lives elsewhere (the merchant worker), after the local signers. */
  remoteCoSign?: (transaction: Transaction) => Promise<void>,
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(...(Array.isArray(instruction) ? instruction : [instruction]));
  let signature: string;
  if (remoteCoSign) {
    transaction.partialSign(signer, ...coSigners);
    await remoteCoSign(transaction);
    signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  } else {
    signature = await connection.sendTransaction(transaction, [signer, ...coSigners], { maxRetries: 3 });
  }
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Task Vault transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}
