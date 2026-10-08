import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAuthHook } from '../src/auth-hook.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { createMcpToken, hasMcpToken, loadOrCreateMcpToken, verifyMcpToken } from '../src/mcp-token.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const secretOf = (token: string) => token.split('_')[2]!;

async function startApp(authRequired: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-mcp-hash-'));
  const config = {
    ...loadConfig(),
    authRequired,
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

  async function login(owner: Keypair): Promise<string> {
    const pubkey = owner.publicKey.toBase58();
    const issued = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), owner.secretKey));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { challengeId: issued.challengeId, pubkey, signature },
    });
    const session = res.cookies.find((item: { name: string }) => item.name === SESSION_COOKIE_NAME)!;
    return `${session.name}=${session.value}`;
  }

  const tokenFile = (owner: string) => join(config.usersDir, owner, 'mcp-token');
  return { app, ctx, login, tokenFile };
}

describe('hosted MCP token storage', () => {
  it('stores only the hash and returns the plaintext once, from create or rotate', async () => {
    const { app, ctx, login, tokenFile } = await startApp(true);
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const headers = { cookie: await login(owner) };

      const before = await app.inject({ method: 'GET', url: '/api/mcp/config', headers });
      expect(before.json()).toMatchObject({ owner: ownerPubkey, hasToken: false, token: null });
      expect(existsSync(tokenFile(ownerPubkey))).toBe(false);

      const created = await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers });
      expect(created.headers['cache-control']).toBe('no-store');
      const mcp = created.json();
      expect(mcp.token).toMatch(new RegExp(`^nxp_${ownerPubkey}_[A-Za-z0-9_-]{43}$`));
      expect(mcp.hasToken).toBe(true);
      expect(mcp.claudeCode).toContain(`Bearer ${mcp.token}`);

      const onDisk = readFileSync(tokenFile(ownerPubkey), 'utf8');
      expect(onDisk).toBe(sha256Hex(mcp.token));
      expect(onDisk).not.toContain(secretOf(mcp.token));
      expect(existsSync(`${tokenFile(ownerPubkey)}.tmp`)).toBe(false);

      // Later reads never return it again, in any field.
      const after = await app.inject({ method: 'GET', url: '/api/mcp/config', headers });
      expect(after.json()).toMatchObject({ hasToken: true, token: null });
      expect(after.body).not.toContain(secretOf(mcp.token));
      expect(after.json().claudeCode).toBeUndefined();

      // An MCP call with the token leaves it out of the state it reads and out of this owner's audit file.
      const state = await app.inject({ method: 'GET', url: '/api/state', headers: bearer(mcp.token) });
      expect(state.statusCode).toBe(200);
      expect(state.body).not.toContain(secretOf(mcp.token));
      const auditFile = join(ctx.config.usersDir, ownerPubkey, 'audit.jsonl');
      if (existsSync(auditFile)) expect(readFileSync(auditFile, 'utf8')).not.toContain(secretOf(mcp.token));
    } finally {
      await app.close();
    }
  });

  it('accepts the right token and rejects a wrong secret, a foreign owner and a rotated token', async () => {
    const { app, login } = await startApp(true);
    try {
      const ownerA = Keypair.generate();
      const ownerB = Keypair.generate();
      const cookieA = await login(ownerA);
      const cookieB = await login(ownerB);
      const mint = async (cookieHeader: string) =>
        (await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers: { cookie: cookieHeader } })).json()
          .token as string;
      const tokenA = await mint(cookieA);
      const tokenB = await mint(cookieB);
      const state = (token: string) => app.inject({ method: 'GET', url: '/api/state', headers: bearer(token) });

      expect((await state(tokenA)).statusCode).toBe(200);
      expect((await state(tokenB)).statusCode).toBe(200);

      const forged = `${tokenA.slice(0, -1)}${tokenA.endsWith('A') ? 'B' : 'A'}`;
      expect((await state(forged)).statusCode).toBe(401);
      // Owner B's name with owner A's secret: B has a token file, but A's secret is not its hash.
      expect((await state(`nxp_${ownerB.publicKey.toBase58()}_${secretOf(tokenA)}`)).statusCode).toBe(401);
      // An owner who never created a token has no file to match.
      const stranger = Keypair.generate().publicKey.toBase58();
      expect((await state(`nxp_${stranger}_${secretOf(tokenA)}`)).statusCode).toBe(401);
      // The stored hash itself is not a credential.
      expect((await state(`nxp_${ownerA.publicKey.toBase58()}_${sha256Hex(tokenA).slice(0, 43)}`)).statusCode).toBe(401);

      const rotated = await mint(cookieA);
      expect(rotated).not.toBe(tokenA);
      expect((await state(tokenA)).statusCode).toBe(401);
      expect((await state(rotated)).statusCode).toBe(200);
      expect((await state(tokenB)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('converts a plaintext file from an earlier version to its hash on first read without cutting the client off', async () => {
    const { app, ctx, tokenFile } = await startApp(true);
    try {
      const owner = Keypair.generate().publicKey.toBase58();
      const legacy = loadOrCreateMcpToken(ctx.config.usersDir, owner); // the old format: the token itself
      expect(readFileSync(tokenFile(owner), 'utf8')).toBe(legacy);

      const first = await app.inject({ method: 'GET', url: '/api/state', headers: bearer(legacy) });
      expect(first.statusCode).toBe(200);
      expect(readFileSync(tokenFile(owner), 'utf8')).toBe(sha256Hex(legacy));
      expect(existsSync(`${tokenFile(owner)}.tmp`)).toBe(false);

      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(legacy) })).statusCode).toBe(200);
      expect(hasMcpToken(ctx.config.usersDir, owner)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('converts on the first read even when the presented token is wrong, and the right one still works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-hash-unit-'));
    const owner = Keypair.generate().publicKey.toBase58();
    const legacy = loadOrCreateMcpToken(dir, owner);
    const config = { usersDir: dir, authRequired: true };
    const wrong = `${legacy.slice(0, -1)}${legacy.endsWith('A') ? 'B' : 'A'}`;

    expect(verifyMcpToken(config, `Bearer ${wrong}`)).toBeNull();
    expect(readFileSync(join(dir, owner, 'mcp-token'), 'utf8')).toBe(sha256Hex(legacy));
    expect(verifyMcpToken(config, `Bearer ${legacy}`)).toBe(owner);
  });

  it('treats an unreadable token file as no token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-hash-garbage-'));
    const owner = Keypair.generate().publicKey.toBase58();
    mkdirSync(join(dir, owner), { recursive: true });
    writeFileSync(join(dir, owner, 'mcp-token'), 'not a token');
    const token = `nxp_${owner}_${'A'.repeat(43)}`;

    expect(hasMcpToken(dir, owner)).toBe(false);
    expect(verifyMcpToken({ usersDir: dir, authRequired: true }, `Bearer ${token}`)).toBeNull();
  });
});

