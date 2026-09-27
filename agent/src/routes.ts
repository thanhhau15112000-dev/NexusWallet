import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  AllowlistEntrySchema,
  PubkeySchema,
  solToLamports,
  type Policy,
  validateTaskTransition,
  computeTaskHash,
  computeReceiptHash,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  deriveEscrowPda,
  deriveReceiptPda,
  computeCanonicalSeed,
  computeReceiptSigningMessage,
} from '@nexus/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifyMessageSignature } from './crypto.js';
import { explorerAddressUrl, getLamportBalance, isValidAddress, requestAirdrop } from './chain.js';
import { ApprovalError, approveRequest } from './approvals.js';
import type { AppContext } from './context.js';
import {
  dispenseInitialSeed,
  SeedTransferFailedError,
  SeedTransferOutcomeUnknownError,
} from './funder.js';
import { runCommand } from './pipeline.js';
import { SESSION_COOKIE_NAME } from './sessions.js';
import { LOCAL_ORIGIN_REGEX } from './config.js';

const CommandBody = z.object({
  prompt: z.string().trim().min(1).max(600),
  idempotencyKey: z.string().trim().max(120).optional(),
});

const OwnerBody = z.object({ pubkey: PubkeySchema });

const PolicyBody = z.object({
  maxSolPerTx: z.number().nonnegative().max(1000),
  allowedRecipients: z.array(AllowlistEntrySchema).max(32),
  allowedMints: z.array(AllowlistEntrySchema).max(16),
  maxTokenAmountByMint: z.record(z.string(), z.number().nonnegative()).default({}),
});

const ApproveBody = z.object({
  signature: z.string().trim().min(32).max(200),
  signerPubkey: PubkeySchema,
});

const AirdropBody = z.object({ sol: z.number().positive().max(5).default(1) });
const ChallengeBody = z.object({ pubkey: PubkeySchema });
const LoginBody = z.object({
  challengeId: z.string().regex(/^[a-f0-9]{64}$/i),
  pubkey: PubkeySchema,
  signature: z.string().trim().min(32).max(200),
});
const ActionBody = z.object({
  account: PubkeySchema,
  signature: z.string().trim().min(32).max(200).optional(),
});

function getSession(ctx: AppContext, req: FastifyRequest) {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME];
  if (!cookie) return null;
  const unsigned = req.unsignCookie(cookie);
  if (!unsigned.valid || !unsigned.value) return null;
  return ctx.sessions.getSession(unsigned.value);
}

function resolveUserContext(ctx: AppContext, req: FastifyRequest): AppContext {
  const session = getSession(ctx, req);
  if (session?.owner && ctx.getUserContext) {
    return ctx.getUserContext(session.owner);
  }
  const headerOwner = req.headers['x-owner-pubkey'] as string | undefined;
  if (headerOwner && PubkeySchema.safeParse(headerOwner).success && ctx.getUserContext) {
    return ctx.getUserContext(headerOwner);
  }
  const boundOwner = ctx.store.getOwner();
  if (boundOwner && ctx.getUserContext) {
    return ctx.getUserContext(boundOwner);
  }
  return ctx;
}

function publicPolicy(policy: Policy) {
  return { ...policy, maxSolPerTx: policy.maxSolLamportsPerTx / 1_000_000_000 };
}

function isOriginAllowed(origin: string | undefined, ctx: AppContext): boolean {
  if (!origin) return true;
  if (ctx.config.allowedOrigins.includes(origin)) return true;
  if (LOCAL_ORIGIN_REGEX.test(origin)) return true;
  return false;
}

function actionOrigin(ctx: AppContext): string {
  return ctx.config.allowedOrigins[0] ?? 'http://localhost:5173';
}

function actionContext(ctx: AppContext, owner: string | undefined): AppContext | null {
  if (owner && !PubkeySchema.safeParse(owner).success) return null;
  if (!owner) return ctx;
  // Actions are public; do not create a new tenant directory/keypair just
  // because an attacker guessed a valid-looking owner address.
  if (ctx.config.usersDir && !existsSync(resolve(ctx.config.usersDir, owner, 'state.json'))) return null;
  return ctx.getUserContext ? ctx.getUserContext(owner) : ctx;
}

function actionRequest(ctx: AppContext, requestId: string, owner: string | undefined) {
  const userCtx = actionContext(ctx, owner);
  if (!userCtx) return { userCtx: null, request: null };
  return { userCtx, request: userCtx.store.getRequest(requestId) };
}

function actionResponseHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('Access-Control-Allow-Origin', '*')
    .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    .header('Access-Control-Allow-Headers', 'Content-Type')
    .header('Content-Type', 'application/json');
}

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/.well-known/actions.json', async (_req, reply) => {
    actionResponseHeaders(reply);
    return {
      rules: [{
        pathPattern: '/api/actions/approve/**',
        apiPath: '/api/actions/approve',
      }],
    };
  });

  app.get('/api/health', async () => ({
    ok: true,
    agentId: ctx.config.AGENT_ID,
    cluster: ctx.config.SOLANA_CLUSTER,
    authRequired: true,
    models: ctx.model.describe(),
  }));

  app.get('/api/actions/approve/:requestId', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const owner = (req.query as { owner?: string }).owner;
    const { request } = actionRequest(ctx, requestId, owner);
    actionResponseHeaders(reply);
    if (!request || !request.approval || request.status !== 'pending_approval') {
      return reply.status(404).send({ error: 'approval_not_found' });
    }
    const origin = actionOrigin(ctx);
    const actionHref = `${origin}/api/actions/approve/${encodeURIComponent(requestId)}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`;
    const payload = request.approval.payload;
    const amount = payload.actionType === 'transfer_sol'
      ? `${payload.amount / 1_000_000_000} SOL`
      : `${payload.amount} tokens`;
    return {
      icon: `${origin}/solana-logo-mark.svg`,
      title: 'Approve nexusPay agent transaction',
      description: `Approve ${amount} to ${payload.recipient}.`,
      label: 'Sign approval',
      links: {
        actions: [{
          label: 'Sign approval',
          href: actionHref,
          parameters: [{ name: 'account', label: 'Owner wallet address' }],
        }],
      },
    };
  });

  app.options('/api/actions/approve/:requestId', async (_req, reply) => {
    actionResponseHeaders(reply);
    return reply.send();
  });

  app.post('/api/actions/approve/:requestId', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const body = ActionBody.parse(req.body);
    const { userCtx, request } = actionRequest(ctx, requestId, body.account);
    actionResponseHeaders(reply);
    if (!userCtx || !request || !request.approval || request.status !== 'pending_approval') {
      return reply.status(404).send({ error: 'approval_not_found' });
    }
    if (userCtx.store.getOwner() !== body.account) {
      return reply.status(403).send({ error: 'wrong_signer', message: 'account is not the bound owner wallet' });
    }
    if (body.signature) {
      try {
        const approved = await approveRequest(userCtx, {
          requestId,
          signature: body.signature,
          signerPubkey: body.account,
        });
        return {
          type: 'message',
          message: 'Approval accepted; the agent is executing the transfer.',
          requestId,
          request: approved,
        };
      } catch (err) {
        if (err instanceof ApprovalError) {
          const status = err.code === 'not_found' ? 404 : 403;
          return reply.status(status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }
    return {
      type: 'message',
      message: request.approval.message,
      requestId,
      expiresAt: request.approval.payload.expiresAt,
      account: body.account,
    };
  });

  app.post('/api/auth/challenge', async (req, reply) => {
    const { pubkey } = ChallengeBody.parse(req.body);
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, ctx)) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    const fallbackOrigin = ctx.config.allowedOrigins[0] ?? 'http://localhost:5173';
    const challenge = ctx.sessions.createChallenge(pubkey, origin ?? fallbackOrigin);
    if (!challenge) return reply.status(403).send({ error: 'wallet_not_allowed' });
    return challenge;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { challengeId, pubkey, signature } = LoginBody.parse(req.body);
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, ctx)) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    const session = ctx.sessions.verifyChallenge({ challengeId, pubkey, signature });
    if (!session) return reply.status(401).send({ error: 'invalid_login_signature' });
    reply.setCookie(SESSION_COOKIE_NAME, session.token, {
      signed: true,
      httpOnly: true,
      secure: ctx.config.authRequired,
      sameSite: 'strict',
      path: '/',
      maxAge: ctx.config.AUTH_SESSION_TTL_SECONDS,
    });
    return { authenticated: true, owner: pubkey, expiresAt: session.expiresAt };
  });

  app.get('/api/auth/session', async (req) => {
    const session = getSession(ctx, req);
    if (!session) return { authenticated: false, owner: null, expiresAt: null, isAdmin: false };
    return {
      authenticated: true,
      owner: session.owner,
      expiresAt: session.expiresAt,
      isAdmin: session.isAdmin,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (cookie) {
      const unsigned = req.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value) ctx.sessions.revoke(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: ctx.config.authRequired,
      sameSite: 'strict',
      path: '/',
    });
    return { authenticated: false };
  });

  app.get('/api/state', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const session = getSession(ctx, req);
    let lamports: number | null = null;
    let rpcError: string | null = null;
    try {
      lamports = await getLamportBalance(userCtx.connection, userCtx.agentPubkey);
    } catch (err) {
      rpcError = err instanceof Error ? err.message : String(err);
    }

    const isAdmin = Boolean(session?.isAdmin || (session?.owner && session.owner === ctx.config.adminPubkey));
    let masterFunderBalance: number | null = null;
    if (isAdmin && ctx.masterFunderPubkey) {
      try {
        masterFunderBalance = await getLamportBalance(ctx.connection, ctx.masterFunderPubkey);
      } catch {
        // Ignore balance read failure
      }
    }

    return {
      cluster: userCtx.config.SOLANA_CLUSTER,
      rpcUrl: userCtx.config.SOLANA_RPC_URL,
      models: userCtx.model.describe(),
      owner: userCtx.store.getOwner(),
      ownerPinned: false,
      isAdmin,
      claimedInitialFunding: userCtx.store.hasClaimedInitialFunding(),
      masterFunder: isAdmin && ctx.masterFunderPubkey
        ? {
            pubkey: ctx.masterFunderPubkey,
            lamports: masterFunderBalance,
          }
        : null,
      agent: {
        agentId: userCtx.config.AGENT_ID,
        pubkey: userCtx.agentPubkey,
        lamports,
        rpcError,
        explorerUrl: explorerAddressUrl(userCtx.agentPubkey, userCtx.config.SOLANA_CLUSTER),
      },
      policy: publicPolicy(userCtx.store.getPolicy()),
    };
  });

  app.post('/api/owner', async (req, reply) => {
    const body = OwnerBody.parse(req.body);
    if (!isValidAddress(body.pubkey)) {
      return reply.status(400).send({ error: 'invalid_pubkey', message: 'not a Solana address' });
    }
    const userCtx = ctx.getUserContext ? ctx.getUserContext(body.pubkey) : ctx;
    userCtx.store.setOwner(body.pubkey);
    return { owner: body.pubkey };
  });

