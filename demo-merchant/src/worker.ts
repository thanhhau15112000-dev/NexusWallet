import { Ed25519Program, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  DISCRIMINATORS,
  TASK_VAULT_PROGRAM_PUBKEY,
  computeCanonicalSeed,
  computeOutputHash,
  decodeEscrowAccount,
  deriveEscrowPda,
  deriveTaskCapabilityPda,
  type OnChainEscrow,
} from '@nexus/shared';

/**
 * The merchant as a Task Vault worker. It only works for an escrow that is already
 * held on-chain for its own key, signs the output it delivers, and co-signs the
 * settlement that pays it. Its key is separate from the x402 receiving wallet.
 */
export interface WorkerEnv {
  /** Worker secret: base58 64-byte secret key of the worker signer. */
  WORKER_SECRET_KEY?: string;
  SOLANA_RPC_URL?: string;
}

export const WORKER_SERVICE_LABEL = 'nexusPay demo merchant';

export class WorkerError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export function workerKeypair(env: WorkerEnv): Keypair | null {
  if (!env.WORKER_SECRET_KEY) return null;
  return Keypair.fromSecretKey(bs58.decode(env.WORKER_SECRET_KEY.trim()));
}

function requireWorker(env: WorkerEnv): Keypair {
  const keypair = workerKeypair(env);
  if (!keypair) throw new WorkerError(503, 'worker_not_configured');
  if (!env.SOLANA_RPC_URL) throw new WorkerError(503, 'rpc_not_configured');
  return keypair;
}

async function readEscrow(env: WorkerEnv, escrow: PublicKey): Promise<OnChainEscrow | null> {
  const res = await fetch(env.SOLANA_RPC_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [escrow.toBase58(), { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const json = (await res.json()) as {
    result?: { value: { owner: string; data: [string, string] } | null };
    error?: { message?: string };
  };
  if (json.error || !json.result) throw new WorkerError(502, 'rpc_failed', json.error?.message);
  const account = json.result.value;
  if (!account || account.owner !== TASK_VAULT_PROGRAM_PUBKEY.toBase58()) return null;
  return decodeEscrowAccount(Uint8Array.from(atob(account.data[0]), (c) => c.charCodeAt(0)));
}

/** The escrow must be held on-chain for this worker before it does any work or signs anything. */
function assertHeldForWorker(escrow: OnChainEscrow | null, worker: PublicKey): OnChainEscrow {
  if (!escrow) throw new WorkerError(404, 'escrow_not_found');
  if (!escrow.worker.equals(worker)) throw new WorkerError(403, 'escrow_not_for_this_worker');
  if (escrow.status !== 'held') throw new WorkerError(409, 'escrow_not_held');
  return escrow;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export type JobRequest = {
  owner: string;
  taskId: string;
  paymentId: string;
  serviceId: string;
  requestHash: string;
  /** Demo control: `invalid_schema` makes the worker deliver a failed output on purpose. */
  scenario?: 'valid' | 'invalid_schema';
};

export async function runJob(env: WorkerEnv, job: JobRequest) {
  const keypair = requireWorker(env);
  let taskPda: PublicKey;
  try {
    [taskPda] = deriveTaskCapabilityPda(new PublicKey(job.owner), job.taskId);
  } catch {
    throw new WorkerError(400, 'invalid_job');
  }
  const [escrowPda] = deriveEscrowPda(taskPda, job.paymentId);
  const escrow = assertHeldForWorker(await readEscrow(env, escrowPda), keypair.publicKey);
  if (!sameBytes(escrow.serviceId, computeCanonicalSeed(job.serviceId))) throw new WorkerError(409, 'service_mismatch');
  if (!sameBytes(escrow.requestHash, computeCanonicalSeed(job.requestHash))) throw new WorkerError(409, 'request_mismatch');

  const resultPayload: Record<string, unknown> = job.scenario === 'invalid_schema'
    ? {
        status: 'failed',
        serviceId: job.serviceId,
        requestHash: job.requestHash,
        evaluatedAt: 'invalid-timestamp',
        outputSummary: '',
        error: 'worker_output_incomplete',
      }
    : {
        status: 'completed',
        serviceId: job.serviceId,
        requestHash: job.requestHash,
        evaluatedAt: new Date().toISOString(),
        worker: WORKER_SERVICE_LABEL,
        outputSummary: `${WORKER_SERVICE_LABEL} completed ${job.serviceId} for escrow ${escrowPda.toBase58()}`,
      };
  const resultHash = computeOutputHash(resultPayload);
  const message = new TextEncoder().encode(`NEXUS_RECEIPT_V1:${job.taskId}:${job.paymentId}:${resultHash}`);
  return {
    workerPubkey: keypair.publicKey.toBase58(),
    workerSignature: bs58.encode(nacl.sign.detached(message, keypair.secretKey)),
    resultHash,
    resultPayload,
  };
}

/**
 * Co-signs a settlement the agent built. The transaction must be exactly the owner's
 * ed25519 acceptance followed by settle for an escrow held for this worker, with the
 * agent paying the fee, so the worker key cannot be used for anything else.
 */
export async function signSettlement(env: WorkerEnv, transactionBase64: string) {
  const keypair = requireWorker(env);
  let transaction: Transaction;
  try {
    transaction = Transaction.from(Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0)));
  } catch {
    throw new WorkerError(400, 'invalid_transaction');
  }
  const worker = keypair.publicKey;
  const [acceptance, settle] = transaction.instructions;
  if (!transaction.feePayer || transaction.feePayer.equals(worker)) throw new WorkerError(400, 'worker_cannot_pay_fee');
  if (
    transaction.instructions.length !== 2
    || !acceptance!.programId.equals(Ed25519Program.programId)
    || !settle!.programId.equals(TASK_VAULT_PROGRAM_PUBKEY)
    || !sameBytes(settle!.data.subarray(0, 8), DISCRIMINATORS.settle_accepted_output)
  ) {
    throw new WorkerError(400, 'not_a_settlement');
  }
  if (!settle!.keys[3]?.pubkey.equals(worker)) throw new WorkerError(403, 'settlement_not_for_this_worker');
  assertHeldForWorker(await readEscrow(env, settle!.keys[1]!.pubkey), worker);

  transaction.partialSign(keypair);
  const signature = transaction.signatures.find((entry) => entry.publicKey.equals(worker))?.signature;
  if (!signature) throw new WorkerError(500, 'signing_failed');
  return { workerPubkey: worker.toBase58(), signature: bs58.encode(signature) };
}
