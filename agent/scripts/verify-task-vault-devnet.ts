import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TASK_VAULT_PROGRAM_PUBKEY,
  closeReceiptInstruction,
  createAndFundTaskInstruction,
  deriveEscrowPda,
  deriveReceiptPda,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  executeTaskPaymentInstruction,
  refundAndCloseInstruction,
  refundExpiredEscrowInstruction,
  revokeTaskInstruction,
  settleWithReceiptInstruction,
} from '@nexus/shared';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const RPC_URL = process.env.HELIUS_DEVNET_RPC || process.env.SOLANA_RPC_URL;
const OWNER_ADDRESS = '3tQvQJYSbgTa3aR2kbeMkbfEHM9QhggJ197rdFAQ4Fgx';
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// Single-signature legacy transaction fee; draining to exactly zero avoids the rent-paying state check.
const TX_FEE_LAMPORTS = 5_000;
// TaskCapability.status offset: discriminator + owner + agent_signer + task_id + 4 x u64/i64.
const TASK_STATUS_OFFSET = 136;
const TASK_STATUS_ACTIVE = 0;

// Anchor custom error codes (6000 + enum index in errors.rs).
const ERR = {
  TaskNotActive: '0x1773',
  TaskExpired: '0x1774',
  TaskNotExpired: '0x1775',
  ExceedsPaymentCap: '0x1776',
  ExceedsTaskBudget: '0x1777',
  UnauthorizedSigner: '0x1779',
  UnauthorizedWorker: '0x177a',
  UnauthorizedService: '0x177b',
  PaymentIdAlreadyUsed: '0x1781',
  ReceiptLockedWhileTaskActive: '0x1782',
  InvalidAllowedWorker: '0x1783',
  AccountNotInitialized: '0xbc4',
} as const;

if (!RPC_URL) throw new Error('Set HELIUS_DEVNET_RPC or SOLANA_RPC_URL');

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 45_000,
});
const keypairPath = process.env.SOLANA_KEYPAIR_PATH
  ?? join(homedir(), '.config', 'solana', 'id.json');
const ownerSecret = JSON.parse(readFileSync(keypairPath, 'utf8')) as number[];
const owner = Keypair.fromSecretKey(Uint8Array.from(ownerSecret));
if (owner.publicKey.toBase58() !== OWNER_ADDRESS) {
  throw new Error(`Unexpected owner keypair: ${owner.publicKey.toBase58()}`);
}

const agent = Keypair.generate();
const worker = Keypair.generate();
const SERVICE_ID = 'issue-6-devnet-verification';
const signatures: string[] = [];
const failedSignatures: string[] = [];
type ProbeTask = {
  id: string;
  capability: PublicKey;
  vault: PublicKey;
  expiry: number;
  paymentIds: string[];
};
const tasks: ProbeTask[] = [];
const receipts: PublicKey[] = [];

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

