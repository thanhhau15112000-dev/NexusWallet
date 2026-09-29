import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chain.js')>();
  return {
    ...actual,
    getLamportBalance: vi.fn().mockResolvedValue(500_000_000),
    getAgentHistory: vi.fn(),
  };
});

import { getAgentHistory as getAgentHistoryMock } from '../src/chain.js';
import { registerAuthHook } from '../src/auth-hook.js';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { loadOrCreateMcpToken } from '../src/mcp-token.js';

describe('getAgentHistory', () => {
  const wallet = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;

  // The module above is mocked for the route tests; load the real implementation here.
  async function real() {
    return (await vi.importActual<typeof import('../src/chain.js')>('../src/chain.js')).getAgentHistory;
  }

  function parsedTx(options: {
    keys: PublicKey[];
    pre: number[];
    post: number[];
    fee?: number;
    err?: unknown;
    blockTime?: number;
  }) {
    return {
      blockTime: options.blockTime ?? 1_700_000_000,
      transaction: { message: { accountKeys: options.keys.map((pubkey) => ({ pubkey })) } },
      meta: {
        err: options.err ?? null,
        fee: options.fee ?? 5000,
        preBalances: options.pre,
        postBalances: options.post,
      },
    };
  }

  it('reports the wallet own SOL change and balance after each transaction, newest first', async () => {
    const getAgentHistoryReal = await real();
    const connection = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([
        { signature: 'sigReceived', blockTime: 300, err: null },
        { signature: 'sigSent', blockTime: 200, err: null },
        { signature: 'sigFailed', blockTime: 100, err: { InstructionError: [0, 'Custom'] } },
        { signature: 'sigMissing', blockTime: 50, err: null },
      ]),
      getParsedTransactions: vi.fn().mockResolvedValue([
        // Another wallet pays the agent 0.4 SOL.
        parsedTx({ keys: [other, wallet], pre: [2_000_000_000, 100_000_000], post: [1_599_995_000, 500_000_000] }),
        // The agent pays 0.05 SOL plus a 5000 lamport fee.
        parsedTx({ keys: [wallet, other], pre: [500_000_000, 0], post: [449_995_000, 50_000_000] }),
        // A failed transaction still costs the fee.
        parsedTx({
          keys: [wallet, other],
          pre: [449_995_000, 0],
          post: [449_990_000, 0],
          err: { InstructionError: [0, 'Custom'] },
        }),
        // Not indexed yet.
        null,
      ]),
    };

    const { items, nextBefore } = await getAgentHistoryReal(connection as never, wallet.toBase58(), 'devnet');

    expect(nextBefore).toBeNull();
    expect(items.map((item) => item.signature)).toEqual(['sigReceived', 'sigSent', 'sigFailed']);
    expect(items[0]).toMatchObject({ status: 'confirmed', deltaLamports: 400_000_000, balanceAfterLamports: 500_000_000 });
    expect(items[1]).toMatchObject({ status: 'confirmed', deltaLamports: -50_005_000, balanceAfterLamports: 449_995_000 });
    expect(items[2]).toMatchObject({ status: 'failed', deltaLamports: -5000, balanceAfterLamports: 449_990_000, feeLamports: 5000 });
    expect(items[0]!.explorerUrl).toBe('https://explorer.solana.com/tx/sigReceived?cluster=devnet');
  });

  it('skips transactions where the wallet is not an account key and returns [] with no signatures', async () => {
    const getAgentHistoryReal = await real();
    const empty = { getSignaturesForAddress: vi.fn().mockResolvedValue([]), getParsedTransactions: vi.fn() };
    expect(await getAgentHistoryReal(empty as never, wallet.toBase58(), 'devnet')).toEqual({ items: [], nextBefore: null });
    expect(empty.getParsedTransactions).not.toHaveBeenCalled();

    const unrelated = {
      getSignaturesForAddress: vi.fn().mockResolvedValue([{ signature: 'sigX', blockTime: 1, err: null }]),
      getParsedTransactions: vi.fn().mockResolvedValue([parsedTx({ keys: [other], pre: [1], post: [1] })]),
    };
    expect((await getAgentHistoryReal(unrelated as never, wallet.toBase58(), 'devnet')).items).toEqual([]);
  });

  it('pages back in time: passes limit and before to the RPC and returns the last signature as nextBefore only for a full page', async () => {
    const getAgentHistoryReal = await real();
    const rows = [
      { signature: 'sig1', blockTime: 2, err: null },
      { signature: 'sig2', blockTime: 1, err: null },
    ];
    const connection = {
      getSignaturesForAddress: vi.fn().mockResolvedValue(rows),
      // The last row is not indexed yet: it is skipped, but still counts as part of the page.
      getParsedTransactions: vi.fn().mockResolvedValue([
        parsedTx({ keys: [wallet, other], pre: [10, 0], post: [9, 1] }),
        null,
      ]),
    };

    const full = await getAgentHistoryReal(connection as never, wallet.toBase58(), 'devnet', { limit: 2, before: 'sigPrev' });
    expect(connection.getSignaturesForAddress).toHaveBeenCalledWith(expect.anything(), { limit: 2, before: 'sigPrev' }, 'confirmed');
    expect(full.items.map((item) => item.signature)).toEqual(['sig1']);
    expect(full.nextBefore).toBe('sig2');

    const partial = await getAgentHistoryReal(connection as never, wallet.toBase58(), 'devnet', { limit: 3 });
    expect(partial.nextBefore).toBeNull();
  });
});

