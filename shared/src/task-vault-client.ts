import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { TASK_VAULT_PROGRAM_ID, computeCanonicalSeed } from './task-vault.js';

export const TASK_VAULT_PROGRAM_PUBKEY = new PublicKey(TASK_VAULT_PROGRAM_ID);

// ------------------------------------------------------------- PDA Derivations

export function to32ByteArray(id: Uint8Array | string): Uint8Array {
  return computeCanonicalSeed(id);
}

export function deriveTaskCapabilityPda(
  owner: PublicKey,
  taskId: Uint8Array | string,
  programId = TASK_VAULT_PROGRAM_PUBKEY,
): [PublicKey, number] {
  const taskIdBytes = to32ByteArray(taskId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('capability'), owner.toBuffer(), taskIdBytes],
    programId,
  );
}

export function deriveVaultPda(
  taskCapabilityPda: PublicKey,
  programId = TASK_VAULT_PROGRAM_PUBKEY,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), taskCapabilityPda.toBuffer()],
    programId,
  );
}

export function deriveEscrowPda(
  taskCapabilityPda: PublicKey,
  paymentId: Uint8Array | string,
  programId = TASK_VAULT_PROGRAM_PUBKEY,
): [PublicKey, number] {
  const paymentIdBytes = to32ByteArray(paymentId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), taskCapabilityPda.toBuffer(), paymentIdBytes],
    programId,
  );
}

export function deriveReceiptPda(
  taskCapabilityPda: PublicKey,
  paymentId: Uint8Array | string,
  programId = TASK_VAULT_PROGRAM_PUBKEY,
): [PublicKey, number] {
  const paymentIdBytes = to32ByteArray(paymentId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), taskCapabilityPda.toBuffer(), paymentIdBytes],
    programId,
  );
}

// Receipt account: discriminator + 2 pubkeys + 4 x [u8; 32] + amount + settled_at + bump.
export const TASK_RECEIPT_ACCOUNT_SIZE = 8 + 32 + 32 + 32 * 4 + 8 + 8 + 1;

// -------------------------------------------------------- Instruction Builders

const DISCRIMINATORS = {
  create_and_fund_task: new Uint8Array([0, 142, 234, 27, 129, 198, 51, 254]),
  execute_task_payment: new Uint8Array([36, 128, 220, 0, 103, 204, 220, 163]),
  settle_with_receipt: new Uint8Array([88, 243, 178, 201, 225, 254, 125, 117]),
  revoke_task: new Uint8Array([188, 70, 249, 6, 56, 255, 109, 40]),
  refund_and_close: new Uint8Array([234, 86, 236, 241, 216, 155, 25, 84]),
  refund_expired_escrow: new Uint8Array([40, 9, 115, 148, 140, 7, 157, 160]),
  close_receipt: new Uint8Array([126, 254, 244, 203, 124, 164, 134, 89]),
};

export interface CreateAndFundTaskArgs {
  owner: PublicKey;
  agentSigner: PublicKey;
  taskId: Uint8Array | string;
  budgetLamports: number | bigint;
  perPaymentCapLamports: number | bigint;
  allowedWorker?: PublicKey;
  allowedServiceId?: Uint8Array | string;
  expirySeconds?: number | bigint;
  expiry?: number | bigint;
  programId?: PublicKey;
}

