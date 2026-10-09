import type { FastifyInstance } from 'fastify';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  computeOutputHash, computeTaskAcceptanceMessage, deriveTaskCapabilityPda, deriveEscrowPda,
  type TaskCapabilityRecord, type TaskPaymentRecord,
} from '@nexus/shared';

export function acceptanceSignature(task: TaskCapabilityRecord, payment: TaskPaymentRecord, resultHash: string, ownerSecretKey: Uint8Array): string {
  const [taskCapability] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
  const [escrow] = deriveEscrowPda(taskCapability, payment.paymentId);
  const message = computeTaskAcceptanceMessage({ taskCapability, escrow, requestHash: payment.requestHash, resultHash, amountLamports: payment.amountLamports });
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), ownerSecretKey));
}

export async function submitOutput(app: FastifyInstance, cookie: string, taskId: string, paymentId: string, workerSecretKey: Uint8Array, ownerSecretKey: Uint8Array, resultPayload: Record<string, unknown>) {
  const resultHash = computeOutputHash(resultPayload);
  const workerPubkey = bs58.encode(nacl.sign.keyPair.fromSecretKey(workerSecretKey).publicKey);
  const workerSignature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:${paymentId}:${resultHash}`), workerSecretKey));
  const response = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/${paymentId}/output`, headers: { cookie }, payload: { resultHash, resultPayload, workerPubkey, workerSignature } });
  if (response.statusCode !== 200) throw new Error(`Output submission failed: ${response.body}`);
  const detail = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: { cookie } })).json();
  const payment = detail.payments.find((item: TaskPaymentRecord) => item.paymentId === paymentId);
  return { resultHash, workerPubkey, workerSignature, ownerSignature: acceptanceSignature(detail.task, payment, resultHash, ownerSecretKey) };
}
