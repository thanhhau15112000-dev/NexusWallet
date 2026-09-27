import { z } from 'zod';
import { PubkeySchema } from './contract.js';

export const TASK_VAULT_DOMAIN_SEPARATOR = 'NEXUS_TASK_VAULT_V1';
export const TASK_VAULT_PROGRAM_ID = '3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK';

// ----------------------------------------------------------- status schemas

export const TASK_STATUSES = ['active', 'completed', 'revoked', 'expired'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TaskStatusSchema = z.enum(TASK_STATUSES);

export const ESCROW_STATUSES = ['held', 'settled', 'refunded'] as const;
export type EscrowStatus = (typeof ESCROW_STATUSES)[number];
export const EscrowStatusSchema = z.enum(ESCROW_STATUSES);

// ----------------------------------------------------------- records

export const TaskCapabilityRecordSchema = z.object({
  owner: PubkeySchema,
  agentSigner: PubkeySchema,
  taskId: z.string().trim().min(1).max(64),
  budgetLamports: z.number().int().positive(),
  spentLamports: z.number().int().nonnegative().default(0),
  perPaymentCapLamports: z.number().int().positive(),
  expiry: z.number().int().positive(),
  status: TaskStatusSchema.default('active'),
  allowedWorker: PubkeySchema.optional(),
  allowedServiceId: z.string().trim().min(1).max(64).optional(),
  pda: PubkeySchema.optional(),
  vaultPda: PubkeySchema.optional(),
  txSignature: z.string().optional(),
  isSimulated: z.boolean().optional(),
  isClosed: z.boolean().optional(),
});

export type TaskCapabilityRecord = z.infer<typeof TaskCapabilityRecordSchema>;

export const TaskPaymentRecordSchema = z.object({
  taskId: z.string().trim().min(1).max(64),
  paymentId: z.string().trim().min(1).max(64),
  worker: PubkeySchema,
  serviceId: z.string().trim().min(1).max(64),
  amountLamports: z.number().int().positive(),
  requestHash: z.string().trim().min(1),
  status: EscrowStatusSchema.default('held'),
  escrowPda: PubkeySchema.optional(),
  txSignature: z.string().optional(),
  isSimulated: z.boolean().optional(),
  createdAt: z.string().datetime().optional(),
});

export type TaskPaymentRecord = z.infer<typeof TaskPaymentRecordSchema>;

export const TaskReceiptRecordSchema = z.object({
  taskId: z.string().trim().min(1).max(64),
  paymentId: z.string().trim().min(1).max(64),
  worker: PubkeySchema,
  serviceId: z.string().trim().min(1).max(64),
  requestHash: z.string().trim().min(1),
  resultHash: z.string().trim().min(1),
  amountLamports: z.number().int().positive(),
  settledAt: z.number().int().positive(),
  receiptPda: PubkeySchema.optional(),
  txSignature: z.string().optional(),
  isSimulated: z.boolean().optional(),
  isClosed: z.boolean().optional(),
  closeTxSignature: z.string().optional(),
});

export type TaskReceiptRecord = z.infer<typeof TaskReceiptRecordSchema>;

// ----------------------------------------------------------- state machine

export type TaskTransition =
  | { type: 'execute_payment'; amountLamports: number; worker?: string; serviceId?: string }
  | { type: 'settle_payment'; paymentId: string; remainingPendingEscrows?: number }
  | { type: 'revoke' }
  | { type: 'expire' }
  | { type: 'refund_and_close' };

/**
 * State Transition Table:
 *
 * Current State | Action               | Condition                            | Next State
 * --------------|----------------------|--------------------------------------|------------
 * active        | execute_payment      | spent + amount <= budget & cap ok    | active
 * active        | settle_payment       | valid receipt; if spent == budget & pending == 0 | completed
 * active        | settle_payment       | valid receipt; if spent < budget or pending > 0   | active
 * active        | revoke               | owner signer                         | revoked
 * revoked       | settle_payment       | held escrow, now < expiry            | revoked
 * active        | expire               | now >= expiry                        | expired
 * active        | refund_and_close     | owner signer                         | closed
 * revoked       | refund_and_close     | owner or permissionless              | closed
 * expired       | refund_and_close     | permissionless relayer or owner      | closed
 * completed     | refund_and_close     | owner or permissionless              | closed
 */
export function validateTaskTransition(
  task: {
    status: TaskStatus;
    expiry: number;
    budgetLamports: number;
    spentLamports: number;
    perPaymentCapLamports: number;
    allowedWorker?: string;
    allowedServiceId?: string;
    pendingEscrows?: number;
  },
  transition: TaskTransition,
  nowSeconds: number,
): { valid: boolean; nextStatus?: TaskStatus | 'closed'; error?: string } {
  // If time has passed expiry, task is effectively expired for payments/settlements
  if (transition.type !== 'refund_and_close' && transition.type !== 'expire') {
    if (nowSeconds >= task.expiry) {
      return { valid: false, error: 'task has expired' };
    }
  }

  switch (transition.type) {
    case 'execute_payment': {
      if (task.status !== 'active') {
        return { valid: false, error: `cannot execute payment in ${task.status} state` };
      }
      if (transition.amountLamports <= 0) {
        return { valid: false, error: 'payment amount must be positive' };
      }
      if (transition.amountLamports > task.perPaymentCapLamports) {
        return { valid: false, error: 'payment amount exceeds per-payment cap' };
      }
      if (task.spentLamports + transition.amountLamports > task.budgetLamports) {
        return { valid: false, error: 'payment amount exceeds remaining budget' };
      }
      if (task.allowedWorker && transition.worker && transition.worker !== task.allowedWorker) {
        return { valid: false, error: `worker ${transition.worker} is not allowed by task capability` };
      }
      if (task.allowedServiceId && transition.serviceId && transition.serviceId !== task.allowedServiceId) {
        return { valid: false, error: `service ${transition.serviceId} is not allowed by task capability` };
      }
      return { valid: true, nextStatus: 'active' };
    }

    case 'settle_payment': {
      // Revoke blocks new payments only; escrows already held stay settleable until expiry.
      if (task.status === 'revoked') {
        return { valid: true, nextStatus: 'revoked' };
      }
      if (task.status !== 'active') {
        return { valid: false, error: `cannot settle payment in ${task.status} state` };
      }
      const remainingPending =
        transition.remainingPendingEscrows ??
        (task.pendingEscrows !== undefined ? Math.max(0, task.pendingEscrows - 1) : 0);
      const isBudgetFullySpent = task.spentLamports >= task.budgetLamports;
      const isCompleted = isBudgetFullySpent && remainingPending === 0;
      return { valid: true, nextStatus: isCompleted ? 'completed' : 'active' };
    }

    case 'revoke': {
      if (task.status !== 'active') {
        return { valid: false, error: `cannot revoke task in ${task.status} state` };
      }
      return { valid: true, nextStatus: 'revoked' };
    }

    case 'expire': {
      if (task.status !== 'active') {
        return { valid: false, error: `cannot expire task in ${task.status} state` };
      }
      if (nowSeconds < task.expiry) {
        return { valid: false, error: 'task expiry time has not arrived yet' };
      }
      return { valid: true, nextStatus: 'expired' };
    }

    case 'refund_and_close': {
      return { valid: true, nextStatus: 'closed' };
    }
  }
}

// ----------------------------------------------------------- pure SHA-256

/** Lightweight, zero-dependency, pure JavaScript SHA-256 for deterministic cross-platform hashing */
export function sha256Sync(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const length = data.length;
  const bitLength = length * 8;
  const paddingLength = (length % 64 < 56) ? 56 - (length % 64) : 120 - (length % 64);
  const totalLength = length + paddingLength + 8;
  const padded = new Uint8Array(totalLength);
  padded.set(data);
  padded[length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setBigUint64(totalLength - 8, BigInt(bitLength), false);

  const w = new Uint32Array(64);
  for (let i = 0; i < totalLength; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const wt15 = w[t - 15] ?? 0;
      const wt2 = w[t - 2] ?? 0;
      const wt16 = w[t - 16] ?? 0;
      const wt7 = w[t - 7] ?? 0;
      const s0 = ((wt15 >>> 7) | (wt15 << 25)) ^ ((wt15 >>> 18) | (wt15 << 14)) ^ (wt15 >>> 3);
      const s1 = ((wt2 >>> 17) | (wt2 << 15)) ^ ((wt2 >>> 19) | (wt2 << 13)) ^ (wt2 >>> 10);
      w[t] = (wt16 + s0 + wt7 + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const kt = K[t] ?? 0;
      const wt = w[t] ?? 0;
      const temp1 = (h + S1 + ch + kt + wt) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const outView = new DataView(result.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return result;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Computes a collision-free, deterministic 32-byte seed for Solana PDAs and program parameters.
 * - If input is already a 32-byte Uint8Array, it is returned directly.
 * - If input is a 64-char hex string, it is decoded into 32 bytes.
 * - Otherwise, computes domain-separated SHA-256 (`NEXUS_SEED_V1:<utf8>`).
 * This prevents byte truncation collisions for long IDs.
 */
export function computeCanonicalSeed(id: Uint8Array | string): Uint8Array {
  if (id instanceof Uint8Array && id.length === 32) return id;
  if (typeof id === 'string') {
    if (/^[0-9a-fA-F]{64}$/.test(id)) {
      return fromHex(id);
    }
    const encoder = new TextEncoder();
    return sha256Sync(encoder.encode(`NEXUS_SEED_V1:${id}`));
  }
  return sha256Sync(id);
}

/** Canonical message signed by worker upon completing a payment request */
export function computeReceiptSigningMessage(
  taskId: string,
  paymentId: string,
  resultHash: string,
): Uint8Array {
  const canonical = `NEXUS_RECEIPT_V1:${taskId}:${paymentId}:${resultHash}`;
  return new TextEncoder().encode(canonical);
}

export const DEFAULT_MOCK_WORKER_PUBKEY = '7qrs9D4MrTyR1qN3EqkYuW8RBYVEuWzKqa5dYhphQe44';

// ----------------------------------------------------------- hashing & vectors

export interface TaskHashInput {
  owner: string;
  taskId: string;
  budgetLamports: number;
  perPaymentCapLamports: number;
  expiry: number;
  domainSeparator?: string;
}

/**
 * Computes canonical task hash binding:
 * domainSeparator:task:owner:taskId:budgetLamports:perPaymentCapLamports:expiry
 */
export function computeTaskHash(input: TaskHashInput): string {
  const domain = input.domainSeparator ?? TASK_VAULT_DOMAIN_SEPARATOR;
  const canonical = `${domain}:task:${input.owner}:${input.taskId}:${input.budgetLamports}:${input.perPaymentCapLamports}:${input.expiry}`;
  const encoder = new TextEncoder();
  const bytes = sha256Sync(encoder.encode(canonical));
  return toHex(bytes);
}

export interface ReceiptHashInput {
  taskId: string;
  paymentId: string;
  worker: string;
  serviceId: string;
  requestHash: string;
  resultHash: string;
  amountLamports: number;
  domainSeparator?: string;
}

/**
 * Computes canonical receipt hash binding:
 * domainSeparator:receipt:taskId:paymentId:worker:serviceId:requestHash:resultHash:amountLamports
 */
export function computeReceiptHash(input: ReceiptHashInput): string {
  const domain = input.domainSeparator ?? TASK_VAULT_DOMAIN_SEPARATOR;
  const canonical = `${domain}:receipt:${input.taskId}:${input.paymentId}:${input.worker}:${input.serviceId}:${input.requestHash}:${input.resultHash}:${input.amountLamports}`;
  const encoder = new TextEncoder();
  const bytes = sha256Sync(encoder.encode(canonical));
  return toHex(bytes);
}
