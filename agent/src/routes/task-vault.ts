import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_DELIVERY_ATTEMPTS,
  PubkeySchema,
  TASK_CAPABILITY_ACCOUNT_SIZE,
  TASK_RECEIPT_ACCOUNT_SIZE,
  TASK_VAULT_PROGRAM_PUBKEY,
  TOKEN_PROGRAM_PUBKEY,
  computeCanonicalSeed,
  computeOutputHash,
  computeReceiptHash,
  computeReceiptSigningMessage,
  computeTaskAcceptanceMessage,
  createAssociatedTokenAccountIdempotentInstruction,
  deriveAssociatedTokenAddress,
  deriveEscrowPda,
  deriveReceiptPda,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  executeTaskPaymentInstruction,
  formatReceiptSigningMessage,
  settleAcceptedOutputInstruction,
  validateTaskTransition,
  verifyTaskOutput,
} from '@nexus/shared';
import { Ed25519Program, Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { AppContext } from '../context.js';
import { verifyMessageSignature } from '../crypto.js';
import { MerchantWorkerError } from '../merchant-worker.js';
import { submitTaskVaultInstruction } from '../task-vault-chain.js';
import {
  MERCHANT_UNREACHABLE,
  SafeSegmentSchema,
  frozenReply,
  getMockWorkerKeypair,
  onchainWorkerKind,
  resolveUserContext,
} from './shared.js';

type MockScenario = 'valid' | 'invalid_schema' | 'wrong_service';

/** The server-held mock worker's output for a payment: a demo stand-in for a real worker. */
function mockWorkerOutput(
  workerKeypair: Keypair,
  args: { taskId: string; paymentId: string; serviceId: string; scenario: MockScenario },
) {
  let resultPayload: Record<string, unknown>;
  switch (args.scenario) {
    case 'invalid_schema':
      resultPayload = {
        status: 'failed',
        serviceId: args.serviceId,
        evaluatedAt: 'invalid-timestamp',
        outputSummary: '',
        error: 'worker_output_incomplete',
      };
      break;
    case 'wrong_service':
      resultPayload = {
        status: 'completed',
        serviceId: args.serviceId === 'unrelated-service' ? 'mismatched-service' : 'unrelated-service',
        evaluatedAt: new Date().toISOString(),
        outputSummary: 'Output generated for an unrelated service instead of the requested service',
      };
      break;
    case 'valid':
    default:
      resultPayload = {
        status: 'completed',
        serviceId: args.serviceId,
        evaluatedAt: new Date().toISOString(),
        outputSummary: `Service ${args.serviceId} executed computation successfully`,
      };
      break;
  }
  const resultHash = computeOutputHash(resultPayload);
  const signatureBytes = nacl.sign.detached(
    computeReceiptSigningMessage(args.taskId, args.paymentId, resultHash),
    workerKeypair.secretKey,
  );
  return {
    workerPubkey: workerKeypair.publicKey.toBase58(),
    workerSignature: bs58.encode(signatureBytes),
    resultHash,
    resultPayload,
  };
}

async function hasConfirmedSignature(ctx: AppContext, signature: string): Promise<boolean> {
  const statuses = await ctx.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  const status = statuses.value[0];
  return Boolean(
    status
      && !status.err
      && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized'),
  );
}

async function taskCapabilityMatchesOnChain(
  ctx: AppContext,
  expected: {
    owner: string;
    agentSigner: string;
    taskId: string;
    budgetLamports: number;
    perPaymentCapLamports: number;
    expiry: number;
    allowedWorker?: string;
    allowedServiceId?: string;
    mint?: string;
  },
): Promise<boolean> {
  const [taskPda] = deriveTaskCapabilityPda(new PublicKey(expected.owner), expected.taskId);
  const [vaultPda] = deriveVaultPda(taskPda);
  const [taskInfo, vaultInfo] = await Promise.all([
    ctx.connection.getAccountInfo(taskPda, 'confirmed'),
    ctx.connection.getAccountInfo(vaultPda, 'confirmed'),
  ]);
  if (
    !taskInfo
    || !vaultInfo
    || !taskInfo.owner.equals(TASK_VAULT_PROGRAM_PUBKEY)
    || !vaultInfo.owner.equals(TASK_VAULT_PROGRAM_PUBKEY)
    || taskInfo.data.length < TASK_CAPABILITY_ACCOUNT_SIZE
  ) return false;

  const data = taskInfo.data;
  const expectedWorker = expected.allowedWorker
    ? new PublicKey(expected.allowedWorker).toBuffer()
    : PublicKey.default.toBuffer();
  const expectedService = expected.allowedServiceId
    ? Buffer.from(computeCanonicalSeed(expected.allowedServiceId))
    : Buffer.alloc(32);

  return data.subarray(8, 40).equals(new PublicKey(expected.owner).toBuffer())
    && data.subarray(40, 72).equals(new PublicKey(expected.agentSigner).toBuffer())
    && data.subarray(72, 104).equals(Buffer.from(computeCanonicalSeed(expected.taskId)))
    && Number(data.readBigUInt64LE(104)) === expected.budgetLamports
    && Number(data.readBigUInt64LE(120)) === expected.perPaymentCapLamports
    && Number(data.readBigInt64LE(128)) === expected.expiry
    && data.subarray(143, 175).equals(expectedWorker)
    && data.subarray(175, 207).equals(expectedService)
    && data.subarray(207, 239).equals(expected.mint ? new PublicKey(expected.mint).toBuffer() : PublicKey.default.toBuffer());
}

const CreateTaskBody = z.object({
  taskId: SafeSegmentSchema,
  budgetLamports: z.number().int().positive(),
  perPaymentCapLamports: z.number().int().positive(),
  expiry: z.number().int().positive(),
  allowedWorker: PubkeySchema.optional(),
  allowedServiceId: z.string().trim().min(1).max(64).optional(),
  /** SPL mint of the budget; omit for SOL. */
  mint: PubkeySchema.optional(),
  txSignature: z.string().trim().optional(),
  isSimulated: z.boolean().optional(),
});

const ExecutePaymentBody = z.object({
  paymentId: SafeSegmentSchema,
  worker: PubkeySchema,
  serviceId: z.string().trim().min(1).max(64),
  amountLamports: z.number().int().positive().safe(),
  requestHash: z.string().trim().min(1),
  txSignature: z.string().trim().optional(),
  isSimulated: z.boolean().optional(),
});

const DeliveryBody = z.object({
  resultHash: z.string().regex(/^[0-9a-f]{64}$/),
  resultPayload: z.record(z.unknown()).refine((value) => Object.keys(value).length > 0),
  workerPubkey: PubkeySchema,
  workerSignature: z.string().trim().min(1).max(200),
});

const RejectOutputBody = z.object({
  reason: z.string().trim().max(240).optional(),
});

const SettlePaymentBody = z.object({
  resultHash: z.string().trim().min(1),
  workerPubkey: PubkeySchema,
  workerSignature: z.string().trim().min(1),
  txSignature: z.string().trim().optional(),
  isSimulated: z.boolean().optional(),
  ownerSignature: z.string().trim().max(200).optional(),
});

const MockServiceBody = z.object({
  taskId: z.string().trim().min(1).max(64),
  paymentId: z.string().trim().min(1).max(64).default('payment-0'),
  serviceId: z.string().trim().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
  scenario: z.enum(['valid', 'invalid_schema', 'wrong_service']).default('valid'),
});

const RunWorkerBody = z.object({ scenario: z.enum(['valid', 'invalid_schema']).default('valid') });

export function registerTaskVaultRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/tasks', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    return { tasks: userCtx.store.getTasks() };
  });

  app.get('/api/tasks/:taskId', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    const payments = userCtx.store.getPayments(taskId);
    const receipts = userCtx.store.getReceipts(taskId);
    return { task, payments, receipts };
  });

  app.post('/api/tasks', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = CreateTaskBody.parse(req.body);
    const owner = userCtx.store.getOwner();
    if (!owner) {
      return reply.status(401).send({ error: 'unauthorized', message: 'owner wallet not connected' });
    }

    if (userCtx.store.getTask(body.taskId)) {
      return reply.status(409).send({ error: 'task_exists', message: `Task ${body.taskId} already exists` });
    }

    const ownerPubkey = new PublicKey(owner);
    const [pda] = deriveTaskCapabilityPda(ownerPubkey, body.taskId);
    const [vaultPda] = deriveVaultPda(pda);

    const now = Math.floor(Date.now() / 1000);
    if (body.expiry <= now) {
      return reply.status(400).send({ error: 'invalid_expiry', message: 'expiry must be in the future' });
    }
    if (body.perPaymentCapLamports > body.budgetLamports) {
      return reply.status(400).send({ error: 'invalid_cap', message: 'per-payment cap cannot exceed budget' });
    }
    const isSimulated = body.isSimulated ?? !body.txSignature;
    if (isSimulated === Boolean(body.txSignature)) {
      return reply.status(400).send({ error: 'invalid_transaction_mode' });
    }
    let mintDecimals: number | undefined;
    if (body.mint) {
      // Amounts are base units of the mint; record its decimals so every client shows them alike.
      const mintInfo = await userCtx.connection.getParsedAccountInfo(new PublicKey(body.mint), 'confirmed');
      const parsed = mintInfo.value?.data;
      if (
        !mintInfo.value
        || !mintInfo.value.owner.equals(TOKEN_PROGRAM_PUBKEY)
        || !parsed
        || !('parsed' in parsed)
        || parsed.parsed?.type !== 'mint'
      ) {
        return reply.status(400).send({ error: 'invalid_mint', message: 'mint is not an SPL Token mint on this cluster' });
      }
      mintDecimals = Number(parsed.parsed.info.decimals);
    }
    if (!isSimulated) {
      const signatureConfirmed = await hasConfirmedSignature(userCtx, body.txSignature!);
      const matchesOnChain = signatureConfirmed && await taskCapabilityMatchesOnChain(userCtx, {
        owner,
        agentSigner: userCtx.agentPubkey,
        taskId: body.taskId,
        budgetLamports: body.budgetLamports,
        perPaymentCapLamports: body.perPaymentCapLamports,
        expiry: body.expiry,
        allowedWorker: body.allowedWorker,
        allowedServiceId: body.allowedServiceId,
        mint: body.mint,
      });
      if (!matchesOnChain) {
        return reply.status(409).send({ error: 'onchain_task_mismatch', message: 'confirmed Devnet task state does not match this request' });
      }
    }

    const record = {
      owner,
      agentSigner: userCtx.agentPubkey,
      taskId: body.taskId,
      budgetLamports: body.budgetLamports,
      spentLamports: 0,
      perPaymentCapLamports: body.perPaymentCapLamports,
      expiry: body.expiry,
      status: 'active' as const,
      allowedWorker: body.allowedWorker,
      allowedServiceId: body.allowedServiceId,
      mint: body.mint,
      mintDecimals,
      pda: pda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      txSignature: body.txSignature,
      isSimulated,
      isClosed: false,
    };

    userCtx.store.setTask(record, { allowOverwrite: false });
    userCtx.audit.record('task_capability_created', null, {
      taskId: record.taskId,
      budgetLamports: record.budgetLamports,
      perPaymentCapLamports: record.perPaymentCapLamports,
      mint: record.mint,
      expiry: record.expiry,
      pda: record.pda,
      vaultPda: record.vaultPda,
      txSignature: record.txSignature,
      isSimulated: record.isSimulated,
    });

    return { task: record };
  });

  const taskPaymentQueues = new Map<string, Promise<unknown>>();
  async function withTaskPaymentLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = taskPaymentQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    taskPaymentQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (taskPaymentQueues.get(key) === tail) {
        taskPaymentQueues.delete(key);
      }
    }
  }

  app.post('/api/tasks/:taskId/payments', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    if (userCtx.store.isFrozen()) {
      return frozenReply(userCtx, reply, { taskId });
    }
    const body = ExecutePaymentBody.parse(req.body);

    return withTaskPaymentLock(`${userCtx.agentPubkey}:${taskId}`, async () => {
      if (userCtx.store.isFrozen()) {
        return frozenReply(userCtx, reply, { taskId });
      }

      const task = userCtx.store.getTask(taskId);
      if (!task) return reply.status(404).send({ error: 'task_not_found' });

      // Simulation does not bypass delegation: records must belong to this owner
      // and the current agent signer, just as a Devnet capability must.
      if (task.owner !== userCtx.store.getOwner()) {
        return reply.status(403).send({ error: 'task_owner_mismatch' });
      }
      if (task.agentSigner !== userCtx.agentPubkey) {
        return reply.status(409).send({ error: 'agent_signer_mismatch' });
      }
      if (task.isClosed) {
        return reply.status(400).send({ error: 'payment_rejected', message: 'task is closed' });
      }

      if (userCtx.store.getPayment(taskId, body.paymentId)) {
        return reply.status(409).send({ error: 'payment_exists', message: `Payment ${body.paymentId} already exists` });
      }

      if (task.allowedWorker && body.worker !== task.allowedWorker) {
        return reply.status(403).send({
          error: 'unauthorized_worker',
          message: `worker ${body.worker} is not allowed for this task (expected ${task.allowedWorker})`,
        });
      }

      if (task.allowedServiceId && body.serviceId !== task.allowedServiceId) {
        return reply.status(403).send({
          error: 'unauthorized_service',
          message: `service ${body.serviceId} is not allowed for this task (expected ${task.allowedServiceId})`,
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const check = validateTaskTransition(
        task,
        {
          type: 'execute_payment',
          amountLamports: body.amountLamports,
          worker: body.worker,
          serviceId: body.serviceId,
        },
        now,
      );
      if (!check.valid) {
        return reply.status(400).send({ error: 'payment_rejected', message: check.error });
      }

      const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
      const [escrowPda] = deriveEscrowPda(taskPda, body.paymentId);
      const isSimulated = task.isSimulated !== false;
      let txSignature: string | undefined;
      if (!isSimulated) {
        const workerKind = await onchainWorkerKind(userCtx, body.worker);
        if (workerKind === 'unreachable') return reply.status(503).send(MERCHANT_UNREACHABLE);
        if (!workerKind) {
          return reply.status(400).send({
            error: 'unsupported_onchain_worker',
            message: 'on-chain payments need a worker that can sign: the mock worker or the demo merchant',
          });
        }
        try {
          txSignature = await submitTaskVaultInstruction(
            userCtx.connection,
            executeTaskPaymentInstruction({
              taskCapability: taskPda,
              agentSigner: userCtx.signer.publicKey,
              worker: new PublicKey(body.worker),
              paymentId: body.paymentId,
              amountLamports: body.amountLamports,
              serviceId: body.serviceId,
              requestHash: body.requestHash,
            }),
            userCtx.signer,
          );
        } catch (error) {
          req.log.error({ err: error, taskId, paymentId: body.paymentId }, 'Task Vault payment transaction failed');
          return reply.status(502).send({ error: 'onchain_payment_failed' });
        }
      }

      // Re-read after the on-chain await so concurrent payments do not overwrite each other.
      const latestTask = userCtx.store.getTask(taskId)!;
      const updatedTask = {
        ...latestTask,
        spentLamports: latestTask.spentLamports + body.amountLamports,
      };
      userCtx.store.setTask(updatedTask, { allowOverwrite: true });

      const paymentRecord = {
        taskId,
        paymentId: body.paymentId,
        worker: body.worker,
        serviceId: body.serviceId,
        amountLamports: body.amountLamports,
        requestHash: body.requestHash,
        status: 'held' as const,
        escrowPda: escrowPda.toBase58(),
        txSignature,
        isSimulated,
        createdAt: new Date().toISOString(),
      };
      userCtx.store.setPayment(paymentRecord, { allowOverwrite: false });

      userCtx.audit.record('task_payment_executed', null, {
        taskId,
        paymentId: body.paymentId,
        worker: body.worker,
        amountLamports: body.amountLamports,
        escrowPda: paymentRecord.escrowPda,
        txSignature: paymentRecord.txSignature,
        isSimulated: paymentRecord.isSimulated,
      });

      return { task: updatedTask, payment: paymentRecord };
    });
  });

  app.post('/api/tasks/:taskId/payments/:paymentId/output', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    if (userCtx.store.isFrozen()) {
      return frozenReply(userCtx, reply, { taskId, paymentId });
    }
    const parsed = DeliveryBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_output' });
    const body = parsed.data;
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    const payment = userCtx.store.getPayment(taskId, paymentId);
    if (!payment) return reply.status(404).send({ error: 'payment_not_found' });
    if (task.isClosed || payment.status !== 'held') return reply.status(400).send({ error: 'already_settled' });
    const check = validateTaskTransition(task, { type: 'settle_payment', paymentId }, Math.floor(Date.now() / 1000));
    if (!check.valid) return reply.status(400).send({ error: 'settle_rejected', message: check.error });
    if (body.workerPubkey !== payment.worker) return reply.status(403).send({ error: 'unauthorized_worker' });
    if (computeOutputHash(body.resultPayload) !== body.resultHash) return reply.status(400).send({ error: 'output_hash_mismatch' });
    if (!verifyMessageSignature({
      message: formatReceiptSigningMessage(taskId, paymentId, body.resultHash),
      signatureBase58: body.workerSignature,
      pubkeyBase58: payment.worker,
    })) return reply.status(401).send({ error: 'invalid_worker_signature' });
    if (payment.delivery) {
      if (payment.delivery.resultHash !== body.resultHash) return reply.status(409).send({ error: 'output_already_submitted' });
      return { payment, reused: true };
    }
    const rejected = payment.rejectedDeliveries ?? [];
    if (rejected.some((item) => item.resultHash === body.resultHash)) {
      return reply.status(409).send({ error: 'output_already_rejected' });
    }
    if (rejected.length >= MAX_DELIVERY_ATTEMPTS) {
      return reply.status(409).send({ error: 'max_delivery_attempts_reached' });
    }
    const attempt = rejected.length + 1;
    const verification = verifyTaskOutput(payment, body.resultPayload);
    const updatedPayment = { ...payment, delivery: {
      attempt,
      resultHash: body.resultHash, resultPayload: body.resultPayload,
      workerSignature: body.workerSignature, submittedAt: new Date().toISOString(),
      verification,
    } };
    userCtx.store.setPayment(updatedPayment, { allowOverwrite: true });
    userCtx.audit.record('task_output_submitted', null, {
      taskId,
      paymentId,
      resultHash: body.resultHash,
      attempt,
      verificationVerdict: verification.verdict,
    });
    return { payment: updatedPayment, reused: false };
  });

  const settlementInFlight = new Set<string>();

  app.post('/api/tasks/:taskId/payments/:paymentId/reject', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    if (userCtx.store.isFrozen()) {
      return frozenReply(userCtx, reply, { taskId, paymentId });
    }
    const parsed = RejectOutputBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const body = parsed.data;

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.isClosed) return reply.status(400).send({ error: 'reject_not_allowed' });

    const payment = userCtx.store.getPayment(taskId, paymentId);
    if (!payment) return reply.status(404).send({ error: 'payment_not_found' });
    if (payment.status !== 'held') {
      return reply.status(400).send({ error: 'already_settled', message: `payment is ${payment.status}` });
    }
    const check = validateTaskTransition(task, { type: 'settle_payment', paymentId }, Math.floor(Date.now() / 1000));
    if (!check.valid) return reply.status(400).send({ error: 'settle_rejected', message: check.error });
    if (!payment.delivery) return reply.status(409).send({ error: 'output_not_submitted' });

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [escrowPda] = deriveEscrowPda(taskPda, paymentId);
    if (settlementInFlight.has(escrowPda.toBase58())) {
      return reply.status(409).send({ error: 'settlement_in_progress' });
    }

    const rejected = payment.rejectedDeliveries ?? [];
    const rejectedEntry = {
      attempt: payment.delivery.attempt ?? (rejected.length + 1),
      resultHash: payment.delivery.resultHash,
      resultPayload: payment.delivery.resultPayload,
      workerSignature: payment.delivery.workerSignature,
      submittedAt: payment.delivery.submittedAt,
      verification: payment.delivery.verification,
      rejectReason: body.reason || undefined,
      rejectedAt: new Date().toISOString(),
    };
    const updatedPayment = {
      ...payment,
      delivery: undefined,
      rejectedDeliveries: [...rejected, rejectedEntry],
    };
    userCtx.store.setPayment(updatedPayment, { allowOverwrite: true });
    userCtx.audit.record('task_output_rejected', null, {
      taskId,
      paymentId,
      resultHash: rejectedEntry.resultHash,
      attempt: rejectedEntry.attempt,
      reason: rejectedEntry.rejectReason ?? null,
    });
    return {
      payment: updatedPayment,
      rejected: rejectedEntry,
      attemptsRemaining: Math.max(0, MAX_DELIVERY_ATTEMPTS - updatedPayment.rejectedDeliveries.length),
    };
  });

  app.post('/api/tasks/:taskId/payments/:paymentId/settle', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    if (userCtx.store.isFrozen()) {
      return frozenReply(userCtx, reply, { taskId, paymentId });
    }
    const body = SettlePaymentBody.parse(req.body);

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.agentSigner !== userCtx.agentPubkey) return reply.status(409).send({ error: 'agent_signer_mismatch' });
    if (task.isClosed) return reply.status(400).send({ error: 'settle_rejected' });

    const payment = userCtx.store.getPayment(taskId, paymentId);
    if (!payment) {
      return reply.status(404).send({ error: 'payment_not_found' });
    }
    if (payment.status !== 'held') {
      return reply.status(400).send({ error: 'already_settled', message: `payment is ${payment.status}` });
    }

    // Verify worker authenticity: recipient must match escrow worker
    if (body.workerPubkey !== payment.worker) {
      return reply.status(403).send({ error: 'unauthorized_worker', message: 'worker does not match escrow recipient' });
    }

    // Verify worker cryptographic ed25519 receipt signature
    const canonicalReceiptMessage = formatReceiptSigningMessage(taskId, paymentId, body.resultHash);
    const validWorkerSig = verifyMessageSignature({
      message: canonicalReceiptMessage,
      signatureBase58: body.workerSignature,
      pubkeyBase58: body.workerPubkey,
    });
    if (!validWorkerSig) {
      return reply.status(401).send({ error: 'invalid_worker_signature', message: 'worker signature verification failed' });
    }

    if (!payment.delivery) return reply.status(409).send({ error: 'output_not_submitted' });
    if (payment.delivery.resultHash !== body.resultHash || computeOutputHash(payment.delivery.resultPayload) !== body.resultHash) {
      return reply.status(409).send({ error: 'output_hash_mismatch' });
    }
    const verification = payment.delivery.verification ?? verifyTaskOutput(payment, payment.delivery.resultPayload);
    if (verification.verdict !== 'pass') {
      return reply.status(409).send({ error: 'output_verification_failed', verification });
    }
    if (!body.ownerSignature) return reply.status(403).send({ error: 'owner_acceptance_required' });

    const now = Math.floor(Date.now() / 1000);
    const heldPayments = userCtx.store.getPayments(taskId).filter((p) => p.status === 'held');
    const remainingPending = Math.max(0, heldPayments.length - 1);
    const check = validateTaskTransition(
      task,
      { type: 'settle_payment', paymentId, remainingPendingEscrows: remainingPending },
      now,
    );
    if (!check.valid) {
      return reply.status(400).send({ error: 'settle_rejected', message: check.error });
    }

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [escrowPda] = deriveEscrowPda(taskPda, paymentId);
    const [receiptPda] = deriveReceiptPda(taskPda, paymentId);
    const acceptanceMessage = computeTaskAcceptanceMessage({
      taskCapability: taskPda, escrow: escrowPda, requestHash: payment.requestHash,
      resultHash: body.resultHash, amountLamports: payment.amountLamports, mint: task.mint,
    });
    if (!verifyMessageSignature({ message: acceptanceMessage, signatureBase58: body.ownerSignature, pubkeyBase58: task.owner })) {
      return reply.status(401).send({ error: 'invalid_owner_acceptance' });
    }
    const settlementKey = escrowPda.toBase58();
    if (settlementInFlight.has(settlementKey)) return reply.status(409).send({ error: 'settlement_in_progress' });
    settlementInFlight.add(settlementKey);
    try {
      const isSimulated = task.isSimulated !== false;
      let txSignature: string | undefined;
      if (!isSimulated) {
        const workerKind = await onchainWorkerKind(userCtx, payment.worker);
        if (workerKind === 'unreachable') return reply.status(503).send(MERCHANT_UNREACHABLE);
        if (!workerKind) {
          return reply.status(400).send({
            error: 'unsupported_onchain_worker',
            message: 'only the mock worker or the demo merchant can sign on-chain settlements',
          });
        }
        const workerPubkey = new PublicKey(payment.worker);
        try {
          // The demo worker holds no funds of its own: the agent pays the fee and tops the worker
          // up so it can fund the receipt PDA and still stay rent-exempt afterwards.
          const [receiptRent, systemAccountRent, workerLamports] = await Promise.all([
            userCtx.connection.getMinimumBalanceForRentExemption(TASK_RECEIPT_ACCOUNT_SIZE),
            userCtx.connection.getMinimumBalanceForRentExemption(0),
            userCtx.connection.getBalance(workerPubkey, 'confirmed'),
          ]);
          // Preparation runs in its own transaction: with it, a token settlement exceeds the
          // 1232-byte transaction limit. A retry after a failed settlement recomputes the top-up
          // from the worker's current balance and recreates the token account idempotently.
          const preparation: TransactionInstruction[] = [];
          const topUp = receiptRent + systemAccountRent - workerLamports;
          if (topUp > 0) {
            preparation.push(SystemProgram.transfer({
              fromPubkey: userCtx.signer.publicKey,
              toPubkey: workerPubkey,
              lamports: topUp,
            }));
          }
          const taskMint = task.mint ? new PublicKey(task.mint) : undefined;
          if (taskMint) {
            // The worker is paid into its associated token account; the agent funds it if missing.
            preparation.push(createAssociatedTokenAccountIdempotentInstruction(
              userCtx.signer.publicKey, workerPubkey, taskMint,
            ));
          }
          if (preparation.length) {
            await submitTaskVaultInstruction(userCtx.connection, preparation, userCtx.signer);
          }
          txSignature = await submitTaskVaultInstruction(userCtx.connection, [
            Ed25519Program.createInstructionWithPublicKey({
              publicKey: new PublicKey(task.owner).toBytes(),
              message: Buffer.from(acceptanceMessage),
              signature: bs58.decode(body.ownerSignature),
            }),
            settleAcceptedOutputInstruction({
              taskCapability: taskPda,
              escrow: escrowPda,
              paymentId,
              worker: workerPubkey,
              agentSigner: new PublicKey(task.agentSigner),
              resultHash: body.resultHash,
              mint: taskMint,
            }),
          ], userCtx.signer, workerKind === 'mock' ? [getMockWorkerKeypair(userCtx)] : [], workerKind === 'merchant'
            ? (transaction) => userCtx.merchantWorker!.coSignSettlement(transaction)
            : undefined);
        } catch (error) {
          req.log.error({ err: error, taskId, paymentId }, 'Task Vault settlement transaction failed');
          return reply.status(502).send({ error: 'onchain_settlement_failed' });
        }
      }

      userCtx.store.setPayment({ ...payment, status: 'settled', txSignature, isSimulated }, { allowOverwrite: true });

      const receiptRecord = {
        taskId,
        paymentId,
        worker: payment.worker,
        serviceId: payment.serviceId,
        requestHash: payment.requestHash,
        resultHash: body.resultHash,
        amountLamports: payment.amountLamports,
        settledAt: now,
        receiptPda: receiptPda.toBase58(),
        txSignature,
        isSimulated,
        acceptedBy: task.owner,
        ownerSignature: body.ownerSignature,
      };
      userCtx.store.setReceipt(receiptRecord, { allowOverwrite: false });

      // Recompute the status from state re-read after the on-chain await.
      const latestTask = userCtx.store.getTask(taskId)!;
      const heldAfterSettle = userCtx.store.getPayments(taskId).filter((p) => p.status === 'held').length;
      const next = validateTaskTransition(
        latestTask,
        { type: 'settle_payment', paymentId, remainingPendingEscrows: heldAfterSettle },
        now,
      );
      if (next.nextStatus && next.nextStatus !== 'closed' && next.nextStatus !== latestTask.status) {
        userCtx.store.setTask({ ...latestTask, status: next.nextStatus }, { allowOverwrite: true });
      }

      userCtx.audit.record('task_payment_settled', null, {
        taskId,
        paymentId,
        worker: payment.worker,
        amountLamports: payment.amountLamports,
        resultHash: body.resultHash,
        receiptPda: receiptRecord.receiptPda,
        txSignature: receiptRecord.txSignature,
        isSimulated: receiptRecord.isSimulated,
      });

      return { payment: { ...payment, status: 'settled', txSignature, isSimulated }, receipt: receiptRecord };
    } finally {
      settlementInFlight.delete(settlementKey);
    }
  });

  app.post('/api/tasks/:taskId/revoke', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const body = z.object({ txSignature: z.string().trim().min(32).optional() }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.status === 'revoked') return { task };

    if (task.isSimulated === false) {
      if (!body.txSignature || !await hasConfirmedSignature(userCtx, body.txSignature)) {
        return reply.status(409).send({ error: 'revoke_not_confirmed' });
      }
      const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
      const account = await userCtx.connection.getAccountInfo(taskPda, 'confirmed');
      if (
        !account
        || !account.owner.equals(TASK_VAULT_PROGRAM_PUBKEY)
        || account.data.length <= 136
        || account.data[136] !== 2
      ) {
        return reply.status(409).send({ error: 'onchain_task_not_revoked' });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const check = validateTaskTransition(task, { type: 'revoke' }, now);
    if (!check.valid) {
      return reply.status(400).send({ error: 'revoke_rejected', message: check.error });
    }

    const updated = { ...userCtx.store.getTask(taskId)!, status: 'revoked' as const };
    userCtx.store.setTask(updated, { allowOverwrite: true });

    userCtx.audit.record('task_revoked', null, { taskId });
    return { task: updated };
  });

  app.post('/api/tasks/:taskId/receipts/:paymentId/close', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    const body = z.object({ txSignature: z.string().trim().min(32) }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.isSimulated !== false) return reply.status(409).send({ error: 'task_is_simulated' });

    const receipt = userCtx.store.getReceipt(taskId, paymentId);
    if (!receipt) return reply.status(404).send({ error: 'receipt_not_found' });
    if (receipt.isClosed) return { receipt };
    if (!await hasConfirmedSignature(userCtx, body.txSignature)) {
      return reply.status(409).send({ error: 'receipt_close_not_confirmed' });
    }

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [receiptPda] = deriveReceiptPda(taskPda, paymentId);
    if (await userCtx.connection.getAccountInfo(receiptPda, 'confirmed')) {
      return reply.status(409).send({ error: 'onchain_receipt_not_closed' });
    }

    const updatedReceipt = { ...receipt, isClosed: true, closeTxSignature: body.txSignature };
    userCtx.store.setReceipt(updatedReceipt, { allowOverwrite: true });
    userCtx.audit.record('task_receipt_rent_reclaimed', null, {
      taskId,
      paymentId,
      receiptPda: receiptPda.toBase58(),
      txSignature: body.txSignature,
    });
    return { receipt: updatedReceipt };
  });

  app.post('/api/tasks/:taskId/payments/:paymentId/refund-expired', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    const body = z.object({ txSignature: z.string().trim().min(32).optional() }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.isClosed) return reply.status(400).send({ error: 'refund_rejected', message: 'task is closed' });

    const payment = userCtx.store.getPayment(taskId, paymentId);
    if (!payment) return reply.status(404).send({ error: 'payment_not_found' });
    if (payment.status === 'refunded') return { payment };
    if (payment.status !== 'held') {
      return reply.status(400).send({ error: 'already_settled', message: `payment is ${payment.status}` });
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < task.expiry) {
      return reply.status(409).send({ error: 'task_not_expired' });
    }

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [escrowPda] = deriveEscrowPda(taskPda, paymentId);
    if (settlementInFlight.has(escrowPda.toBase58())) {
      return reply.status(409).send({ error: 'settlement_in_progress' });
    }

    if (task.isSimulated === false) {
      if (!body.txSignature || !await hasConfirmedSignature(userCtx, body.txSignature)) {
        return reply.status(409).send({ error: 'refund_not_confirmed' });
      }
      if (await userCtx.connection.getAccountInfo(escrowPda, 'confirmed')) {
        return reply.status(409).send({ error: 'onchain_escrow_not_closed' });
      }
    }

    const updatedPayment = { ...payment, status: 'refunded' as const, refundTxSignature: body.txSignature };
    userCtx.store.setPayment(updatedPayment, { allowOverwrite: true });
    userCtx.audit.record('task_escrow_refunded_expired', null, {
      taskId,
      paymentId,
      escrowPda: escrowPda.toBase58(),
      amountLamports: payment.amountLamports,
      txSignature: body.txSignature,
      isSimulated: task.isSimulated !== false,
    });
    return { payment: updatedPayment };
  });

  app.post('/api/tasks/:taskId/refund', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const body = z.object({ txSignature: z.string().trim().min(32).optional() }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    if (task.isClosed) return { task, refundedLamports: Math.max(0, task.budgetLamports - task.spentLamports) };

    // Invariant: Reject refund and close if pending escrows exist
    const pending = userCtx.store.getPayments(taskId).filter((p) => p.status === 'held');
    if (pending.length > 0) {
      return reply.status(409).send({
        error: 'pending_escrows_exist',
        message: `cannot refund and close task while ${pending.length} escrow(s) are still held`,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const check = validateTaskTransition(task, { type: 'refund_and_close' }, now);
    if (!check.valid) {
      return reply.status(400).send({ error: 'refund_rejected', message: check.error });
    }

    if (task.isSimulated === false) {
      if (!body.txSignature || !await hasConfirmedSignature(userCtx, body.txSignature)) {
        return reply.status(409).send({ error: 'refund_not_confirmed' });
      }
      const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
      const [vaultPda] = deriveVaultPda(taskPda);
      const vaultTokenAccount = task.mint ? deriveAssociatedTokenAddress(vaultPda, new PublicKey(task.mint)) : null;
      const [taskAccount, vaultAccount, vaultTokenInfo] = await Promise.all([
        userCtx.connection.getAccountInfo(taskPda, 'confirmed'),
        userCtx.connection.getAccountInfo(vaultPda, 'confirmed'),
        vaultTokenAccount ? userCtx.connection.getAccountInfo(vaultTokenAccount, 'confirmed') : null,
      ]);
      if (taskAccount || vaultAccount || vaultTokenInfo) {
        return reply.status(409).send({ error: 'onchain_task_not_closed' });
      }
    }

    const latestTask = userCtx.store.getTask(taskId)!;
    const refundedEscrowTokens = latestTask.mint
      ? userCtx.store.getPayments(taskId).filter((p) => p.status === 'refunded').reduce((sum, p) => sum + p.amountLamports, 0)
      : 0;
    const remainingLamports = Math.max(0, latestTask.budgetLamports - latestTask.spentLamports + refundedEscrowTokens);
    const updated = { ...latestTask, status: 'completed' as const, isClosed: true };
    userCtx.store.setTask(updated, { allowOverwrite: true });

    userCtx.audit.record('task_refunded_and_closed', null, {
      taskId,
      refundedLamports: remainingLamports,
    });

    return { task: updated, refundedLamports: remainingLamports };
  });

  app.post('/api/tasks/mock-service/run', async (req) => {
    const body = MockServiceBody.parse(req.body);
    const output = mockWorkerOutput(getMockWorkerKeypair(ctx), body);
    const requestHash = computeReceiptHash({
      taskId: body.taskId,
      paymentId: body.paymentId,
      worker: output.workerPubkey,
      serviceId: body.serviceId,
      requestHash: JSON.stringify(body.payload),
      resultHash: 'evaluating',
      amountLamports: 0,
    });
    return { scenario: body.scenario, serviceId: body.serviceId, requestHash, ...output };
  });

  /** Has the payment's worker produce its output: the mock worker here, or the demo merchant remotely. */
  app.post('/api/tasks/:taskId/payments/:paymentId/worker-run', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    const parsed = RunWorkerBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
    if (task.owner !== userCtx.store.getOwner()) return reply.status(403).send({ error: 'task_owner_mismatch' });
    const payment = userCtx.store.getPayment(taskId, paymentId);
    if (!payment) return reply.status(404).send({ error: 'payment_not_found' });
    if (task.isClosed || payment.status !== 'held') return reply.status(400).send({ error: 'already_settled' });

    const workerKind = await onchainWorkerKind(userCtx, payment.worker);
    if (workerKind === 'merchant') {
      // The merchant only works for an escrow it can see on-chain.
      if (payment.isSimulated !== false) return reply.status(409).send({ error: 'merchant_worker_onchain_only' });
      try {
        return await userCtx.merchantWorker!.runJob({
          owner: task.owner,
          taskId,
          paymentId,
          serviceId: payment.serviceId,
          requestHash: payment.requestHash,
          scenario: parsed.data.scenario,
        });
      } catch (error) {
        req.log.warn({ err: error, taskId, paymentId }, 'merchant worker job failed');
        return reply.status(502).send({
          error: 'merchant_worker_failed',
          message: error instanceof MerchantWorkerError ? error.code : 'merchant worker failed',
        });
      }
    }
    // A simulated payment to any other address still runs on the mock worker, as before.
    if (payment.isSimulated === false) {
      if (workerKind === 'unreachable') return reply.status(503).send(MERCHANT_UNREACHABLE);
      if (workerKind === null) return reply.status(400).send({ error: 'unsupported_onchain_worker' });
    }
    return mockWorkerOutput(getMockWorkerKeypair(userCtx), {
      taskId,
      paymentId,
      serviceId: payment.serviceId,
      scenario: parsed.data.scenario,
    });
  });
}
