import {
  Connection,
  Keypair,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

export async function submitTaskVaultInstruction(
  connection: Connection,
  instruction: TransactionInstruction,
  signer: Keypair,
): Promise<string> {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(instruction);
  const signature = await connection.sendTransaction(transaction, [signer], { maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Task Vault transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}
