import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair, type Connection } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { createContext, type OpsLogger } from '../src/context.js';
import { canFundSeed, createFunderProbe, INITIAL_SEED_LAMPORTS, SEED_FEE_LAMPORTS } from '../src/funder.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function testConfig(cap = 50) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ops-'));
  dirs.push(dir);
  return {
    ...loadConfig(),
    SEED_CAP_PER_DAY: cap,
    AGENT_DATA_DIR: dir,
    dataDir: dir,
    usersDir: join(dir, 'users'),
    masterFunderPath: join(dir, 'master-funder.json'),
    legacyKeystorePath: join(dir, 'agent-keystore.json'),
    statePath: join(dir, 'state.json'),
    auditPath: join(dir, 'audit.jsonl'),
    keystorePath: join(dir, 'agent-keystore.json'),
    saltPath: join(dir, 'audit-salt'),
  };
}

/** Starts the routes with every balance read answering `balance` (a number, or an Error to throw). */
async function startApp(balance: number | Error, cap = 50) {
  const config = testConfig(cap);
  const ctx = createContext(config);
  vi.spyOn(ctx.connection, 'getParsedTokenAccountsByOwner').mockResolvedValue({ context: { slot: 0 }, value: [] });
  vi.spyOn(ctx.connection, 'getBalance').mockImplementation(async () => {
    if (balance instanceof Error) throw balance;
    return balance;
  });
  const app = Fastify();
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await registerRoutes(app, ctx);

  async function newOwner(): Promise<string> {
    const key = nacl.sign.keyPair();
    const pubkey = bs58.encode(key.publicKey);
    const issued = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), key.secretKey));
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { challengeId: issued.challengeId, pubkey, signature } });
    const session = res.cookies.find((item: { name: string }) => item.name === SESSION_COOKIE_NAME)!;
    return `${session.name}=${session.value}`;
  }

  return { app, ctx, newOwner };
}

describe('canFundSeed', () => {
  it('needs the seed plus its fee', () => {
    expect(canFundSeed(INITIAL_SEED_LAMPORTS + SEED_FEE_LAMPORTS)).toBe(true);
    expect(canFundSeed(INITIAL_SEED_LAMPORTS + SEED_FEE_LAMPORTS - 1)).toBe(false);
    expect(canFundSeed(0)).toBe(false);
  });
});

describe('createFunderProbe', () => {
  const pubkey = Keypair.generate().publicKey.toBase58();

  it('reads once per window, shares a read in flight, and refreshes after the window', async () => {
    let now = 1_000_000;
    const getBalance = vi.fn().mockResolvedValue(7);
    const probe = createFunderProbe({ getBalance } as unknown as Connection, pubkey, () => now);

    const [first, second] = await Promise.all([probe(), probe()]);
    expect(first).toMatchObject({ rpcOk: true, lamports: 7, error: null });
    expect(second).toBe(first);
    now += 14_999;
    await probe();
    expect(getBalance).toHaveBeenCalledTimes(1);

    now += 1;
    await probe();
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it('reports an RPC failure and keeps it for the window instead of retrying on every call', async () => {
    const now = 5_000;
    const getBalance = vi.fn().mockRejectedValue(new Error('rpc down'));
    const probe = createFunderProbe({ getBalance } as unknown as Connection, pubkey, () => now);

    expect(await probe()).toMatchObject({ rpcOk: false, lamports: null, latencyMs: null, error: expect.stringContaining('rpc down') });
    await probe();
    // withRpcRetry may retry inside one read, but a second call in the window makes no new read.
    const callsAfterFirst = getBalance.mock.calls.length;
    await probe();
    expect(getBalance.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('GET /api/health/ready', () => {
  it('is ready and says the funder cannot seed when its balance is below one seed', async () => {
    const { app, ctx } = await startApp(1_000);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        rpc: { ok: true, latencyMs: expect.any(Number), error: null },
        masterFunder: { pubkey: ctx.masterFunderPubkey, lamports: 1_000, canSeed: false },
        seedCapacity: true,
      });
    } finally {
      await app.close();
    }
  });

  it('answers 503 when the RPC does not answer', async () => {
    const { app } = await startApp(new Error('rpc down'));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, rpc: { ok: false }, masterFunder: { lamports: null, canSeed: null } });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/state seed availability', () => {
  const seedOf = async (balance: number | Error, cap = 50) => {
    const { app, newOwner } = await startApp(balance, cap);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: await newOwner() } });
      return res.json().seed;
    } finally {
      await app.close();
    }
  };

  it('is available when the funder covers a seed', async () => {
    expect(await seedOf(INITIAL_SEED_LAMPORTS + SEED_FEE_LAMPORTS)).toEqual({ available: true, reason: null });
  });

  it('says the funder is empty when it cannot cover a seed', async () => {
    expect(await seedOf(0)).toEqual({ available: false, reason: 'funder_empty' });
  });

  it('says the cap is reached when no seed slot is free', async () => {
    expect(await seedOf(10 * INITIAL_SEED_LAMPORTS, 0)).toEqual({ available: false, reason: 'cap_reached' });
  });

  it('stays available when the funder balance cannot be read, so the claim reports the real error', async () => {
    expect(await seedOf(new Error('rpc down'))).toEqual({ available: true, reason: null });
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
