import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPolicy, solToLamports } from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chain.js')>();
  return {
    ...actual,
    transferSol: vi.fn().mockResolvedValue({ signature: 'sig-daily-cap', slot: 10 }),
    getLamportBalance: vi.fn().mockResolvedValue(10_000_000_000),
  };
});

import { transferSol } from '../src/chain.js';
import { runAction } from '../src/pipeline.js';
import { registerRoutes } from '../src/routes.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import type { AppContext } from '../src/context.js';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const STRANGER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const tempDirs: string[] = [];

function makeContext(options: {
  maxSolPerTx?: number;
  maxSolPerDay?: number | null;
} = {}): AppContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-daily-cap-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(options.maxSolPerTx ?? 0.1),
    maxSolLamportsPerDay: options.maxSolPerDay !== undefined && options.maxSolPerDay !== null
      ? solToLamports(options.maxSolPerDay)
      : null,
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [],
    maxTokenAmountByMint: {},
  });

  return {
    config: {
      AGENT_ID: 'agent-001',
      SOLANA_CLUSTER: 'devnet',
      APPROVAL_TTL_SECONDS: 300,
      allowedOrigins: [],
    } as unknown as AppContext['config'],
    store,
    audit: { record: vi.fn() } as never,
    model: {
      understand: vi.fn(),
      plan: vi.fn(),
      describe: () => ({ stage1: 'mock', stage2: 'mock', mode: 'mock' }),
    } as never,
    connection: { getBalance: vi.fn().mockResolvedValue(10_000_000_000) } as never,
    signer: {} as never,
    agentPubkey: TREASURY,
    ownerPinned: false,
    sessions: new SessionManager(TREASURY, 1800),
  };
}

afterEach(() => {
  vi.mocked(transferSol).mockClear();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Daily SOL cap pipeline & concurrency', () => {
  it('auto-approves a chain of transfers until daily cap is reached, then requires approval', async () => {
    // Daily cap: 0.15 SOL, per-tx limit: 0.1 SOL
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.15 });

    // Transfer 1: 0.05 SOL -> auto-approved and confirmed
    const req1 = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });
    expect(req1.status).toBe('confirmed');

    // Transfer 2: 0.05 SOL -> auto-approved and confirmed
    const req2 = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });
    expect(req2.status).toBe('confirmed');

    // Transfer 3: 0.05 SOL -> exactly reaches the 0.15 SOL daily cap -> auto-approved
    const req3 = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });
    expect(req3.status).toBe('confirmed');

    // Transfer 4: 0.01 SOL -> exceeds cap by 0.01 SOL -> pending_approval with DAILY_LIMIT_EXCEEDED
    const req4 = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.01 },
    });
    expect(req4.status).toBe('pending_approval');
    expect(req4.decision?.verdict).toBe('require_approval');
    expect(req4.decision?.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(req4.decision?.details).toEqual({
      limitSol: 0.15,
      limitLamports: 150_000_000,
      spentSol: 0.15,
      spentLamports: 150_000_000,
      requestedSol: 0.01,
      requestedLamports: 10_000_000,
      remainingSol: 0,
      remainingLamports: 0,
    });
  });

  it('prevents concurrent transfers (Promise.all) from exceeding the daily cap', async () => {
    // Daily cap: 0.12 SOL, per-tx: 0.1 SOL
    // Two concurrent transfers of 0.08 SOL each (each is < 0.1 per-tx and < 0.12 cap, but 0.16 > 0.12)
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.12 });

    const [resA, resB] = await Promise.all([
      runAction(ctx, { action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.08 } }),
      runAction(ctx, { action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.08 } }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual(['confirmed', 'pending_approval']);

    const heldReq = resA.status === 'pending_approval' ? resA : resB;
    expect(heldReq.decision?.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(heldReq.decision?.details?.spentSol).toBe(0.08);
    expect(heldReq.decision?.details?.remainingSol).toBe(0.04);
  });

  it('does not double count against daily cap on idempotency retry', async () => {
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.15 });

    const first = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.1 },
      idempotencyKey: 'idem-daily-1',
    });
    expect(first.status).toBe('confirmed');

    // Retry with the same key
    const second = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.1 },
      idempotencyKey: 'idem-daily-1',
    });
    expect(second.id).toBe(first.id);

    // Now another 0.05 SOL transfer should still be allowed since total spent is 0.1, not 0.2
    const third = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });
    expect(third.status).toBe('confirmed');
  });

  it('preserves allowlist priority over daily cap check', async () => {
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.05 });
    // Already spent 0.05
    await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });

    // Send to stranger
    const result = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: STRANGER, amountSol: 0.01 },
    });
    expect(result.status).toBe('denied');
    expect(result.decision?.code).toBe('RECIPIENT_NOT_IN_ALLOWLIST');
  });

  it('preserves kill switch priority: frozen agent returns AGENT_FROZEN instead of DAILY_LIMIT_EXCEEDED', async () => {
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.05 });
    ctx.store.setFrozen(true);

    const result = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.06 },
    });
    expect(result.status).toBe('denied');
    expect(result.decision?.code).toBe('AGENT_FROZEN');
  });
});

