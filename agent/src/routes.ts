import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  AllowlistEntrySchema,
  ModelActionSchema,
  PubkeySchema,
  solToLamports,
  type Policy,
} from '@nexus/shared';
import { explorerAddressUrl, getLamportBalance, isValidAddress, requestAirdrop } from './chain.js';
import { ApprovalError, approveRequest } from './approvals.js';
import type { AppContext } from './context.js';
import {
  dispenseInitialSeed,
  SeedTransferFailedError,
  SeedTransferOutcomeUnknownError,
} from './funder.js';
import { IdempotencyConflictError, runAction, runCommand, type AgentAction } from './pipeline.js';
import { SESSION_COOKIE_NAME } from './sessions.js';
import { LOCAL_ORIGIN_REGEX } from './config.js';

const CommandBody = z.object({
  prompt: z.string().trim().min(1).max(600),
  idempotencyKey: z.string().trim().max(120).optional(),
});

/** Structured actions from an external agent (MCP). Same action set as the planner, minus the non-executable one. */
const AgentActionBody = z.object({
  action: ModelActionSchema.refine(
    (action): action is AgentAction => action.type !== 'request_manual_approval',
    { message: 'request_manual_approval is not an executable action' },
  ),
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

  // Not under /api/actions/: that prefix is public for Blinks and skips session auth.
  app.post('/api/agent/intents', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = AgentActionBody.parse(req.body);
    try {
      const request = await runAction(userCtx, {
        action: body.action as AgentAction,
        idempotencyKey: body.idempotencyKey ?? null,
      });
      return { request };
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send({ error: 'idempotency_conflict', message: err.message });
      }
      throw err;
    }
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
}