describe('local MCP token storage', () => {
  it('keeps the plaintext token on disk so the stdio bundle can find it, and still returns it from the config route', async () => {
    const { app, login, tokenFile } = await startApp(false);
    try {
      const owner = Keypair.generate();
      const ownerPubkey = owner.publicKey.toBase58();
      const headers = { cookie: await login(owner) };

      const config = (await app.inject({ method: 'GET', url: '/api/mcp/config', headers })).json();
      expect(readFileSync(tokenFile(ownerPubkey), 'utf8')).toBe(config.token);
      expect((await app.inject({ method: 'GET', url: '/api/state', headers: bearer(config.token) })).statusCode).toBe(200);
      // Verifying does not convert a local file.
      expect(readFileSync(tokenFile(ownerPubkey), 'utf8')).toBe(config.token);

      const rotated = (await app.inject({ method: 'POST', url: '/api/mcp/token/rotate', headers })).json();
      expect(readFileSync(tokenFile(ownerPubkey), 'utf8')).toBe(rotated.token);
    } finally {
      await app.close();
    }
  });

  it('replaces a hashed file with a readable token, since local mode has to hand the token to stdio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mcp-hash-local-'));
    const owner = Keypair.generate().publicKey.toBase58();
    const hosted = createMcpToken(dir, owner, { hashed: true });
    const local = loadOrCreateMcpToken(dir, owner);

    expect(local).not.toBe(hosted);
    expect(readFileSync(join(dir, owner, 'mcp-token'), 'utf8')).toBe(local);
    expect(verifyMcpToken({ usersDir: dir, authRequired: false }, `Bearer ${local}`)).toBe(owner);
  });
});