export function createAndFundTaskInstruction(args: CreateAndFundTaskArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const taskIdBytes = to32ByteArray(args.taskId);
  const [taskCapability] = deriveTaskCapabilityPda(args.owner, taskIdBytes, programId);
  const [vault] = deriveVaultPda(taskCapability, programId);

  // Layout follows CreateAndFundTaskParams, including zero-value allowlist defaults.
  const data = new Uint8Array(8 + 32 + 8 + 8 + 8 + 32 + 32 + 32);
  data.set(DISCRIMINATORS.create_and_fund_task, 0);
  data.set(taskIdBytes, 8);

  const expiry = args.expirySeconds ?? args.expiry;
  if (expiry === undefined) throw new Error('expiry or expirySeconds is required');

  const view = new DataView(data.buffer);
  view.setBigUint64(40, BigInt(args.budgetLamports), true);
  view.setBigUint64(48, BigInt(args.perPaymentCapLamports), true);
  view.setBigInt64(56, BigInt(expiry), true);
  data.set(args.agentSigner.toBuffer(), 64);
  data.set((args.allowedWorker ?? PublicKey.default).toBuffer(), 96);
  data.set(args.allowedServiceId ? to32ByteArray(args.allowedServiceId) : new Uint8Array(32), 128);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: taskCapability, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface ExecuteTaskPaymentArgs {
  taskCapability: PublicKey;
  owner?: PublicKey;
  agentSigner: PublicKey;
  worker: PublicKey;
  paymentId: Uint8Array | string;
  amountLamports: number | bigint;
  serviceId: Uint8Array | string;
  requestHash: Uint8Array | string;
  programId?: PublicKey;
}

export function executeTaskPaymentInstruction(args: ExecuteTaskPaymentArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const paymentIdBytes = to32ByteArray(args.paymentId);
  const serviceIdBytes = to32ByteArray(args.serviceId);
  const requestHashBytes = to32ByteArray(args.requestHash);
  const [vault] = deriveVaultPda(args.taskCapability, programId);
  const [escrow] = deriveEscrowPda(args.taskCapability, paymentIdBytes, programId);
  const [receipt] = deriveReceiptPda(args.taskCapability, paymentIdBytes, programId);

  // Layout: discriminator(8) + payment_id(32) + amount_lamports(8) + service_id(32) + request_hash(32)
  const data = new Uint8Array(8 + 32 + 8 + 32 + 32);
  data.set(DISCRIMINATORS.execute_task_payment, 0);
  data.set(paymentIdBytes, 8);

  const view = new DataView(data.buffer);
  view.setBigUint64(40, BigInt(args.amountLamports), true);
  data.set(serviceIdBytes, 48);
  data.set(requestHashBytes, 80);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: false },
      { pubkey: args.worker, isSigner: false, isWritable: false },
      { pubkey: args.agentSigner, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface SettleWithReceiptArgs {
  taskCapability: PublicKey;
  escrow: PublicKey;
  paymentId: Uint8Array | string;
  worker: PublicKey;
  agentSigner?: PublicKey;
  owner?: PublicKey;
  resultHash: Uint8Array | string;
  programId?: PublicKey;
}

export function settleWithReceiptInstruction(args: SettleWithReceiptArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const paymentIdBytes = to32ByteArray(args.paymentId);
  const resultHashBytes = to32ByteArray(args.resultHash);
  const [receipt] = deriveReceiptPda(args.taskCapability, paymentIdBytes, programId);

  // Layout: discriminator(8) + result_hash(32)
  const data = new Uint8Array(8 + 32);
  data.set(DISCRIMINATORS.settle_with_receipt, 0);
  data.set(resultHashBytes, 8);

  const rentRecipient = args.agentSigner ?? args.owner;
  if (!rentRecipient) throw new Error('agentSigner or owner is required for settleWithReceiptInstruction');

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: args.escrow, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: args.worker, isSigner: true, isWritable: true },
      { pubkey: rentRecipient, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface RevokeTaskArgs {
  taskCapability: PublicKey;
  owner: PublicKey;
  programId?: PublicKey;
}

export function revokeTaskInstruction(args: RevokeTaskArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const data = new Uint8Array(8);
  data.set(DISCRIMINATORS.revoke_task, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface RefundAndCloseArgs {
  taskCapability: PublicKey;
  owner: PublicKey;
  caller: PublicKey;
  programId?: PublicKey;
}

export function refundAndCloseInstruction(args: RefundAndCloseArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const [vault] = deriveVaultPda(args.taskCapability, programId);
  const data = new Uint8Array(8);
  data.set(DISCRIMINATORS.refund_and_close, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: true },
      { pubkey: args.caller, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface RefundExpiredEscrowArgs {
  taskCapability: PublicKey;
  escrow: PublicKey;
  owner: PublicKey;
  agentSigner: PublicKey;
  caller: PublicKey;
  programId?: PublicKey;
}

export function refundExpiredEscrowInstruction(args: RefundExpiredEscrowArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const data = new Uint8Array(8);
  data.set(DISCRIMINATORS.refund_expired_escrow, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: args.escrow, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: true },
      { pubkey: args.agentSigner, isSigner: false, isWritable: true },
      { pubkey: args.caller, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface CloseReceiptArgs {
  taskCapability: PublicKey;
  receipt: PublicKey;
  rentRecipient: PublicKey;
  authority: PublicKey;
  programId?: PublicKey;
}

export function closeReceiptInstruction(args: CloseReceiptArgs): TransactionInstruction {
  const programId = args.programId ?? TASK_VAULT_PROGRAM_PUBKEY;
  const data = new Uint8Array(8);
  data.set(DISCRIMINATORS.close_receipt, 0);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: args.taskCapability, isSigner: false, isWritable: true },
      { pubkey: args.receipt, isSigner: false, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.rentRecipient, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}