describe('GET /api/agent/history', () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  async function startApp() {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-history-test-'));
    tempDirs.push(dataDir);
    const config = {
      ...loadConfig(),
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
    const challenge = JSON.parse(
      (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).body,
    );
    const signature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { challengeId: challenge.challengeId, pubkey, signature },
    });
    const session = res.cookies.find((entry: { name: string; value: string }) => entry.name === SESSION_COOKIE_NAME)!;
    return `${session.name}=${session.value}`;
  }

  const item = {
    signature: 'sig1',
    blockTime: 1_700_000_000,
    status: 'confirmed' as const,
    deltaLamports: 100_000_000,
    balanceAfterLamports: 600_000_000,
    feeLamports: 5000,
    explorerUrl: 'https://explorer.solana.com/tx/sig1?cluster=devnet',
  };

  it('requires a wallet session: no cookie and an MCP token both get 401', async () => {
    const { app, config } = await startApp();
    expect((await app.inject({ method: 'GET', url: '/api/agent/history' })).statusCode).toBe(401);

    const token = loadOrCreateMcpToken(config.usersDir, Keypair.generate().publicKey.toBase58());
    const res = await app.inject({
      method: 'GET',
      url: '/api/agent/history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(getAgentHistoryMock).not.toHaveBeenCalled();
  });

  it('returns the agent wallet history for the session owner and shares reads made within a few seconds', async () => {
    const { app, ctx } = await startApp();
    const owner = Keypair.generate();
    const cookieHeader = await login(app, owner);
    vi.mocked(getAgentHistoryMock).mockResolvedValue({ items: [item], nextBefore: null });

    const first = await app.inject({ method: 'GET', url: '/api/agent/history', headers: { cookie: cookieHeader } });
    const second = await app.inject({ method: 'GET', url: '/api/agent/history', headers: { cookie: cookieHeader } });

    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body)).toEqual({ items: [item], nextBefore: null });
    expect(JSON.parse(second.body)).toEqual({ items: [item], nextBefore: null });
    expect(getAgentHistoryMock).toHaveBeenCalledTimes(1);
    const agentPubkey = ctx.getUserContext!(owner.publicKey.toBase58()).agentPubkey;
    expect(vi.mocked(getAgentHistoryMock).mock.calls[0]![1]).toBe(agentPubkey);
  });

  it('forwards before and limit, keeps a separate cached read per page, and rejects bad queries with 400', async () => {
    const { app } = await startApp();
    const cookieHeader = await login(app, Keypair.generate());
    const signature = 'a'.repeat(88);
    vi.mocked(getAgentHistoryMock).mockResolvedValue({ items: [], nextBefore: signature });
    const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });

    const older = await get(`/api/agent/history?before=${signature}&limit=5`);
    expect(older.statusCode).toBe(200);
    expect(JSON.parse(older.body)).toEqual({ items: [], nextBefore: signature });
    expect(vi.mocked(getAgentHistoryMock).mock.calls[0]![3]).toEqual({ limit: 5, before: signature });

    await get('/api/agent/history');
    expect(getAgentHistoryMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getAgentHistoryMock).mock.calls[1]![3]).toEqual({ limit: 10, before: undefined });

    for (const bad of ['?before=not-a-signature', '?limit=0', '?limit=51', '?limit=abc']) {
      expect((await get(`/api/agent/history${bad}`)).statusCode).toBe(400);
    }
    expect(getAgentHistoryMock).toHaveBeenCalledTimes(2);
  });

  it('answers 502 with the RPC message when the chain read fails', async () => {
    const { app } = await startApp();
    const cookieHeader = await login(app, Keypair.generate());
    vi.mocked(getAgentHistoryMock).mockRejectedValue(new Error('429 Too Many Requests'));

    const res = await app.inject({ method: 'GET', url: '/api/agent/history', headers: { cookie: cookieHeader } });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'rpc_error', message: '429 Too Many Requests' });
  });
});
