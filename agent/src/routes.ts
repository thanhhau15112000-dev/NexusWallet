import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  AGENT_ERROR_REMEDIATION,
  AllowlistEntrySchema,
  lamportsToSol,
  ModelActionSchema,
  PubkeySchema,
  solToLamports,
  spentLamportsInWindow,
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
  TASK_VAULT_PROGRAM_PUBKEY,
  executeTaskPaymentInstruction,
  settleWithReceiptInstruction,
  TASK_RECEIPT_ACCOUNT_SIZE,
} from '@nexus/shared';
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifyMessageSignature } from './crypto.js';
import {
  FEE_BUFFER_LAMPORTS,
  explorerAddressUrl,
  getLamportBalance,
  isValidAddress,
  requestAirdrop,
} from './chain.js';
import { ApprovalError, approveRequest, expirePendingApprovals } from './approvals.js';
import type { AppContext } from './context.js';
import {
  dispenseInitialSeed,
  SeedTransferFailedError,
  SeedTransferOutcomeUnknownError,
} from './funder.js';
import { IdempotencyConflictError, agentError, runAction, runCommand, type AgentAction } from './pipeline.js';
import { SESSION_COOKIE_NAME } from './sessions.js';
import { LOCAL_ORIGIN_REGEX } from './config.js';
import { submitTaskVaultInstruction } from './task-vault-chain.js';
import { loadOrCreateMcpToken, mcpOwnerFor } from './mcp-token.js';
import { registerRemoteMcp, remoteMcpUrl } from './mcp-remote.js';

function getMockWorkerKeypair(ctx: AppContext): Keypair {
  if (!ctx.mockWorker) throw new Error('mock worker keystore is not loaded');
  return ctx.mockWorker;
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
    || taskInfo.data.length < 207
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
    && data.subarray(175, 207).equals(expectedService);
}

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
  maxSolPerDay: z.number().nonnegative().max(100000).nullable().optional(),
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
  // MCP clients (remote /mcp or the local stdio bundle): a tenant token, accepted only for its read/propose routes.
  const mcpOwner = mcpOwnerFor(ctx.config.usersDir, req);
  if (mcpOwner && ctx.getUserContext) {
    return ctx.getUserContext(mcpOwner);
  }
  const boundOwner = ctx.store.getOwner();
  if (boundOwner && ctx.getUserContext) {
    return ctx.getUserContext(boundOwner);
  }
  return ctx;
}

/**
 * Ready-to-paste entries for the remote MCP endpoint: a URL plus the tenant token as a bearer
 * header, so nothing has to be installed or cloned on the client's machine.
 */
function mcpClientConfig(ctx: AppContext, owner: string, rotate: boolean) {
  const token = loadOrCreateMcpToken(ctx.config.usersDir, owner, { rotate });
  const url = remoteMcpUrl(ctx.config);
  const authorization = `Bearer ${token}`;
  return {
    owner,
    url,
    token,
    claudeCode: `claude mcp add --transport http nexuspay ${url} --header "Authorization: ${authorization}"`,
    codexToml: [
      '[mcp_servers.nexuspay]',
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
      'tool_timeout_sec = 90',
    ].join('\n'),
    antigravityJson: JSON.stringify(
      { mcpServers: { nexuspay: { serverUrl: url, headers: { Authorization: authorization } } } },
      null,
      2,
    ),
    // Claude Desktop's config file only starts local processes, so the mcp-remote bridge carries the header.
    claudeDesktopJson: JSON.stringify(
      {
        mcpServers: {
          nexuspay: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
            env: { AUTH_HEADER: authorization },
          },
        },
      },
      null,
      2,
    ),
  };
}

