import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import { defaultPolicy, solToLamports } from '@nexus/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { registerAuthHook } from '../src/auth-hook.js';
import { loadConfig, trustProxySetting } from '../src/config.js';
import { createContext, type AppContext } from '../src/context.js';
import {
  DEFAULT_FALLBACK_RULE,
  DEFAULT_RATE_RULES,
  RateLimiter,
  addressBucket,
  registerRateLimit,
  type RateLimitOptions,
} from '../src/rate-limit.js';
import { registerRoutes } from '../src/routes.js';
import { SessionManager, SESSION_COOKIE_NAME } from '../src/sessions.js';
import { Store } from '../src/store.js';

const MINUTE = 60_000;
const rule = { id: 'r', limit: 3, windowMs: MINUTE, by: 'ip' as const };

describe('addressBucket', () => {
  it('keeps IPv4 as is and groups IPv6 by /64', () => {
    expect(addressBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(addressBucket('::ffff:203.0.113.9')).toBe('::ffff:203.0.113.9');
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::1')).toBe('0:0:0:0::/64');
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit, then reports when the window reopens', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 3; i += 1) expect(limiter.hit('k', rule).allowed).toBe(true);

    now += 20_500;
    expect(limiter.hit('k', rule)).toEqual({ allowed: false, retryAfterSeconds: 40 });
    // A blocked request does not extend the window.
    now += 39_500;
    expect(limiter.hit('k', rule).allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const limiter = new RateLimiter(() => 0);
    for (let i = 0; i < 3; i += 1) limiter.hit('a', rule);
    expect(limiter.hit('a', rule).allowed).toBe(false);
    expect(limiter.hit('b', rule).allowed).toBe(true);
  });
});

async function startHostedApp(options: RateLimitOptions = {}, remoteTrust = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-rate-limit-'));
  const config = {
    ...loadConfig(),
    authRequired: true,
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
  const app = Fastify({ trustProxy: remoteTrust ? trustProxySetting(config) : false });
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  registerRateLimit(app, ctx, options);
  registerAuthHook(app, ctx);
  await registerRoutes(app, ctx);
  return { app, ctx };
}

type HostedApp = Awaited<ReturnType<typeof startHostedApp>>['app'];

function challenge(app: HostedApp, pubkey: string, remoteAddress?: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey }, remoteAddress, headers });
}

async function login(app: HostedApp, owner: Keypair): Promise<string> {
  const pubkey = owner.publicKey.toBase58();
  const issued = JSON.parse((await challenge(app, pubkey)).body);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), owner.secretKey));
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { challengeId: issued.challengeId, pubkey, signature },
  });
  const session = res.cookies.find((item) => item.name === SESSION_COOKIE_NAME)!;
  return `${session.name}=${session.value}`;
}

