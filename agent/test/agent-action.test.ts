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
    transferSol: vi.fn().mockResolvedValue({ signature: 'sig-agent-action', slot: 7 }),
  };
});

import { InsufficientFundsError, transferSol } from '../src/chain.js';
import { IdempotencyConflictError, runAction, runCommand } from '../src/pipeline.js';
import { registerRoutes } from '../src/routes.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import type { AppContext } from '../src/context.js';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const STRANGER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const tempDirs: string[] = [];

function makeContext(): AppContext & { understand: ReturnType<typeof vi.fn>; plan: ReturnType<typeof vi.fn> } {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-agent-action-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [],
    maxTokenAmountByMint: {},
  });
  const understand = vi.fn();
  const plan = vi.fn();

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
      understand,
      plan,
      describe: () => ({ stage1: 'mock:deterministic', stage2: 'mock:deterministic', mode: 'mock' }),
    } as never,
    connection: { getBalance: vi.fn().mockResolvedValue(42) } as never,
    signer: {} as never,
    agentPubkey: TREASURY,
    ownerPinned: false,
    sessions: new SessionManager(TREASURY, 1800),
    understand,
    plan,
  };
}

afterEach(() => {
  vi.mocked(transferSol).mockClear();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('runAction (structured agent actions)', () => {
  it('executes an allowlisted transfer inside the cap without calling a model', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
    });

    expect(request.status).toBe('confirmed');
    expect(request.decision?.verdict).toBe('allow');
    expect(request.intent).toBeNull();
    expect(request.modelTrace).toBeNull();
    expect(request.execution?.signature).toBe('sig-agent-action');
    expect(transferSol).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: TREASURY, lamports: solToLamports(0.05) }),
    );
    expect(ctx.understand).not.toHaveBeenCalled();
    expect(ctx.plan).not.toHaveBeenCalled();
  });

  it('holds a transfer above the cap for owner approval and signs nothing', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.5 },
    });

    expect(request.status).toBe('pending_approval');
    expect(request.approval?.payload).toMatchObject({
      recipient: TREASURY,
      amount: solToLamports(0.5),
      policyVersion: ctx.store.getPolicy().version,
    });
    expect(request.approval?.signature).toBeNull();
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('denies an off-allowlist recipient without offering approval', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: STRANGER, amountSol: 0.01 },
    });

    expect(request.status).toBe('denied');
    expect(request.approval).toBeNull();
    expect(request.error).toEqual({
      code: 'RECIPIENT_NOT_IN_ALLOWLIST',
      message: `recipient "${STRANGER}" is not on the allowlist`,
      remediation: expect.stringContaining('details.allowedRecipients'),
      details: { recipient: STRANGER, allowedRecipients: [{ label: 'treasury', address: TREASURY }] },
    });
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('denies an off-allowlist mint with MINT_NOT_IN_ALLOWLIST', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_spl', recipient: 'treasury', mint: STRANGER, amount: 1 },
    });

    expect(request.status).toBe('denied');
    expect(request.error).toMatchObject({
      code: 'MINT_NOT_IN_ALLOWLIST',
      details: { mint: STRANGER, allowedMints: [] },
    });
    expect(request.error?.remediation).toContain('details.allowedMints');
  });

  it('denies an amount that rounds to zero lamports with INVALID_AMOUNT', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 1e-10 },
    });

    expect(request.status).toBe('denied');
    expect(request.error).toMatchObject({ code: 'INVALID_AMOUNT', details: { amountSol: 1e-10 } });
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('holds an over-limit transfer with the limit in SOL and integer lamports', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.100000001 },
    });

    expect(request.status).toBe('pending_approval');
    expect(request.error).toBeNull();
    expect(request.decision).toMatchObject({
      code: 'AMOUNT_EXCEEDS_TRANSACTION_LIMIT',
      reasons: ['amount 0.100000001 SOL exceeds the per-transaction limit of 0.1 SOL'],
      details: { requestedSol: 0.100000001, requestedLamports: 100_000_001, limitSol: 0.1, limitLamports: 100_000_000 },
    });
  });

  it('fails with INSUFFICIENT_FUNDS_INCLUDING_FEES when the balance cannot cover amount plus fee reserve', async () => {
    const ctx = makeContext();
    vi.mocked(transferSol).mockRejectedValueOnce(new InsufficientFundsError(15_000_000, 20_010_000));

    const request = await runAction(ctx, {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.02 },
    });

    expect(request.status).toBe('failed');
    expect(request.execution).toBeNull();
    expect(request.error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS_INCLUDING_FEES',
      message: 'agent wallet holds 0.015 SOL, needs 0.02001 SOL including the fee reserve',
      details: {
        balanceLamports: 15_000_000,
        requiredLamports: 20_010_000,
        feeReserveLamports: 10_000,
        maxSendableLamports: 14_990_000,
        maxSendableSol: 0.01499,
      },
    });
    expect(request.error?.remediation).toContain('details.maxSendableSol');
  });

  it('reads the balance through the same policy path', async () => {
    const ctx = makeContext();

    const request = await runAction(ctx, { action: { type: 'get_balance' } });

    expect(request.status).toBe('confirmed');
    expect(request.balanceLamports).toBe(42);
  });
});