describe('API routes: PUT /api/policy & GET /api/state', () => {
  it('updates, preserves, and clears maxSolPerDay via PUT /api/policy', async () => {
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: null });
    const app = Fastify();
    await registerRoutes(app, ctx);

    // 1. Set daily cap to 0.5 SOL
    const res1 = await app.inject({
      method: 'PUT',
      url: '/api/policy',
      payload: {
        maxSolPerTx: 0.1,
        maxSolPerDay: 0.5,
        allowedRecipients: [{ label: 'treasury', address: TREASURY }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().policy.maxSolPerDay).toBe(0.5);
    expect(ctx.store.getPolicy().maxSolLamportsPerDay).toBe(500_000_000);

    // 2. Put policy without maxSolPerDay -> preserves current cap (0.5 SOL)
    const res2 = await app.inject({
      method: 'PUT',
      url: '/api/policy',
      payload: {
        maxSolPerTx: 0.2,
        allowedRecipients: [{ label: 'treasury', address: TREASURY }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().policy.maxSolPerTx).toBe(0.2);
    expect(res2.json().policy.maxSolPerDay).toBe(0.5);
    expect(ctx.store.getPolicy().maxSolLamportsPerDay).toBe(500_000_000);

    // 3. Put policy with maxSolPerDay: null -> clears daily cap
    const res3 = await app.inject({
      method: 'PUT',
      url: '/api/policy',
      payload: {
        maxSolPerTx: 0.2,
        maxSolPerDay: null,
        allowedRecipients: [{ label: 'treasury', address: TREASURY }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      },
    });
    expect(res3.statusCode).toBe(200);
    expect(res3.json().policy.maxSolPerDay).toBeNull();
    expect(ctx.store.getPolicy().maxSolLamportsPerDay).toBeNull();
  });

  it('exposes usage metrics in GET /api/state', async () => {
    const ctx = makeContext({ maxSolPerTx: 0.1, maxSolPerDay: 0.25 });
    const app = Fastify();
    await registerRoutes(app, ctx);

    // Initial state: 0 spent
    const stateBefore = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateBefore.statusCode).toBe(200);
    expect(stateBefore.json().policy.maxSolPerDay).toBe(0.25);
    expect(stateBefore.json().usage).toEqual({
      spentSol24h: 0,
      remainingSol24h: 0.25,
    });

    // Make a 0.05 SOL transfer
    await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });

    // State after transfer: 0.05 spent, 0.20 remaining
    const stateAfter = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateAfter.statusCode).toBe(200);
    expect(stateAfter.json().usage).toEqual({
      spentSol24h: 0.05,
      remainingSol24h: 0.2,
    });

    // Clear daily cap -> remaining becomes null
    ctx.store.setPolicy({
      ...ctx.store.getPolicy(),
      maxSolLamportsPerDay: null,
    });
    const stateNoCap = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateNoCap.json().usage).toEqual({
      spentSol24h: 0.05,
      remainingSol24h: null,
    });
  });

  it('owner approving a pending request counts it toward the daily cap upon execution', async () => {
    const ownerKeypair = Keypair.generate();
    const ownerPubkey = ownerKeypair.publicKey.toBase58();

    const ctx = makeContext({ maxSolPerTx: 0.05, maxSolPerDay: 0.15 });
    ctx.store.setOwner(ownerPubkey);

    // Transfer exceeding per-tx (0.08 SOL > 0.05) -> goes to pending_approval
    const held = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.08 },
    });
    expect(held.status).toBe('pending_approval');

    // While pending, it should NOT count towards usage
    const app = Fastify();
    await registerRoutes(app, ctx);

    const stateWhilePending = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateWhilePending.json().usage.spentSol24h).toBe(0);
    expect(stateWhilePending.json().usage.remainingSol24h).toBe(0.15);

    // Owner approves the held request
    const message = held.approval!.message;
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), ownerKeypair.secretKey),
    );

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/requests/${held.id}/approve`,
      payload: {
        signature,
        signerPubkey: ownerPubkey,
      },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().request.status).toBe('confirmed');

    // Now it MUST count towards usage
    const stateAfterApproval = await app.inject({ method: 'GET', url: '/api/state' });
    expect(stateAfterApproval.json().usage.spentSol24h).toBe(0.08);
    expect(stateAfterApproval.json().usage.remainingSol24h).toBe(0.07);
  });
});