function publicPolicy(policy: Policy) {
  return {
    ...policy,
    maxSolPerTx: policy.maxSolLamportsPerTx / 1_000_000_000,
    maxSolPerDay: policy.maxSolLamportsPerDay === null ? null : policy.maxSolLamportsPerDay / 1_000_000_000,
  };
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
  registerRemoteMcp(app, ctx);
  app.get('/.well-known/actions.json', async (_req, reply) => {
    actionResponseHeaders(reply);
    return {
      rules: [{
        pathPattern: '/api/actions/approve/**',
        apiPath: '/api/actions/approve',
      }],
    };
  });

  // MCP connection details are only handed out to a wallet-signed session, never to an MCP token.
  app.get('/api/mcp/config', async (req, reply) => {
    const session = getSession(ctx, req);
    if (!session?.owner) return reply.status(401).send({ error: 'authentication_required' });
    reply.header('cache-control', 'no-store');
    return mcpClientConfig(ctx, session.owner, false);
  });

  app.post('/api/mcp/token/rotate', async (req, reply) => {
    const session = getSession(ctx, req);
    if (!session?.owner) return reply.status(401).send({ error: 'authentication_required' });
    reply.header('cache-control', 'no-store');
    return mcpClientConfig(ctx, session.owner, true);
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
    if (!ctx.config.authRequired) {
      loadOrCreateMcpToken(ctx.config.usersDir, pubkey);
    }
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
    expirePendingApprovals(userCtx);
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

    const currentPolicy = userCtx.store.getPolicy();
    const spentLamports = spentLamportsInWindow(userCtx.store.listRequests());
    const remainingLamports =
      currentPolicy.maxSolLamportsPerDay === null
        ? null
        : Math.max(0, currentPolicy.maxSolLamportsPerDay - spentLamports);

    const usage = {
      spentSol24h: lamportsToSol(spentLamports),
      remainingSol24h: remainingLamports === null ? null : lamportsToSol(remainingLamports),
    };

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
      mockWorker: userCtx.mockWorker ? { pubkey: userCtx.mockWorker.publicKey.toBase58() } : null,
      agent: {
        agentId: userCtx.config.AGENT_ID,
        pubkey: userCtx.agentPubkey,
        lamports,
        rpcError,
        explorerUrl: explorerAddressUrl(userCtx.agentPubkey, userCtx.config.SOLANA_CLUSTER),
        // Upper bound the pre-flight balance check reserves on top of a SOL transfer amount.
        feeReserveLamports: FEE_BUFFER_LAMPORTS,
        frozen: userCtx.store.isFrozen(),
        frozenAt: userCtx.store.getFrozen()?.at ?? null,
      },
      policy: publicPolicy(currentPolicy),
      usage,
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
    const current = userCtx.store.getPolicy();
    const maxSolLamportsPerDay =
      body.maxSolPerDay !== undefined
        ? (body.maxSolPerDay === null ? null : solToLamports(body.maxSolPerDay))
        : current.maxSolLamportsPerDay;
    const policy = userCtx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(body.maxSolPerTx),
      maxSolLamportsPerDay,
      allowedRecipients: body.allowedRecipients,
      allowedMints: body.allowedMints,
      maxTokenAmountByMint: body.maxTokenAmountByMint,
    });
    userCtx.audit.record('policy.updated', null, { policy });
    return { policy: publicPolicy(policy) };
  });

  app.post('/api/agent/freeze', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    const currentFrozen = userCtx.store.getFrozen();
    if (currentFrozen) {
      return { frozen: true, frozenAt: currentFrozen.at };
    }
    const now = new Date().toISOString();
    userCtx.store.setFrozen(true, now);
    userCtx.audit.record('agent.frozen', null, { frozenAt: now });

    const pending = userCtx.store.listRequests().filter((r) => r.status === 'pending_approval');
    for (const r of pending) {
      userCtx.store.putRequest({
        ...r,
        status: 'denied',
        error: agentError('AGENT_FROZEN', 'agent was frozen by owner; pending approval cancelled'),
      });
      userCtx.audit.record('tx.blocked', r.id, { reason: 'agent_frozen' });
    }

    return { frozen: true, frozenAt: now };
  });

  app.post('/api/agent/unfreeze', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const currentFrozen = userCtx.store.getFrozen();
    if (!currentFrozen) {
      return { frozen: false, frozenAt: null };
    }
    userCtx.store.setFrozen(false);
    userCtx.audit.record('agent.unfrozen', null, { unfrozenAt: new Date().toISOString() });
    return { frozen: false, frozenAt: null };
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
        return reply.status(409).send({
          error: 'IDEMPOTENCY_CONFLICT',
          message: err.message,
          remediation: AGENT_ERROR_REMEDIATION.IDEMPOTENCY_CONFLICT,
          details: { idempotencyKey: body.idempotencyKey ?? null },
        });
      }
      throw err;
    }
  });

  app.get('/api/requests', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    return { requests: userCtx.store.listRequests() };
  });

  app.get('/api/requests/:id', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
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
    allowedWorker: PubkeySchema.optional(),
    allowedServiceId: z.string().trim().min(1).max(64).optional(),
    txSignature: z.string().trim().optional(),
    isSimulated: z.boolean().optional(),
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
      expiry: record.expiry,
      pda: record.pda,
      vaultPda: record.vaultPda,
      txSignature: record.txSignature,
      isSimulated: record.isSimulated,
    });

    return { task: record };
  });

  const ExecutePaymentBody = z.object({
    paymentId: z.string().trim().min(1).max(64),
    worker: PubkeySchema,
    serviceId: z.string().trim().min(1).max(64),
    amountLamports: z.number().int().positive(),
    requestHash: z.string().trim().min(1),
    txSignature: z.string().trim().optional(),
    isSimulated: z.boolean().optional(),
  });

  app.post('/api/tasks/:taskId/payments', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    if (userCtx.store.isFrozen()) {
      userCtx.audit.record('tx.blocked', null, { reason: 'agent_frozen', taskId });
      return reply.status(409).send({
        error: 'AGENT_FROZEN',
        code: 'AGENT_FROZEN',
        message: 'agent is frozen by owner',
        remediation: AGENT_ERROR_REMEDIATION.AGENT_FROZEN,
      });
    }
    const body = ExecutePaymentBody.parse(req.body);

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

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
      const mockWorker = getMockWorkerKeypair(userCtx);
      if (task.agentSigner !== userCtx.agentPubkey) {
        return reply.status(409).send({ error: 'agent_signer_mismatch' });
      }
      if (body.worker !== mockWorker.publicKey.toBase58()) {
        return reply.status(400).send({
          error: 'unsupported_onchain_worker',
          message: 'on-chain demo payments currently require the configured mock worker signer',
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

  const SettlePaymentBody = z.object({
    resultHash: z.string().trim().min(1),
    workerPubkey: PubkeySchema,
    workerSignature: z.string().trim().min(1),
    txSignature: z.string().trim().optional(),
    isSimulated: z.boolean().optional(),
  });

  app.post('/api/tasks/:taskId/payments/:paymentId/settle', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId, paymentId } = req.params as { taskId: string; paymentId: string };
    if (userCtx.store.isFrozen()) {
      userCtx.audit.record('tx.blocked', null, { reason: 'agent_frozen', taskId, paymentId });
      return reply.status(409).send({
        error: 'AGENT_FROZEN',
        code: 'AGENT_FROZEN',
        message: 'agent is frozen by owner',
        remediation: AGENT_ERROR_REMEDIATION.AGENT_FROZEN,
      });
    }
    const body = SettlePaymentBody.parse(req.body);

    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });

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
    const [receiptPda] = deriveReceiptPda(taskPda, paymentId);
    const isSimulated = task.isSimulated !== false;
    let txSignature: string | undefined;
    if (!isSimulated) {
      const workerKeypair = getMockWorkerKeypair(userCtx);
      if (workerKeypair.publicKey.toBase58() !== payment.worker) {
        return reply.status(400).send({
          error: 'unsupported_onchain_worker',
          message: 'only the configured mock worker can sign on-chain demo settlements',
        });
      }
      try {
        // The demo worker holds no funds of its own: the agent pays the fee and tops the worker
        // up so it can fund the receipt PDA and still stay rent-exempt afterwards.
        const [receiptRent, systemAccountRent, workerLamports] = await Promise.all([
          userCtx.connection.getMinimumBalanceForRentExemption(TASK_RECEIPT_ACCOUNT_SIZE),
          userCtx.connection.getMinimumBalanceForRentExemption(0),
          userCtx.connection.getBalance(workerKeypair.publicKey, 'confirmed'),
        ]);
        const instructions: TransactionInstruction[] = [];
        const topUp = receiptRent + systemAccountRent - workerLamports;
        if (topUp > 0) {
          instructions.push(SystemProgram.transfer({
            fromPubkey: userCtx.signer.publicKey,
            toPubkey: workerKeypair.publicKey,
            lamports: topUp,
          }));
        }
        instructions.push(settleWithReceiptInstruction({
          taskCapability: taskPda,
          escrow: new PublicKey(payment.escrowPda!),
          paymentId,
          worker: workerKeypair.publicKey,
          agentSigner: new PublicKey(task.agentSigner),
          resultHash: body.resultHash,
        }));
        txSignature = await submitTaskVaultInstruction(userCtx.connection, instructions, userCtx.signer, [workerKeypair]);
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
  });

  app.post('/api/tasks/:taskId/revoke', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const body = z.object({ txSignature: z.string().trim().min(32).optional() }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
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

  app.post('/api/tasks/:taskId/refund', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { taskId } = req.params as { taskId: string };
    const body = z.object({ txSignature: z.string().trim().min(32).optional() }).parse(req.body ?? {});
    const task = userCtx.store.getTask(taskId);
    if (!task) return reply.status(404).send({ error: 'task_not_found' });
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
      const [taskAccount, vaultAccount] = await Promise.all([
        userCtx.connection.getAccountInfo(taskPda, 'confirmed'),
        userCtx.connection.getAccountInfo(vaultPda, 'confirmed'),
      ]);
      if (taskAccount || vaultAccount) {
        return reply.status(409).send({ error: 'onchain_task_not_closed' });
      }
    }

    const latestTask = userCtx.store.getTask(taskId)!;
    const remainingLamports = Math.max(0, latestTask.budgetLamports - latestTask.spentLamports);
    const updated = { ...latestTask, status: 'completed' as const, isClosed: true };
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
    const workerKeypair = getMockWorkerKeypair(ctx);
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