describe('runAction idempotency', () => {
  it('returns one request for concurrent and completed retries with the same action', async () => {
    const ctx = makeContext();
    const action = { type: 'transfer_sol' as const, recipient: 'treasury', amountSol: 0.05 };

    const first = runAction(ctx, { action, idempotencyKey: 'mcp:key-1' });
    const second = runAction(ctx, { action: { ...action }, idempotencyKey: 'mcp:key-1' });
    const [one, two] = await Promise.all([first, second]);
    const third = await runAction(ctx, { action: { ...action }, idempotencyKey: 'mcp:key-1' });

    expect(two.id).toBe(one.id);
    expect(third.id).toBe(one.id);
    expect(transferSol).toHaveBeenCalledTimes(1);
    expect(ctx.store.listRequests()).toHaveLength(1);
  });

  it('rejects a reused key that carries a different action, in flight and after completion', async () => {
    const ctx = makeContext();
    const action = { type: 'transfer_sol' as const, recipient: 'treasury', amountSol: 0.05 };

    const first = runAction(ctx, { action, idempotencyKey: 'mcp:key-2' });
    await expect(
      runAction(ctx, { action: { ...action, amountSol: 0.06 }, idempotencyKey: 'mcp:key-2' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await first;
    await expect(
      runAction(ctx, { action: { ...action, recipient: STRANGER }, idempotencyKey: 'mcp:key-2' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(transferSol).toHaveBeenCalledTimes(1);
    expect(ctx.store.listRequests()).toHaveLength(1);
  });

  it('does not let a structured action reuse the key of a prompt command', async () => {
    const ctx = makeContext();
    ctx.understand.mockResolvedValue({
      value: {
        goal: 'read balance',
        operation: 'get_balance',
        entities: {},
        riskNotes: [],
        confidence: 1,
        requiresHuman: false,
      },
      meta: { name: 'mock', model: 'deterministic', fallback: true, ms: 0 },
    });
    ctx.plan.mockResolvedValue({
      value: { action: { type: 'get_balance' }, rationale: 'read', confidence: 1 },
      meta: { name: 'mock', model: 'deterministic', fallback: true, ms: 0 },
    });
    await runCommand(ctx, { prompt: 'balance?', idempotencyKey: 'shared-key' });

    await expect(
      runAction(ctx, { action: { type: 'get_balance' }, idempotencyKey: 'shared-key' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});

describe('POST /api/agent/intents', () => {
  it('returns the request for a structured action', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      payload: { action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.5 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().request.status).toBe('pending_approval');
  });

  it('answers 409 on an idempotency conflict', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);
    const send = (amountSol: number) =>
      app.inject({
        method: 'POST',
        url: '/api/agent/intents',
        payload: { action: { type: 'transfer_sol', recipient: 'treasury', amountSol }, idempotencyKey: 'k' },
      });

    expect((await send(0.5)).statusCode).toBe(200);
    const conflict = await send(0.6);

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'IDEMPOTENCY_CONFLICT',
      message: 'idempotency key k was already used for a different request',
      remediation: expect.stringContaining('Omit idempotencyKey'),
      details: { idempotencyKey: 'k' },
    });
  });

  it('rejects the non-executable manual approval action before creating a request', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);

    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/intents',
      payload: { action: { type: 'request_manual_approval', reason: 'please' } },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(ctx.store.listRequests()).toHaveLength(0);
  });
});