async function submit(
  operation: string,
  instruction: TransactionInstruction,
  feePayer: Keypair,
): Promise<string> {
  const blockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash.blockhash,
  }).add(instruction);
  transaction.sign(feePayer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    maxRetries: 5,
    preflightCommitment: 'confirmed',
  });
  const confirmation = await connection.confirmTransaction({
    signature,
    ...blockhash,
  }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`${operation} failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  signatures.push(signature);
  console.log(`TX ${operation}=${signature}`);
  return signature;
}

async function expectRejected(
  operation: string,
  instruction: TransactionInstruction,
  feePayer: Keypair,
  code: string,
): Promise<void> {
  const blockhash = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: feePayer.publicKey,
    recentBlockhash: blockhash.blockhash,
  }).add(instruction);
  transaction.sign(feePayer);
  const result = await connection.simulateTransaction(transaction, [feePayer]);
  const logs = (result.value.logs ?? []).join('\n');
  const summary = logs.split('\n').filter((line) => /error|failed/i.test(line)).join(' | ');
  console.log(`SIM ${operation} err=${JSON.stringify(result.value.err)} ${summary}`);
  if (result.value.err === null || !logs.toLowerCase().includes(code.toLowerCase())) {
    throw new Error(`${operation} was not rejected with ${code}`);
  }

  // Land the rejected transaction too, so the failure path has an explorer-verifiable signature.
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
  const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, 'confirmed');
  if (confirmation.value.err === null) throw new Error(`${operation} landed without an error`);
  failedSignatures.push(signature);
  console.log(`FAILTX ${operation}=${signature} err=${JSON.stringify(confirmation.value.err)}`);
}

function paymentIx(
  task: ProbeTask,
  paymentId: string,
  amountLamports: number,
  options: { serviceId?: string; worker?: PublicKey; agentSigner?: PublicKey } = {},
): TransactionInstruction {
  return executeTaskPaymentInstruction({
    taskCapability: task.capability,
    agentSigner: options.agentSigner ?? agent.publicKey,
    worker: options.worker ?? worker.publicKey,
    paymentId,
    amountLamports,
    serviceId: options.serviceId ?? SERVICE_ID,
    requestHash: digest(`request:${paymentId}`),
  });
}

function settleIx(task: ProbeTask, paymentId: string): TransactionInstruction {
  return settleWithReceiptInstruction({
    taskCapability: task.capability,
    escrow: deriveEscrowPda(task.capability, paymentId)[0],
    paymentId,
    worker: worker.publicKey,
    agentSigner: agent.publicKey,
    resultHash: digest(`result:${paymentId}`),
  });
}

function closeReceiptIx(task: ProbeTask, paymentId: string): TransactionInstruction {
  return closeReceiptInstruction({
    taskCapability: task.capability,
    receipt: deriveReceiptPda(task.capability, paymentId)[0],
    authority: worker.publicKey,
    rentRecipient: worker.publicKey,
  });
}

async function executePayment(task: ProbeTask, label: string, amountLamports: number): Promise<string> {
  const paymentId = `payment-${label}-${randomUUID()}`;
  task.paymentIds.push(paymentId);
  await submit(`execute-${label}`, paymentIx(task, paymentId, amountLamports), agent);
  return paymentId;
}

async function createTask(
  label: string,
  budgetLamports: number,
  capLamports: number,
  expirySeconds: number,
): Promise<ProbeTask> {
  const id = `issue6-${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const [capability] = deriveTaskCapabilityPda(owner.publicKey, id);
  const [vault] = deriveVaultPda(capability);
  const task: ProbeTask = {
    id,
    capability,
    vault,
    expiry: Math.floor(Date.now() / 1000) + expirySeconds,
    paymentIds: [],
  };
  tasks.push(task);
  await submit(`create-${label}`, createAndFundTaskInstruction({
    owner: owner.publicKey,
    agentSigner: agent.publicKey,
    taskId: id,
    budgetLamports,
    perPaymentCapLamports: capLamports,
    allowedWorker: worker.publicKey,
    allowedServiceId: SERVICE_ID,
    expiry: task.expiry,
  }), owner);
  console.log(`TASK ${label} capability=${capability.toBase58()} vault=${vault.toBase58()}`);
  return task;
}

async function waitForOnChainTime(unixSeconds: number): Promise<void> {
  // Program checks use the Clock sysvar, which can lag local wall-clock time on Devnet.
  for (;;) {
    const slot = await connection.getSlot('confirmed');
    const blockTime = await connection.getBlockTime(slot).catch(() => null);
    if (blockTime !== null && blockTime > unixSeconds) return;
    console.log(`WAIT chainTime=${blockTime ?? 'unknown'} target>${unixSeconds}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function transfer(from: Keypair, to: PublicKey, lamports: number, operation: string): Promise<void> {
  await submit(operation, SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports,
  }), from);
}

async function bestEffort(operation: string, action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    console.error(`CLEANUP_FAILED ${operation}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function cleanTask(task: ProbeTask): Promise<boolean> {
  let ok = true;
  const capability = await connection.getAccountInfo(task.capability, 'confirmed');
  if (capability && capability.data[TASK_STATUS_OFFSET] === TASK_STATUS_ACTIVE) {
    // Receipts can only be closed after the task stops accepting payments.
    ok = await bestEffort(`revoke-${task.id}`, () => submit(`cleanup-revoke-${task.id}`, revokeTaskInstruction({
      taskCapability: task.capability,
      owner: owner.publicKey,
    }), owner)) && ok;
  }

  for (const paymentId of task.paymentIds) {
    const [escrow] = deriveEscrowPda(task.capability, paymentId);
    const [receipt] = deriveReceiptPda(task.capability, paymentId);
    if (await connection.getAccountInfo(escrow, 'confirmed')) {
      // Held escrows belong to the worker until expiry; afterwards anyone can refund them.
      const expired = Math.floor(Date.now() / 1000) > task.expiry;
      ok = await bestEffort(`resolve-escrow-${paymentId}`, () => (expired
        ? submit(`cleanup-escrow-${paymentId}`, refundExpiredEscrowInstruction({
          taskCapability: task.capability,
          escrow,
          owner: owner.publicKey,
          agentSigner: agent.publicKey,
          caller: owner.publicKey,
        }), owner)
        : submit(`cleanup-settle-${paymentId}`, settleIx(task, paymentId), worker))) && ok;
    }
    if (await connection.getAccountInfo(receipt, 'confirmed')) {
      ok = await bestEffort(`close-receipt-${paymentId}`, () => submit(`cleanup-receipt-${paymentId}`, closeReceiptIx(task, paymentId), worker)) && ok;
    }
  }

  if (await connection.getAccountInfo(task.capability, 'confirmed')) {
    ok = await bestEffort(`close-task-${task.id}`, () => submit(`cleanup-task-${task.id}`, refundAndCloseInstruction({
      taskCapability: task.capability,
      owner: owner.publicKey,
      caller: owner.publicKey,
    }), owner)) && ok;
  }

  const accounts = [
    task.capability,
    task.vault,
    ...task.paymentIds.flatMap((paymentId) => [
      deriveEscrowPda(task.capability, paymentId)[0],
      deriveReceiptPda(task.capability, paymentId)[0],
    ]),
  ];
  const remaining = await Promise.all(accounts.map((account) => connection.getAccountInfo(account, 'confirmed')));
  const closed = remaining.every((account) => account === null);
  console.log(`CLEANUP ${task.id} closed=${closed}`);
  return ok && closed;
}

async function returnBalance(keypair: Keypair, label: string): Promise<boolean> {
  const balance = await connection.getBalance(keypair.publicKey, 'confirmed');
  const amount = balance - TX_FEE_LAMPORTS;
  if (amount <= 0) return true;
  return bestEffort(`return-${label}`, () => transfer(keypair, owner.publicKey, amount, `return-${label}`));
}

async function main(): Promise<void> {
  const version = await connection.getVersion();
  const cluster = await connection.getGenesisHash() === DEVNET_GENESIS_HASH ? 'devnet' : 'non-devnet';
  const program = await connection.getAccountInfo(TASK_VAULT_PROGRAM_PUBKEY, 'confirmed');
  if (!program?.executable) throw new Error('Task Vault program is absent or not executable on configured RPC');
  const ownerBalance = await connection.getBalance(owner.publicKey, 'confirmed');
  if (ownerBalance < 100_000_000) throw new Error('Owner requires at least 0.1 SOL for this Devnet probe');
  console.log(`PREFLIGHT cluster=${cluster} version=${version['solana-core']} program=${TASK_VAULT_PROGRAM_PUBKEY.toBase58()} owner=${owner.publicKey.toBase58()} balance=${ownerBalance}`);

  await transfer(owner, agent.publicKey, 20_000_000, 'fund-agent');
  await transfer(owner, worker.publicKey, 20_000_000, 'fund-worker');

  // Flow task: budget 8M, cap 4M; two valid 3M payments leave 2M so an over-budget amount stays under the cap.
  await expectRejected('create-without-allowed-worker', createAndFundTaskInstruction({
    owner: owner.publicKey,
    agentSigner: agent.publicKey,
    taskId: `issue6-noworker-${randomUUID().slice(0, 8)}`,
    budgetLamports: 1_000_000,
    perPaymentCapLamports: 1_000_000,
    allowedServiceId: SERVICE_ID,
    expiry: Math.floor(Date.now() / 1000) + 600,
  }), owner, ERR.InvalidAllowedWorker);

  const flow = await createTask('flow', 8_000_000, 4_000_000, 900);
  const pay1 = await executePayment(flow, 'payment-1', 3_000_000);
  const pay2 = await executePayment(flow, 'payment-2', 3_000_000);

  await expectRejected('over-per-payment-cap', paymentIx(flow, 'cap-fail', 4_000_001), agent, ERR.ExceedsPaymentCap);
  await expectRejected('over-total-task-budget', paymentIx(flow, 'budget-fail', 2_000_001), agent, ERR.ExceedsTaskBudget);
  await expectRejected('unauthorized-service-id', paymentIx(flow, 'service-fail', 1, { serviceId: 'not-allowlisted' }), agent, ERR.UnauthorizedService);
  await expectRejected('unauthorized-worker', paymentIx(flow, 'worker-fail', 1, { worker: Keypair.generate().publicKey }), agent, ERR.UnauthorizedWorker);
  await expectRejected('unauthorized-agent-signer', paymentIx(flow, 'signer-fail', 1, { agentSigner: worker.publicKey }), worker, ERR.UnauthorizedSigner);

  const agentBeforeSettle = await connection.getBalance(agent.publicKey, 'confirmed');
  await submit('settle-payment-1', settleIx(flow, pay1), worker);
  await submit('settle-payment-2', settleIx(flow, pay2), worker);
  if (await connection.getBalance(agent.publicKey, 'confirmed') <= agentBeforeSettle) {
    throw new Error('Escrow rent was not returned to agent_signer');
  }
  receipts.push(deriveReceiptPda(flow.capability, pay1)[0], deriveReceiptPda(flow.capability, pay2)[0]);

  await expectRejected('double-settle-payment-1', settleIx(flow, pay1), worker, ERR.AccountNotInitialized);
  await expectRejected('replay-settled-payment-id', paymentIx(flow, pay1, 1_000_000), agent, ERR.PaymentIdAlreadyUsed);
  await expectRejected('close-receipt-while-active', closeReceiptIx(flow, pay1), worker, ERR.ReceiptLockedWhileTaskActive);

  // A third escrow is still held when the owner revokes.
  const pay3 = await executePayment(flow, 'payment-3', 1_000_000);
  await submit('revoke-task', revokeTaskInstruction({
    taskCapability: flow.capability,
    owner: owner.publicKey,
  }), owner);
  await expectRejected('payment-after-revoke', paymentIx(flow, 'revoked-fail', 1), agent, ERR.TaskNotActive);
  await expectRejected('owner-clawback-held-escrow-before-expiry', refundExpiredEscrowInstruction({
    taskCapability: flow.capability,
    escrow: deriveEscrowPda(flow.capability, pay3)[0],
    owner: owner.publicKey,
    agentSigner: agent.publicKey,
    caller: owner.publicKey,
  }), owner, ERR.TaskNotExpired);
  await submit('settle-held-payment-after-revoke', settleIx(flow, pay3), worker);
  receipts.push(deriveReceiptPda(flow.capability, pay3)[0]);

  const vaultBeforeRefund = await connection.getBalance(flow.vault, 'confirmed');
  if (vaultBeforeRefund < 1_000_000) throw new Error(`Vault holds ${vaultBeforeRefund}, expected unspent 1000000 plus rent`);
  await submit('refund-close-revoked-task', refundAndCloseInstruction({
    taskCapability: flow.capability,
    owner: owner.publicKey,
    caller: owner.publicKey,
  }), owner);
  // Receipts left open at refund time stay recoverable by the worker.
  await submit('close-receipt-1-after-task-closed', closeReceiptIx(flow, pay1), worker);
  await submit('close-receipt-2-after-task-closed', closeReceiptIx(flow, pay2), worker);
  await submit('close-receipt-3-after-task-closed', closeReceiptIx(flow, pay3), worker);
  console.log(`REFUND flow vaultLamportsReturned=${vaultBeforeRefund}`);

  // Expiry task: a held escrow and the task itself are refunded permissionlessly after on-chain expiry.
  const expiryTask = await createTask('expiry', 1_000_000, 500_000, 40);
  const heldPayment = await executePayment(expiryTask, 'held', 100_000);
  await waitForOnChainTime(expiryTask.expiry);
  await expectRejected('payment-after-expiry', paymentIx(expiryTask, 'expired-fail', 1), agent, ERR.TaskExpired);
  await submit('permissionless-refund-expired-escrow', refundExpiredEscrowInstruction({
    taskCapability: expiryTask.capability,
    escrow: deriveEscrowPda(expiryTask.capability, heldPayment)[0],
    owner: owner.publicKey,
    agentSigner: agent.publicKey,
    caller: worker.publicKey,
  }), worker);
  await submit('permissionless-refund-expired-task', refundAndCloseInstruction({
    taskCapability: expiryTask.capability,
    owner: owner.publicKey,
    caller: worker.publicKey,
  }), worker);

  console.log('RESULT twoPayments=PASS cap=PASS budget=PASS allowlist=PASS signer=PASS doubleSettle=PASS replayGuard=PASS receiptLock=PASS revoke=PASS heldEscrowCommitted=PASS refund=PASS receiptAfterClose=PASS expiry=PASS');
}

let result = 'FAIL';
try {
  await main();
  result = 'PASS';
} catch (error) {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
} finally {
  let cleanupOk = true;
  for (const task of tasks) cleanupOk = await cleanTask(task) && cleanupOk;
  cleanupOk = await returnBalance(agent, 'agent') && cleanupOk;
  cleanupOk = await returnBalance(worker, 'worker') && cleanupOk;
  if (!cleanupOk) result = 'FAIL';
  console.log(`FINAL result=${result} cleanup=${cleanupOk} signatures=${signatures.length} failedSignatures=${failedSignatures.length}`);
  for (const receipt of receipts) console.log(`RECEIPT_PDA=${receipt.toBase58()}`);
  for (const signature of signatures) {
    console.log(`EXPLORER https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  }
  for (const signature of failedSignatures) {
    console.log(`EXPLORER_FAILED https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  }
  if (result !== 'PASS') process.exitCode = 1;
}
