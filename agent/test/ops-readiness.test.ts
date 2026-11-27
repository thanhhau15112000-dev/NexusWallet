import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { loadConfig } from '../src/config.js';
import { createContext, type OpsLogger } from '../src/context.js';
import { createRpcProbe } from '../src/rpc-probe.js';
import { registerRoutes } from '../src/routes.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function testConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ops-'));
  dirs.push(dir);
  return {
    ...loadConfig(),
    AGENT_DATA_DIR: dir,
    dataDir: dir,
    usersDir: join(dir, 'users'),
    statePath: join(dir, 'state.json'),
    auditPath: join(dir, 'audit.jsonl'),
    keystorePath: join(dir, 'agent-keystore.json'),
    saltPath: join(dir, 'audit-salt'),
  };
}

/** Starts the routes with every slot read answering `slot` (a number, or an Error to throw). */
async function startApp(slot: number | Error) {
  const ctx = createContext(testConfig());
  vi.spyOn(ctx.connection, 'getSlot').mockImplementation(async () => {
    if (slot instanceof Error) throw slot;
    return slot;
  });
  const app = Fastify();
  await registerRoutes(app, ctx);
  return app;
}

describe('createRpcProbe', () => {
  it('reads once per window, shares a read in flight, and refreshes after the window', async () => {
    let now = 1_000_000;
    const getSlot = vi.fn().mockResolvedValue(7);
    const probe = createRpcProbe({ getSlot }, () => now);

    const [first, second] = await Promise.all([probe(), probe()]);
    expect(first).toMatchObject({ rpcOk: true, error: null });
    expect(second).toBe(first);
    now += 14_999;
    await probe();
    expect(getSlot).toHaveBeenCalledTimes(1);

    now += 1;
    await probe();
    expect(getSlot).toHaveBeenCalledTimes(2);
  });

  it('reports an RPC failure and keeps it for the window instead of retrying on every call', async () => {
    const getSlot = vi.fn().mockRejectedValue(new Error('rpc down'));
    const probe = createRpcProbe({ getSlot }, () => 5_000);

    expect(await probe()).toMatchObject({ rpcOk: false, latencyMs: null, error: 'rpc down' });
    await probe();
    expect(getSlot).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/health/ready', () => {
  it('is ready when the RPC answers', async () => {
    const app = await startApp(42);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        checkedAt: expect.any(String),
        rpc: { ok: true, latencyMs: expect.any(Number), error: null },
      });
    } finally {
      await app.close();
    }
  });

  it('answers 503 when the RPC does not answer', async () => {
    const app = await startApp(new Error('rpc down'));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, rpc: { ok: false, latencyMs: null, error: 'rpc down' } });
    } finally {
      await app.close();
    }
  });
});

describe('operations log', () => {
  it('mirrors failure audit events with the owner and error, and leaves other events out', () => {
    const warn = vi.fn();
    const log: OpsLogger = { warn };
    const ctx = createContext(testConfig(), log);
    const owner = bs58.encode(nacl.sign.keyPair().publicKey);
    const userCtx = ctx.getUserContext!(owner);

    userCtx.audit.record('tx.confirmed', 'req-1', { signature: 'sig' });
    expect(warn).not.toHaveBeenCalled();

    userCtx.audit.record('tx.failed', 'req-2', { error: 'blockhash not found' });
    userCtx.audit.record('tx.simulation_failed', 'req-3', { error: { InstructionError: [0, 'Custom'] }, logs: ['x'] });
    expect(warn).toHaveBeenCalledWith({ event: 'tx.failed', requestId: 'req-2', owner, error: 'blockhash not found' }, 'tx.failed');
    expect(warn).toHaveBeenCalledWith(
      { event: 'tx.simulation_failed', requestId: 'req-3', owner, error: '{"InstructionError":[0,"Custom"]}' },
      'tx.simulation_failed',
    );
  });
});
