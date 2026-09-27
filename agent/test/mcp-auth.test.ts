import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAuthHook } from '../src/auth-hook.js';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

async function startApp(overrides: { authRequired?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-mcp-auth-'));
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
  return { app, ctx };
}

async function login(app: Awaited<ReturnType<typeof startApp>>['app'], owner: Keypair): Promise<string> {
  const pubkey = owner.publicKey.toBase58();
  const challenge = JSON.parse((await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).body);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey));
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { challengeId: challenge.challengeId, pubkey, signature } });
  const session = res.cookies.find((item) => item.name === SESSION_COOKIE_NAME)!;
  return `${session.name}=${session.value}`;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('MCP token authentication', () => {
  it('hands a tenant token to the wallet session and accepts it only on MCP routes', async () => {
    const { app, ctx } = await startApp();
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const cookieHeader = await login(app, owner);

      expect((await app.inject({ method: 'GET', url: '/api/mcp/config' })).statusCode).toBe(401);
      const configRes = await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } });
      expect(configRes.statusCode).toBe(200);
      expect(configRes.headers['cache-control']).toBe('no-store');
      const mcp = JSON.parse(configRes.body);
      expect(mcp.env.NEXUS_AGENT_TOKEN).toMatch(new RegExp(`^nxp_${ownerPubkey}_[A-Za-z0-9_-]{43}$`));
      expect(mcp.mcpServersJson).toContain(mcp.env.NEXUS_AGENT_TOKEN);
      expect(mcp.codexToml).toContain('[mcp_servers.nexuspay]');
      expect(mcp.bundlePath).toMatch(/dist\/mcp\/nexuspay-mcp\.mjs$/);
      expect(mcp.bundlePath).not.toContain('\\');
      // Repeated reads return the same token so configured clients keep working.
      const again = JSON.parse((await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } })).body);
      expect(again.env.NEXUS_AGENT_TOKEN).toBe(mcp.env.NEXUS_AGENT_TOKEN);

      const token = mcp.env.NEXUS_AGENT_TOKEN as string;
      const state = await app.inject({ method: 'GET', url: '/api/state', headers: bearer(token) });
      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body).agent.pubkey).toBe(ctx.getUserContext!(ownerPubkey).agentPubkey);
      expect(JSON.parse(state.body).isAdmin).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/api/requests', headers: bearer(token) })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/requests/req_missing', headers: bearer(token) })).statusCode).toBe(404);

      // Outside the MCP scope the token is not a session, including path tricks around allowed routes.
      for (const [method, url] of [
        ['GET', '/api/state/'],
        ['GET', '/api/requests/../tasks'],
        ['GET', '/api/requests/%2E%2E/tasks'],
        ['GET', '/api/actions/../tasks'],
        ['GET', '/api/tasks'],
        ['PUT', '/api/policy'],
        ['POST', '/api/owner'],
        ['GET', '/api/mcp/config'],
        ['POST', '/api/mcp/token/rotate'],
      ] as const) {
        const res = await app.inject({ method, url, headers: bearer(token), payload: method === 'GET' ? undefined : {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }

      // Tampered, foreign or header-only credentials are rejected.
      const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(tampered) })).statusCode).toBe(401);
      const other = Keypair.generate().publicKey.toBase58();
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(token.replace(ownerPubkey, other)) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: { 'x-owner-pubkey': ownerPubkey } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: { authorization: token } })).statusCode).toBe(401);

      // Rotation revokes the previous token.
      const rotated = JSON.parse((await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).body);
      expect(rotated.env.NEXUS_AGENT_TOKEN).not.toBe(token);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(token) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(rotated.env.NEXUS_AGENT_TOKEN) })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does not accept MCP tokens in hosted mode', async () => {
    const { app } = await startApp({ authRequired: true });
    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);
      const res = await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('mcp_local_only');
    } finally {
      await app.close();
    }
  });
});