describe('rate limit on sensitive routes', () => {
  it('answers 429 with Retry-After above the challenge threshold and recovers when the window passes', async () => {
    let now = Date.now();
    const { app } = await startHostedApp({ now: () => now });
    try {
      const pubkey = Keypair.generate().publicKey.toBase58();
      for (let i = 0; i < 10; i += 1) {
        const res = await challenge(app, pubkey);
        expect(res.statusCode).toBe(200);
        expect(res.json().challengeId).toBeTruthy();
      }

      const blocked = await challenge(app, pubkey);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.json()).toMatchObject({
        error: 'RATE_LIMITED',
        code: 'RATE_LIMITED',
        remediation: expect.stringContaining('retry'),
        details: { retryAfterSeconds: 60 },
      });

      // Another client address has its own allowance.
      expect((await challenge(app, pubkey, '10.9.9.9')).statusCode).toBe(200);

      now += MINUTE;
      expect((await challenge(app, pubkey)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('limits claim-seed and airdrop per address before the handler runs', async () => {
    const { app } = await startHostedApp({ now: () => 0 });
    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);
      for (const url of ['/api/agent/claim-seed', '/api/agent/airdrop']) {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          // An invalid body keeps the handler off the network; only the limiter decides the 6th answer.
          statuses.push(
            (await app.inject({ method: 'POST', url, headers: { cookie: cookieHeader }, payload: { sol: -1 } })).statusCode,
          );
        }
        expect(statuses.slice(0, 5).every((status) => status !== 429), url).toBe(true);
        expect(statuses[5], url).toBe(429);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps the /mcp backstop above the in-process read limit, so the tool error comes first', () => {
    expect(DEFAULT_RATE_RULES['POST /mcp']!.limit).toBeGreaterThanOrEqual(DEFAULT_FALLBACK_RULE.limit * 2);
  });

  it('serves 12 MCP polls per minute under the defaults and blocks above the /mcp threshold', async () => {
    const mcpRule = { id: 'mcp', limit: 30, windowMs: MINUTE, by: 'owner' as const };
    const { app } = await startHostedApp({ now: () => 0, rules: { ...DEFAULT_RATE_RULES, 'POST /mcp': mcpRule } });
    try {
      const cookieHeader = await login(app, Keypair.generate());
      const token = JSON.parse((await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).body)
        .token as string;
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      };
      const call = () =>
        app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });

      for (let i = 0; i < 12; i += 1) {
        expect((await call()).statusCode).toBe(200);
        // The tool behind the poll reads the request through the same limiter, keyed by the token.
        expect((await app.inject({ method: 'GET', url: '/api/requests/req_missing', headers })).statusCode).toBe(404);
      }
      for (let i = 12; i < 30; i += 1) expect((await call()).statusCode).not.toBe(429);
      const blocked = await call();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
    } finally {
      await app.close();
    }
  });

  it('reaches the agent as a readable RATE_LIMITED tool error when a polled read is limited', async () => {
    const { app } = await startHostedApp({ now: () => 0, fallback: { id: 'api', limit: 2, windowMs: MINUTE, by: 'owner' } });
    try {
      const cookieHeader = await login(app, Keypair.generate());
      const token = JSON.parse((await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).body)
        .token as string;
      const poll = async (id: number) =>
        JSON.parse(
          (
            await app.inject({
              method: 'POST',
              url: '/mcp',
              headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
              },
              payload: {
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: { name: 'nexuspay_get_request', arguments: { requestId: 'req_abc' } },
              },
            })
          ).body,
        ).result;

      for (const id of [1, 2]) expect((await poll(id)).isError).toBe(true); // request not found: the tool ran
      const limited = await poll(3);
      expect(limited.isError).toBe(true);
      expect(JSON.parse(limited.content[0].text)).toMatchObject({
        code: 'RATE_LIMITED',
        remediation: expect.stringContaining('Wait details.retryAfterSeconds'),
        details: { retryAfterSeconds: 60 },
      });
    } finally {
      await app.close();
    }
  });

  it('keys credentials by a verified owner, so a forged token cannot spend the owner allowance', async () => {
    const { app } = await startHostedApp({
      now: () => 0,
      rules: { ...DEFAULT_RATE_RULES, 'POST /mcp': { id: 'mcp', limit: 30, windowMs: MINUTE, by: 'owner' } },
    });
    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);
      const token = JSON.parse((await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).body)
        .token as string;
      const forged = `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      const call = (authorization: string) =>
        app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { authorization, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        });

      let blocked = 0;
      for (let i = 0; i < 40; i += 1) {
        if ((await call(forged)).statusCode === 429) blocked += 1;
      }
      expect(blocked).toBe(10);
      expect((await call(`Bearer ${token}`)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('gives a dashboard session and an MCP token separate read allowances for the same owner', async () => {
    const { app } = await startHostedApp({ now: () => 0, fallback: { id: 'api', limit: 3, windowMs: MINUTE, by: 'owner' } });
    try {
      const cookieHeader = await login(app, Keypair.generate());
      const token = JSON.parse((await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).body)
        .token as string;
      // The token request above used one of the session's three reads.
      for (let i = 0; i < 2; i += 1) {
        expect((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: cookieHeader } })).statusCode).toBe(200);
      }
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: { cookie: cookieHeader } })).statusCode).toBe(429);
      expect(
        (await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${token}` } })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('counts unknown /api paths and leaves non-API paths alone', async () => {
    const { app } = await startHostedApp({ now: () => 0, fallback: { id: 'api', limit: 2, windowMs: MINUTE, by: 'owner' } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode);
      expect(statuses).toEqual([401, 401, 429]);
      for (let i = 0; i < 5; i += 1) {
        expect((await app.inject({ method: 'GET', url: '/.well-known/actions.json' })).statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});

describe('client address behind a proxy', () => {
  it('hosted mode reads the real client from X-Forwarded-For, local mode ignores the header', () => {
    expect(trustProxySetting({ authRequired: true, TRUST_PROXY_HOPS: 2 })).toBeTypeOf('function');
    expect(trustProxySetting({ authRequired: false, TRUST_PROXY_HOPS: 2 })).toBe(false);
  });

  async function ipSeenBy(trustProxy: ReturnType<typeof trustProxySetting>, forwardedFor: string) {
    const app = Fastify({ trustProxy });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.1',
      headers: { 'x-forwarded-for': forwardedFor },
    });
    await app.close();
    return res.json().ip as string;
  }

  it('counts back from the right, so entries sent by the client do not choose its address', async () => {
    // Render appends the address it saw to what the client sent: [client-supplied..., real client, edge proxy].
    const hosted = trustProxySetting({ authRequired: true, TRUST_PROXY_HOPS: 2 });
    expect(await ipSeenBy(hosted, '6.6.6.6, 203.0.113.9, 172.16.0.2')).toBe('203.0.113.9');
    expect(await ipSeenBy(hosted, '7.7.7.7, 203.0.113.9, 172.16.0.2')).toBe('203.0.113.9');
    expect(await ipSeenBy(trustProxySetting({ authRequired: true, TRUST_PROXY_HOPS: 1 }), '6.6.6.6, 203.0.113.9, 172.16.0.2')).toBe('172.16.0.2');
    expect(await ipSeenBy(false, '6.6.6.6, 203.0.113.9, 172.16.0.2')).toBe('10.0.0.1');
  });

  it('puts two real clients behind one proxy in separate buckets, and one client rotating a forged entry in one', async () => {
    const { app } = await startHostedApp({ now: () => 0 }, true);
    try {
      const pubkey = Keypair.generate().publicKey.toBase58();
      const viaProxy = (spoof: string, client: string) =>
        challenge(app, pubkey, '10.0.0.1', { 'x-forwarded-for': `${spoof}, ${client}, 172.16.0.2` });

      for (let i = 0; i < 10; i += 1) expect((await viaProxy(`9.9.9.${i}`, '203.0.113.1')).statusCode).toBe(200);
      expect((await viaProxy('9.9.9.99', '203.0.113.1')).statusCode).toBe(429);
      expect((await viaProxy('9.9.9.1', '203.0.113.2')).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('idempotency under a rate limit', () => {
  const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

  it('does not create a transfer for a blocked retry, and the same key resumes the original request later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-rate-limit-idem-'));
    const store = new Store(join(dir, 'state.json'), 'agent-001', 50);
    store.setPolicy({
      ...defaultPolicy('agent-001'),
      maxSolLamportsPerTx: solToLamports(0.1),
      allowedRecipients: [{ label: 'treasury', address: TREASURY }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });
    const ctx = {
      config: { AGENT_ID: 'agent-001', SOLANA_CLUSTER: 'devnet', APPROVAL_TTL_SECONDS: 300, allowedOrigins: [] },
      store,
      audit: { record: vi.fn() },
      model: { describe: () => ({ stage1: 'mock', stage2: 'mock', mode: 'mock' }) },
      connection: {},
      signer: {},
      agentPubkey: TREASURY,
      ownerPinned: false,
      sessions: new SessionManager(TREASURY, 1800),
    } as unknown as AppContext;

    let now = 0;
    const app = Fastify();
    registerRateLimit(app, ctx, {
      now: () => now,
      rules: { 'POST /api/agent/intents': { id: 'propose', limit: 1, windowMs: MINUTE, by: 'owner' } },
    });
    await registerRoutes(app, ctx);
    try {
      const send = () =>
        app.inject({
          method: 'POST',
          url: '/api/agent/intents',
          payload: { action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.5 }, idempotencyKey: 'mcp:retry-1' },
        });

      const first = await send();
      expect(first.statusCode).toBe(200);
      const blocked = await send();
      expect(blocked.statusCode).toBe(429);
      expect(store.listRequests()).toHaveLength(1);

      now += MINUTE;
      const retried = await send();
      expect(retried.statusCode).toBe(200);
      expect(retried.json().request.id).toBe(first.json().request.id);
      expect(store.listRequests()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