const inFlightClaims = new Set<string>();

  app.post('/api/agent/claim-seed', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const claimKey = userCtx.agentPubkey;

    if (inFlightClaims.has(claimKey)) {
      return reply.status(409).send({
        error: 'claim_in_progress',
        message: 'A seed claim is already in progress for this agent.',
      });
    }

    if (userCtx.store.hasClaimedInitialFunding()) {
      return reply.status(409).send({
        error: 'already_claimed',
        message: 'Initial demo funding (0.1 SOL) has already been claimed for this agent wallet.',
      });
    }

    if (!ctx.masterFunder) {
      return reply.status(503).send({
        error: 'funder_unavailable',
        message: 'Master Funder is not configured on this instance.',
      });
    }

    inFlightClaims.add(claimKey);
    try {
      if (userCtx.store.hasClaimedInitialFunding()) {
        return reply.status(409).send({
          error: 'already_claimed',
          message: 'Initial demo funding (0.1 SOL) has already been claimed for this agent wallet.',
        });
      }

      const amountLamports = 100_000_000; // 0.1 SOL
      const result = await dispenseInitialSeed({
        connection: ctx.connection,
        funder: ctx.masterFunder,
        recipientPubkey: userCtx.agentPubkey,
        amountLamports,
        pending: userCtx.store.getPendingInitialFunding(),
        persistPending: (pending) => userCtx.store.setPendingInitialFunding(pending),
      });

      userCtx.store.setClaimedInitialFunding(true);
      userCtx.audit.record('agent.initial_seed_claimed', null, {
        recipient: userCtx.agentPubkey,
        amountLamports,
        signature: result.signature,
      });

      const lamports = await getLamportBalance(userCtx.connection, userCtx.agentPubkey);
      return { signature: result.signature, lamports, claimedInitialFunding: true };
    } catch (err) {
      if (err instanceof SeedTransferFailedError) {
        userCtx.store.clearPendingInitialFunding();
      }
      if (err instanceof SeedTransferOutcomeUnknownError) {
        return reply.status(409).send({
          error: 'claim_outcome_unknown',
          message: 'The previous seed transfer is still being reconciled. Retry later; a second transfer will not be sent.',
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: 'funder_failed',
        message,
      });
    } finally {
      inFlightClaims.delete(claimKey);
    }
  });

  app.put('/api/policy', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = PolicyBody.parse(req.body);
    const policy = userCtx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(body.maxSolPerTx),
      allowedRecipients: body.allowedRecipients,
      allowedMints: body.allowedMints,
      maxTokenAmountByMint: body.maxTokenAmountByMint,
    });
    userCtx.audit.record('policy.updated', null, { policy });
    return { policy: publicPolicy(policy) };
  });

  app.post('/api/agent/airdrop', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = AirdropBody.parse(req.body ?? {});
    try {
      const signature = await requestAirdrop({
        connection: userCtx.connection,
        address: userCtx.agentPubkey,
        lamports: solToLamports(body.sol),
      });
      userCtx.audit.record('agent.airdrop', null, { sol: body.sol, signature });
      const lamports = await getLamportBalance(userCtx.connection, userCtx.agentPubkey);
      return { signature, lamports };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: 'airdrop_failed',
        message: `${message} | the devnet faucet rate-limits aggressively, fund the agent from https://faucet.solana.com instead`,
      });
    }
  });

  app.post('/api/commands', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = CommandBody.parse(req.body);
    const request = await runCommand(userCtx, {
      prompt: body.prompt,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return { request };
  });

  app.get('/api/requests', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    return { requests: userCtx.store.listRequests() };
  });

  app.get('/api/requests/:id', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { id } = req.params as { id: string };
    const request = userCtx.store.getRequest(id);
    if (!request) return reply.status(404).send({ error: 'not_found' });
    return { request };
  });

  app.post('/api/requests/:id/approve', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { id } = req.params as { id: string };
    const body = ApproveBody.parse(req.body);
    try {
      const request = await approveRequest(userCtx, {
        requestId: id,
        signature: body.signature,
        signerPubkey: body.signerPubkey,
      });
      return { request };
    } catch (err) {
      if (err instanceof ApprovalError) {
        const status = err.code === 'not_found' ? 404 : 403;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/audit', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const raw = Number((req.query as { limit?: string }).limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    return { entries: userCtx.audit.list(limit) };
  });

  // ------------------------------------------------ Task Capability Vault

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

  const CreateTaskBody = z.object({
    taskId: z.string().trim().min(1).max(64),
    budgetLamports: z.number().int().positive(),
    perPaymentCapLamports: z.number().int().positive(),
    expiry: z.number().int().positive(),
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

    const record = {
      owner,
      agentSigner: userCtx.agentPubkey,
      taskId: body.taskId,
      budgetLamports: body.budgetLamports,
      spentLamports: 0,
      perPaymentCapLamports: body.perPaymentCapLamports,
      expiry: body.expiry,
      status: 'active' as const,
      pda: pda.toBase58(),
      vaultPda: vaultPda.toBase58(),
    };

    userCtx.store.setTask(record, { allowOverwrite: false });
    userCtx.audit.record('task_capability_created', null, {
      taskId: record.taskId,
      budgetLamports: record.budgetLamports,
      perPaymentCapLamports: record.perPaymentCapLamports,
      expiry: record.expiry,
      pda: record.pda,
      vaultPda: record.vaultPda,
    });

    return { task: record };
  });

  const ExecutePaymentBody = z.object({
    paymentId: z.string().trim().min(1).max(64),
    worker: PubkeySchema,
    serviceId: z.string().trim().min(1).max(64),
    amountLamports: z.number().int().positive(),
    requestHash: z.string().trim().min(1),
  });

  app.post('/api/tasks/:taskId/payments', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const body = ExecutePaymentBody.parse(req.body);

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

    if (userCtx.store.getPayment(body.paymentId)) {
      return reply.status(409).send({ error: 'payment_exists', message: `Payment ${body.paymentId} already exists` });
    }

    const now = Math.floor(Date.now() / 1000);
    const check = validateTaskTransition(
      task,
      { type: 'execute_payment', amountLamports: body.amountLamports },
      now,
    );
    if (!check.valid) {
      return reply.status(400).send({ error: 'payment_rejected', message: check.error });
    }

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [escrowPda] = deriveEscrowPda(taskPda, body.paymentId);

    const updatedTask = {
      ...task,
      spentLamports: task.spentLamports + body.amountLamports,
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
      createdAt: new Date().toISOString(),
    };
    userCtx.store.setPayment(paymentRecord, { allowOverwrite: false });

    userCtx.audit.record('task_payment_executed', null, {
      taskId,
      paymentId: body.paymentId,
      worker: body.worker,
      amountLamports: body.amountLamports,
      escrowPda: paymentRecord.escrowPda,
    });

    return { task: updatedTask, payment: paymentRecord };
  });

  const SettlePaymentBody = z.object({
    resultHash: z.string().trim().min(1),
    workerPubkey: PubkeySchema,
    workerSignature: z.string().trim().min(1),
  });

  app.post('/api/tasks/:taskId/payments/:paymentId/settle', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    const body = SettlePaymentBody.parse(req.body);

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

    const payment = userCtx.store.getPayment(paymentId);
    if (!payment || payment.taskId !== taskId) {
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
    const canonicalReceiptMessage = `NEXUS_RECEIPT_V1:${taskId}:${paymentId}:${body.resultHash}`;
    const validWorkerSig = verifyMessageSignature({
      message: canonicalReceiptMessage,
      signatureBase58: body.workerSignature,
      pubkeyBase58: body.workerPubkey,
    });
    if (!validWorkerSig) {
      return reply.status(401).send({ error: 'invalid_worker_signature', message: 'worker signature verification failed' });
    }

    const now = Math.floor(Date.now() / 1000);
    const check = validateTaskTransition(task, { type: 'settle_payment', paymentId }, now);
    if (!check.valid) {
      return reply.status(400).send({ error: 'settle_rejected', message: check.error });
    }

    const [taskPda] = deriveTaskCapabilityPda(new PublicKey(task.owner), task.taskId);
    const [receiptPda] = deriveReceiptPda(taskPda, paymentId);

    userCtx.store.setPayment({ ...payment, status: 'settled' }, { allowOverwrite: true });

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
    };
    userCtx.store.setReceipt(receiptRecord, { allowOverwrite: false });

    if (check.nextStatus && check.nextStatus !== 'closed' && check.nextStatus !== task.status) {
      userCtx.store.setTask({ ...task, status: check.nextStatus }, { allowOverwrite: true });
    }

    userCtx.audit.record('task_payment_settled', null, {
      taskId,
      paymentId,
      worker: payment.worker,
      amountLamports: payment.amountLamports,
      resultHash: body.resultHash,
      receiptPda: receiptRecord.receiptPda,
    });

    return { payment: { ...payment, status: 'settled' }, receipt: receiptRecord };
  });

  app.post('/api/tasks/:taskId/revoke', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

    const now = Math.floor(Date.now() / 1000);
    const check = validateTaskTransition(task, { type: 'revoke' }, now);
    if (!check.valid) {
      return reply.status(400).send({ error: 'revoke_rejected', message: check.error });
    }

    const updated = { ...task, status: 'revoked' as const };
    userCtx.store.setTask(updated, { allowOverwrite: true });

    userCtx.audit.record('task_revoked', null, { taskId });
    return { task: updated };
  });

  app.post('/api/tasks/:taskId/refund', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

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

    const remainingLamports = Math.max(0, task.budgetLamports - task.spentLamports);
    const updated = { ...task, status: 'completed' as const };
    userCtx.store.setTask(updated, { allowOverwrite: true });

    userCtx.audit.record('task_refunded_and_closed', null, {
      taskId,
      refundedLamports: remainingLamports,
    });

    return { task: updated, refundedLamports: remainingLamports };
  });

  const MockServiceBody = z.object({
    taskId: z.string().trim().min(1).max(64),
    paymentId: z.string().trim().min(1).max(64).default('payment-0'),
    serviceId: z.string().trim().min(1).max(64),
    payload: z.record(z.unknown()).default({}),
  });

  app.post('/api/tasks/mock-service/run', async (req) => {
    const body = MockServiceBody.parse(req.body);
    const workerKeypair = Keypair.fromSeed(computeCanonicalSeed('NEXUS_DEFAULT_MOCK_WORKER_V1'));
    const workerPubkey = workerKeypair.publicKey.toBase58();

    const requestHash = computeReceiptHash({
      taskId: body.taskId,
      paymentId: body.paymentId,
      worker: workerPubkey,
      serviceId: body.serviceId,
      requestHash: JSON.stringify(body.payload),
      resultHash: 'evaluating',
      amountLamports: 0,
    });
    const resultPayload = {
      status: 'completed',
      serviceId: body.serviceId,
      evaluatedAt: new Date().toISOString(),
      outputSummary: `Service ${body.serviceId} executed computation successfully`,
    };
    const resultHash = computeTaskHash({
      owner: workerPubkey,
      taskId: body.taskId,
      budgetLamports: 100,
      perPaymentCapLamports: 100,
      expiry: 9999999999,
    });

    const canonicalReceiptMessage = `NEXUS_RECEIPT_V1:${body.taskId}:${body.paymentId}:${resultHash}`;
    const signatureBytes = nacl.sign.detached(
      new TextEncoder().encode(canonicalReceiptMessage),
      workerKeypair.secretKey,
    );
    const workerSignature = bs58.encode(signatureBytes);

    return {
      serviceId: body.serviceId,
      workerPubkey,
      workerSignature,
      requestHash,
      resultHash,
      resultPayload,
    };
  });
}
