import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
      expect(mcp.token).toMatch(new RegExp(`^nxp_${ownerPubkey}_[A-Za-z0-9_-]{43}$`));
      expect(mcp.url).toBe(`http://127.0.0.1:${ctx.config.PORT}/mcp`);
      for (const snippet of [mcp.claudeCode, mcp.codexToml, mcp.antigravityJson, mcp.claudeDesktopJson]) {
        expect(snippet).toContain(mcp.url);
        expect(snippet).toContain(`Bearer ${mcp.token}`);
      }
      expect(mcp.codexToml).toContain('[mcp_servers.nexuspay]');
      expect(JSON.parse(mcp.antigravityJson).mcpServers.nexuspay.serverUrl).toBe(mcp.url);
      // Repeated reads return the same token so configured clients keep working.
      const again = JSON.parse((await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } })).body);
      expect(again.token).toBe(mcp.token);

      const token = mcp.token as string;
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
      expect(rotated.token).not.toBe(token);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(token) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(rotated.token) })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('accepts MCP tokens in hosted mode with the same route scope, on the dashboard origin', async () => {
    const { app, ctx } = await startApp({ authRequired: true });
    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);
      const res = await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } });
      expect(res.statusCode).toBe(200);
      const mcp = JSON.parse(res.body);
      expect(mcp.url).toBe(`${ctx.config.allowedOrigins[0]}/mcp`);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(mcp.token) })).statusCode).toBe(200);
      for (const [method, url] of [
        ['GET', '/api/tasks'],
        ['PUT', '/api/policy'],
        ['GET', '/api/mcp/config'],
        ['POST', '/api/mcp/token/rotate'],
      ] as const) {
        const denied = await app.inject({ method, url, headers: bearer(mcp.token), payload: method === 'GET' ? undefined : {} });
        expect(denied.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('serves the MCP tools over the remote /mcp endpoint to a bearer token only', async () => {
    const { app, ctx } = await startApp();
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const cookieHeader = await login(app, owner);
      const token = JSON.parse((await app.inject({ method: 'GET', url: '/api/mcp/config', headers: { cookie: cookieHeader } })).body)
        .token as string;
      const rpc = (body: unknown, headers: Record<string, string> = bearer(token)) =>
        app.inject({
          method: 'POST',
          url: '/mcp',
          headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
      const initialize = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      };

      // Only the MCP token opens /mcp: not anonymous callers, not a wallet session, not a tampered token.
      expect((await rpc(initialize, {})).statusCode).toBe(401);
      expect((await rpc(initialize, { cookie: cookieHeader })).statusCode).toBe(401);
      const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      expect((await rpc(initialize, bearer(tampered))).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/mcp', headers: bearer(token) })).statusCode).toBe(405);

      const init = await rpc(initialize);
      expect(init.statusCode).toBe(200);
      expect(JSON.parse(init.body).result.serverInfo.name).toBe('nexuspay');

      const list = JSON.parse((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).body);
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toContain('nexuspay_get_status');

      // A tool call runs through the agent API as this owner.
      const call = JSON.parse(
        (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nexuspay_get_status', arguments: {} } })).body,
      );
      expect(call.result.isError).toBeFalsy();
      const status = JSON.parse(call.result.content[0].text);
      expect(JSON.stringify(status)).toContain(ctx.getUserContext!(ownerPubkey).agentPubkey);

      // After rotation the old token no longer opens /mcp.
      await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } });
      expect((await rpc(initialize)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('creates an MCP token file on login in local mode and keeps it across logins', async () => {
    const { app, ctx } = await startApp({ authRequired: false });
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const tokenPath = join(ctx.config.usersDir, ownerPubkey, 'mcp-token');
      expect(existsSync(tokenPath)).toBe(false);

      await login(app, owner);
      expect(existsSync(tokenPath)).toBe(true);
      const token1 = readFileSync(tokenPath, 'utf8').trim();
      expect(token1).toMatch(new RegExp(`^nxp_${ownerPubkey}_[A-Za-z0-9_-]{43}$`));

      await login(app, owner);
      const token2 = readFileSync(tokenPath, 'utf8').trim();
      expect(token2).toBe(token1);
    } finally {
      await app.close();
    }
  });

  it('does not create an MCP token file on login in hosted mode', async () => {
    const { app, ctx } = await startApp({ authRequired: true });
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const tokenPath = join(ctx.config.usersDir, ownerPubkey, 'mcp-token');

      await login(app, owner);
      expect(existsSync(tokenPath)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('health build identity', () => {
  it('reports the deployed commit from the host env, or null when none is set', async () => {
    const { app } = await startApp();
    const prevRender = process.env.RENDER_GIT_COMMIT;
    const prevGit = process.env.GIT_COMMIT;
    try {
      delete process.env.RENDER_GIT_COMMIT;
      delete process.env.GIT_COMMIT;
      expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/health' })).body).commit).toBeNull();
      process.env.RENDER_GIT_COMMIT = 'abc1234';
      expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/health' })).body).commit).toBe('abc1234');
    } finally {
      if (prevRender === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = prevRender;
      if (prevGit === undefined) delete process.env.GIT_COMMIT;
      else process.env.GIT_COMMIT = prevGit;
      await app.close();
    }
  });
});
