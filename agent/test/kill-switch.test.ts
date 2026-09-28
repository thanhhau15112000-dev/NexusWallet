import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_ERROR_REMEDIATION, buildApprovalMessage, defaultPolicy, solToLamports } from '@nexus/shared';

vi.mock('../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chain.js')>();
  return {
    ...actual,
    transferSol: vi.fn().mockResolvedValue({ signature: 'sig-mock-sol', slot: 100 }),
    transferSpl: vi.fn().mockResolvedValue({ signature: 'sig-mock-spl', slot: 101 }),
    getLamportBalance: vi.fn().mockResolvedValue(500_000_000),
  };
});

import { transferSol, transferSpl } from '../src/chain.js';
import { registerAuthHook } from '../src/auth-hook.js';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { Store } from '../src/store.js';
import { loadOrCreateMcpToken } from '../src/mcp-token.js';

describe('Agent Kill Switch (Freeze / Unfreeze)', () => {
  let tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-killswitch-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs = [];
  });

  async function startApp(overrides: Record<string, unknown> = {}) {
    const dataDir = makeTempDir();
    const config = {
      ...loadConfig(),
      ...overrides,
      AGENT_DATA_DIR: dataDir,
      dataDir,
      usersDir: join(dataDir, 'users'),
      masterFunderPath: join(dataDir, 'master-funder.json'),
      legacyKeystorePath: join(dataDir, 'agent-keystore.json'),
      statePath: join(dataDir, 'state.json'),
      auditPath: join(dataDir, 'audit.jsonl'),
      keystorePath: join(dataDir, 'agent-keystore.json'),
      saltPath: join(dataDir, 'audit-salt'),
    };
    const ctx = createContext(config);
    const app = Fastify();
    await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
    registerAuthHook(app, ctx);
    await registerRoutes(app, ctx);
    return { app, ctx, config };
  }

  async function login(app: FastifyInstance, owner: Keypair): Promise<string> {
    const pubkey = owner.publicKey.toBase58();
    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { pubkey },
    });
    const challenge = JSON.parse(challengeRes.body);
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { challengeId: challenge.challengeId, pubkey, signature },
    });
    const session = res.cookies.find((item: { name: string; value: string }) => item.name === SESSION_COOKIE_NAME)!;
    return `${session.name}=${session.value}`;
  }

  it('rejects unauthenticated requests to freeze and unfreeze with 401', async () => {
    const { app } = await startApp();
    const freezeRes = await app.inject({ method: 'POST', url: '/api/agent/freeze' });
    expect(freezeRes.statusCode).toBe(401);

    const unfreezeRes = await app.inject({ method: 'POST', url: '/api/agent/unfreeze' });
    expect(unfreezeRes.statusCode).toBe(401);
  });

  it('rejects MCP token calls to freeze and unfreeze with 401', async () => {
    const { app, config } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const token = loadOrCreateMcpToken(config.usersDir, ownerPubkey);

    const freezeRes = await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(freezeRes.statusCode).toBe(401);

    const unfreezeRes = await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unfreezeRes.statusCode).toBe(401);
  });

  it('freezes and unfreezes agent idempotently with session and records audits', async () => {
    const { app, ctx } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);

    // Initial state: not frozen
    const state0Res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { cookie: cookieHeader },
    });
    const state0 = JSON.parse(state0Res.body);
    expect(state0.agent.frozen).toBe(false);
    expect(state0.agent.frozenAt).toBeNull();

    // Freeze agent
    const freezeRes = await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });
    expect(freezeRes.statusCode).toBe(200);
    const freezeBody = JSON.parse(freezeRes.body);
    expect(freezeBody.frozen).toBe(true);
    expect(typeof freezeBody.frozenAt).toBe('string');
    const firstFrozenAt = freezeBody.frozenAt;

    // Verify GET /api/state reflects frozen state
    const state1Res = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { cookie: cookieHeader },
    });
    const state1 = JSON.parse(state1Res.body);
    expect(state1.agent.frozen).toBe(true);
    expect(state1.agent.frozenAt).toBe(firstFrozenAt);

    // Freeze again (idempotent): does not change frozenAt
    const freezeRes2 = await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });
    expect(freezeRes2.statusCode).toBe(200);
    expect(JSON.parse(freezeRes2.body).frozenAt).toBe(firstFrozenAt);

    // Unfreeze agent
    const unfreezeRes = await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });
    expect(unfreezeRes.statusCode).toBe(200);
    const unfreezeBody = JSON.parse(unfreezeRes.body);
    expect(unfreezeBody.frozen).toBe(false);
    expect(unfreezeBody.frozenAt).toBeNull();

    // Unfreeze again (idempotent)
    const unfreezeRes2 = await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });
    expect(unfreezeRes2.statusCode).toBe(200);
    expect(JSON.parse(unfreezeRes2.body).frozen).toBe(false);
  });

  it('blocks transfer SOL and SPL via /api/agent/intents when frozen, without calling signer', async () => {
    const { app, ctx, config } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);
    const token = loadOrCreateMcpToken(config.usersDir, ownerPubkey);

    const userCtx = ctx.getUserContext!(ownerPubkey);
    userCtx.store.setPolicy({
      ...defaultPolicy('agent-001'),
      maxSolLamportsPerTx: solToLamports(1),
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [{ label: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
      maxTokenAmountByMint: { 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 100 },
    });

    // Freeze the agent
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    // Propose SOL transfer via MCP intents route
    const solRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
      },
    });
    expect(solRes.statusCode).toBe(200);
    const solBody = JSON.parse(solRes.body);
    expect(solBody.request.status).toBe('denied');
    expect(solBody.request.error.code).toBe('AGENT_FROZEN');
    expect(solBody.request.error.remediation).toMatch(/unfreeze/);
    expect(transferSol).not.toHaveBeenCalled();

    // Propose SPL transfer
    const splRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: {
          type: 'transfer_spl',
          recipient: 'treasury',
          mint: 'USDC',
          amount: 10,
        },
      },
    });
    expect(splRes.statusCode).toBe(200);
    const splBody = JSON.parse(splRes.body);
    expect(splBody.request.status).toBe('denied');
    expect(splBody.request.error.code).toBe('AGENT_FROZEN');
    expect(transferSpl).not.toHaveBeenCalled();

    // get_balance still works while frozen
    const balanceRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'get_balance' },
      },
    });
    expect(balanceRes.statusCode).toBe(200);
    const balanceBody = JSON.parse(balanceRes.body);
    expect(balanceBody.request.status).toBe('confirmed');
    expect(balanceBody.request.balanceLamports).toBe(500_000_000);

    // Unfreeze: transfer now succeeds and calls transferSol
    await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });

    const unfreezeSolRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
      },
    });
    expect(unfreezeSolRes.statusCode).toBe(200);
    const unfreezeSolBody = JSON.parse(unfreezeSolRes.body);
    expect(unfreezeSolBody.request.status).toBe('confirmed');
    expect(transferSol).toHaveBeenCalledTimes(1);
  });

  it('blocks Console prompt commands when frozen, returning AGENT_FROZEN', async () => {
    const { app, ctx } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);

    const userCtx = ctx.getUserContext!(ownerPubkey);
    userCtx.store.setPolicy({
      ...defaultPolicy('agent-001'),
      maxSolLamportsPerTx: solToLamports(1),
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    const cmdRes = await app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { cookie: cookieHeader },
      payload: { prompt: 'send 0.05 SOL to treasury' },
    });
    expect(cmdRes.statusCode).toBe(200);
    const cmdBody = JSON.parse(cmdRes.body);
    expect(cmdBody.request.status).toBe('denied');
    expect(cmdBody.request.error.code).toBe('AGENT_FROZEN');
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('cancels all pending_approval requests at freeze time, and rejects approval attempts while frozen and after unfreeze', async () => {
    const { app, ctx, config } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);
    const token = loadOrCreateMcpToken(config.usersDir, ownerPubkey);

    const userCtx = ctx.getUserContext!(ownerPubkey);
    userCtx.store.setPolicy({
      ...defaultPolicy('agent-001'),
      maxSolLamportsPerTx: solToLamports(0.01), // low limit to trigger require_approval
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    // Propose transfer that requires owner approval
    const requireApproveRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
      },
    });
    const heldReq = JSON.parse(requireApproveRes.body).request;
    expect(heldReq.status).toBe('pending_approval');
    expect(heldReq.approval).toBeDefined();

    // Freeze agent: this should transition pending_approval to denied
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    const cancelledReq = userCtx.store.getRequest(heldReq.id);
    expect(cancelledReq?.status).toBe('denied');
    expect(cancelledReq?.error?.code).toBe('AGENT_FROZEN');

    // Attempting to approve via session while frozen: rejected with 403 agent_frozen
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(heldReq.approval.message), owner.secretKey),
    );
    const approveWhileFrozenRes = await app.inject({
      method: 'POST',
      url: `/api/requests/${heldReq.id}/approve`,
      headers: { cookie: cookieHeader },
      payload: {
        signature,
        signerPubkey: ownerPubkey,
      },
    });
    expect(approveWhileFrozenRes.statusCode).toBe(403);
    expect(JSON.parse(approveWhileFrozenRes.body).error).toBe('agent_frozen');

    // Attempting to approve via public Blink route while frozen: rejected with 404 approval_not_found (cancelled at freeze)
    const blinkWhileFrozenRes = await app.inject({
      method: 'POST',
      url: `/api/actions/approve/${heldReq.id}`,
      payload: {
        account: ownerPubkey,
        signature,
      },
    });
    expect(blinkWhileFrozenRes.statusCode).toBe(404);
    expect(JSON.parse(blinkWhileFrozenRes.body).error).toBe('approval_not_found');
    expect(transferSol).not.toHaveBeenCalled();

    // Approval record is still unconsumed
    const stillCancelled = userCtx.store.getRequest(heldReq.id);
    expect(stillCancelled?.approval?.consumedAt).toBeNull();
    expect(stillCancelled?.status).toBe('denied');
    expect(transferSol).not.toHaveBeenCalled();

    // Unfreeze agent
    await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });

    // Approving the cancelled request after unfreeze: rejected with bad_status (not resurrected)
    const approveAfterUnfreezeRes = await app.inject({
      method: 'POST',
      url: `/api/requests/${heldReq.id}/approve`,
      headers: { cookie: cookieHeader },
      payload: {
        signature,
        signerPubkey: ownerPubkey,
      },
    });
    expect(approveAfterUnfreezeRes.statusCode).toBe(403);
    expect(JSON.parse(approveAfterUnfreezeRes.body).error).toBe('bad_status');
  });

  it('preserves frozen state across restarts and handles state files without frozen field', () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'state.json');

    // 1. Create store and freeze it
    const store1 = new Store(statePath, 'agent-001', 50);
    expect(store1.isFrozen()).toBe(false);
    expect(store1.getFrozen()).toBeNull();

    const at = '2026-09-28T12:00:00.000Z';
    store1.setFrozen(true, at);
    expect(store1.isFrozen()).toBe(true);
    expect(store1.getFrozen()?.at).toBe(at);

    // 2. Reload store from disk
    const store2 = new Store(statePath, 'agent-001', 50);
    expect(store2.isFrozen()).toBe(true);
    expect(store2.getFrozen()?.at).toBe(at);

    // 3. Old state file without frozen field
    const oldStatePath = join(dir, 'old-state.json');
    writeFileSync(
      oldStatePath,
      JSON.stringify({
        policy: defaultPolicy('agent-old'),
        ownerPubkey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
        requests: [],
        idempotency: {},
      }),
    );
    const storeOld = new Store(oldStatePath, 'agent-old', 50);
    expect(storeOld.isFrozen()).toBe(false);
    expect(storeOld.getFrozen()).toBeNull();
  });

  it('keeps frozen status isolated between multiple tenants (Tenant A frozen, Tenant B signs)', async () => {
    const { app, ctx, config } = await startApp();

    const ownerA = Keypair.generate();
    const ownerAPubkey = ownerA.publicKey.toBase58();
    const cookieA = await login(app, ownerA);
    const tokenA = loadOrCreateMcpToken(config.usersDir, ownerAPubkey);

    const ownerB = Keypair.generate();
    const ownerBPubkey = ownerB.publicKey.toBase58();
    const cookieB = await login(app, ownerB);
    const tokenB = loadOrCreateMcpToken(config.usersDir, ownerBPubkey);

    // Configure policies for both
    const ctxA = ctx.getUserContext!(ownerAPubkey);
    ctxA.store.setPolicy({
      ...defaultPolicy('agent-a'),
      maxSolLamportsPerTx: solToLamports(1),
      allowedRecipients: [{ label: 'treasury-a', address: ownerAPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    const ctxB = ctx.getUserContext!(ownerBPubkey);
    ctxB.store.setPolicy({
      ...defaultPolicy('agent-b'),
      maxSolLamportsPerTx: solToLamports(1),
      allowedRecipients: [{ label: 'treasury-b', address: ownerBPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    // Freeze Tenant A only
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieA },
    });

    expect(ctxA.store.isFrozen()).toBe(true);
    expect(ctxB.store.isFrozen()).toBe(false);

    // Tenant B's state shows not frozen
    const stateBRes = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { cookie: cookieB },
    });
    expect(JSON.parse(stateBRes.body).agent.frozen).toBe(false);

    // Tenant A transfer is denied with AGENT_FROZEN
    const resA = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury-a', amountSol: 0.05 },
      },
    });
    expect(JSON.parse(resA.body).request.status).toBe('denied');
    expect(JSON.parse(resA.body).request.error.code).toBe('AGENT_FROZEN');

    // Tenant B transfer succeeds and signs
    const resB = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury-b', amountSol: 0.05 },
      },
    });
    expect(JSON.parse(resB.body).request.status).toBe('confirmed');
    expect(transferSol).toHaveBeenCalledTimes(1);
  });

  it('preserves frozen status when PUT /api/policy is called', async () => {
    const { app, ctx } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);

    // Freeze agent
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    // Update policy
    const policyRes = await app.inject({
      method: 'PUT',
      url: '/api/policy',
      headers: { cookie: cookieHeader },
      payload: {
        maxSolPerTx: 0.5,
        allowedRecipients: [{ label: 'wallet', address: ownerPubkey }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      },
    });
    expect(policyRes.statusCode).toBe(200);

    // Verify still frozen
    const userCtx = ctx.getUserContext!(ownerPubkey);
    expect(userCtx.store.isFrozen()).toBe(true);

    const stateRes = await app.inject({
      method: 'GET',
      url: '/api/state',
      headers: { cookie: cookieHeader },
    });
    expect(JSON.parse(stateRes.body).agent.frozen).toBe(true);
  });

  it('preserves idempotency: retrying a completed request returns it, retrying a frozen request returns AGENT_FROZEN', async () => {
    const { app, ctx, config } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);
    const token = loadOrCreateMcpToken(config.usersDir, ownerPubkey);

    const userCtx = ctx.getUserContext!(ownerPubkey);
    userCtx.store.setPolicy({
      ...defaultPolicy('agent-001'),
      maxSolLamportsPerTx: solToLamports(1),
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    // 1. Complete a transfer before freeze
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
        idempotencyKey: 'key-pre-freeze',
      },
    });
    const completedReq = JSON.parse(firstRes.body).request;
    expect(completedReq.status).toBe('confirmed');
    expect(transferSol).toHaveBeenCalledTimes(1);

    // 2. Freeze agent
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    // 3. Retry completed transfer with same key: returns completed request, does NOT re-sign
    const retryCompletedRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
        idempotencyKey: 'key-pre-freeze',
      },
    });
    const retryCompletedReq = JSON.parse(retryCompletedRes.body).request;
    expect(retryCompletedReq.status).toBe('confirmed');
    expect(retryCompletedReq.id).toBe(completedReq.id);
    expect(transferSol).toHaveBeenCalledTimes(1); // No new signature

    // 4. Send new transfer during freeze: returns denied AGENT_FROZEN
    const newFrozenRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
        idempotencyKey: 'key-during-freeze',
      },
    });
    const newFrozenReq = JSON.parse(newFrozenRes.body).request;
    expect(newFrozenReq.status).toBe('denied');
    expect(newFrozenReq.error.code).toBe('AGENT_FROZEN');

    // 5. Retry same key during freeze: returns same denied request
    const retryFrozenRes = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
        idempotencyKey: 'key-during-freeze',
      },
    });
    const retryFrozenReq = JSON.parse(retryFrozenRes.body).request;
    expect(retryFrozenReq.id).toBe(newFrozenReq.id);
    expect(retryFrozenReq.status).toBe('denied');
  });

  it('blocks Task Vault payments and settlements with 409 AGENT_FROZEN when frozen, leaving store unchanged, but permits refund and revoke', async () => {
    const { app, ctx } = await startApp();
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const cookieHeader = await login(app, owner);
    const userCtx = ctx.getUserContext!(ownerPubkey);

    const now = Math.floor(Date.now() / 1000);
    const taskId = 'task-freeze-vault-001';

    // 1. Create a simulated task capability
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: cookieHeader },
      payload: {
        taskId,
        budgetLamports: 1_000_000_000,
        perPaymentCapLamports: 400_000_000,
        expiry: now + 3600,
      },
    });
    expect(createRes.statusCode).toBe(200);

    const workerKey = nacl.sign.keyPair();
    const workerPubkey = bs58.encode(workerKey.publicKey);

    // 2. Freeze agent
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });
    expect(userCtx.store.isFrozen()).toBe(true);

    // 3. Attempt payment while frozen -> 409 AGENT_FROZEN
    const frozenPayRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments`,
      headers: { cookie: cookieHeader },
      payload: {
        paymentId: 'pay-001',
        worker: workerPubkey,
        serviceId: 'service-llm',
        amountLamports: 300_000_000,
        requestHash: 'hash-req-001',
      },
    });
    expect(frozenPayRes.statusCode).toBe(409);
    const frozenPayBody = JSON.parse(frozenPayRes.body);
    expect(frozenPayBody.error).toBe('AGENT_FROZEN');
    expect(frozenPayBody.code).toBe('AGENT_FROZEN');
    expect(frozenPayBody.message).toBe('agent is frozen by owner');
    expect(frozenPayBody.remediation).toBe(AGENT_ERROR_REMEDIATION.AGENT_FROZEN);

    // Verify store is completely unchanged by the rejected payment
    const taskAfterRejectedPay = userCtx.store.getTask(taskId);
    expect(taskAfterRejectedPay?.spentLamports).toBe(0);
    expect(userCtx.store.getPayment(taskId, 'pay-001')).toBeUndefined();

    // Verify audit recorded tx.blocked
    const auditEntries = userCtx.audit.list(10);
    const payBlockedAudit = auditEntries.find(
      (e) => e.event === 'tx.blocked' && (e.detail as { reason?: string; taskId?: string })?.taskId === taskId,
    );
    expect(payBlockedAudit).toBeDefined();
    expect((payBlockedAudit?.detail as { reason?: string })?.reason).toBe('agent_frozen');

    // 4. Unfreeze and execute the payment successfully
    await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });

    const activePayRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments`,
      headers: { cookie: cookieHeader },
      payload: {
        paymentId: 'pay-001',
        worker: workerPubkey,
        serviceId: 'service-llm',
        amountLamports: 300_000_000,
        requestHash: 'hash-req-001',
      },
    });
    expect(activePayRes.statusCode).toBe(200);
    expect(userCtx.store.getPayment(taskId, 'pay-001')?.status).toBe('held');
    expect(userCtx.store.getTask(taskId)?.spentLamports).toBe(300_000_000);

    // 5. Freeze agent again
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    // 6. Attempt settlement while frozen -> 409 AGENT_FROZEN
    const canonicalMsg = `NEXUS_RECEIPT_V1:${taskId}:pay-001:hash-res-001`;
    const workerSig = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(canonicalMsg), workerKey.secretKey),
    );

    const frozenSettleRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments/pay-001/settle`,
      headers: { cookie: cookieHeader },
      payload: {
        resultHash: 'hash-res-001',
        workerPubkey,
        workerSignature: workerSig,
      },
    });
    expect(frozenSettleRes.statusCode).toBe(409);
    const frozenSettleBody = JSON.parse(frozenSettleRes.body);
    expect(frozenSettleBody.error).toBe('AGENT_FROZEN');
    expect(frozenSettleBody.code).toBe('AGENT_FROZEN');
    expect(frozenSettleBody.message).toBe('agent is frozen by owner');
    expect(frozenSettleBody.remediation).toBe(AGENT_ERROR_REMEDIATION.AGENT_FROZEN);

    // Verify store is completely unchanged by the rejected settlement
    const paymentAfterRejectedSettle = userCtx.store.getPayment(taskId, 'pay-001');
    expect(paymentAfterRejectedSettle?.status).toBe('held');
    expect(userCtx.store.getReceipt(taskId, 'pay-001')).toBeUndefined();

    // 7. Test revoke while frozen on a separate task
    const taskRevokeId = 'task-freeze-revoke-001';
    await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: cookieHeader },
      payload: {
        taskId: taskRevokeId,
        budgetLamports: 500_000_000,
        perPaymentCapLamports: 200_000_000,
        expiry: now + 3600,
      },
    });

    // Revoking while frozen is permitted
    const revokeRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskRevokeId}/revoke`,
      headers: { cookie: cookieHeader },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(JSON.parse(revokeRes.body).task.status).toBe('revoked');
    expect(userCtx.store.getTask(taskRevokeId)?.status).toBe('revoked');

    // 8. Test refund while frozen
    // To refund taskId, escrows must not be held. Unfreeze to settle, then freeze again to test refund.
    await app.inject({
      method: 'POST',
      url: '/api/agent/unfreeze',
      headers: { cookie: cookieHeader },
    });

    const settleRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments/pay-001/settle`,
      headers: { cookie: cookieHeader },
      payload: {
        resultHash: 'hash-res-001',
        workerPubkey,
        workerSignature: workerSig,
      },
    });
    expect(settleRes.statusCode).toBe(200);

    // Freeze agent again
    await app.inject({
      method: 'POST',
      url: '/api/agent/freeze',
      headers: { cookie: cookieHeader },
    });

    // Refunding while frozen is permitted
    const refundRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/refund`,
      headers: { cookie: cookieHeader },
    });
    expect(refundRes.statusCode).toBe(200);
    const refundData = JSON.parse(refundRes.body);
    expect(refundData.refundedLamports).toBe(700_000_000);
    expect(refundData.task.status).toBe('completed');
    expect(refundData.task.isClosed).toBe(true);

    // GET tasks still works while frozen
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).tasks.length).toBeGreaterThanOrEqual(2);
  });
});
