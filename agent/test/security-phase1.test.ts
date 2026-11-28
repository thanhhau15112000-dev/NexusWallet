import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { AuditLog } from '../src/audit.js';
import { registerAuthHook } from '../src/auth-hook.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function startHostedApp() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nexus-sec-phase1-'));
  tempDirs.push(dataDir);
  const config = {
    ...loadConfig(),
    authRequired: true,
    allowedOrigins: ['https://app.example.com'],
    adminPubkey: '',
    AGENT_DATA_DIR: dataDir,
    dataDir,
    usersDir: join(dataDir, 'users'),
    statePath: join(dataDir, 'state.json'),
    auditPath: join(dataDir, 'audit.jsonl'),
    keystorePath: join(dataDir, 'agent-keystore.json'),
    saltPath: join(dataDir, 'audit-salt'),
  };
  const ctx = createContext(config);
  vi.spyOn(ctx.connection, 'getBalance').mockResolvedValue(0);
  vi.spyOn(ctx.connection, 'getParsedTokenAccountsByOwner').mockResolvedValue({ context: { slot: 0 }, value: [] });
  const app = Fastify();
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  registerAuthHook(app, ctx);
  await registerRoutes(app, ctx);
  return { app, ctx, dataDir };
}

async function login(app: Awaited<ReturnType<typeof startHostedApp>>['app'], owner: Keypair): Promise<string> {
  const pubkey = owner.publicKey.toBase58();
  const challenge = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey));
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { challengeId: challenge.challengeId, pubkey, signature },
  });
  const session = res.cookies.find((item) => item.name === SESSION_COOKIE_NAME)!;
  return `${session.name}=${session.value}`;
}

describe('Phase 1 security hardening', () => {
  it('locks POST /api/owner to the authenticated session owner without provisioning foreign tenants', async () => {
    const { app, ctx } = await startHostedApp();
    try {
      const ownerA = Keypair.generate();
      const stranger = Keypair.generate();
      const cookieA = await login(app, ownerA);

      const denied = await app.inject({
        method: 'POST',
        url: '/api/owner',
        headers: { cookie: cookieA },
        payload: { pubkey: stranger.publicKey.toBase58() },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe('owner_mismatch');
      expect(existsSync(join(ctx.config.usersDir, stranger.publicKey.toBase58()))).toBe(false);

      const allowed = await app.inject({
        method: 'POST',
        url: '/api/owner',
        headers: { cookie: cookieA },
        payload: { pubkey: ownerA.publicKey.toBase58() },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({ owner: ownerA.publicKey.toBase58() });
    } finally {
      await app.close();
    }
  });

  it('rejects localhost Origin headers in hosted mode', async () => {
    const { app } = await startHostedApp();
    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);

      const badChallenge = await app.inject({
        method: 'POST',
        url: '/api/auth/challenge',
        headers: { origin: 'http://localhost:5173' },
        payload: { pubkey: owner.publicKey.toBase58() },
      });
      expect(badChallenge.statusCode).toBe(403);
      expect(badChallenge.json().error).toBe('origin_not_allowed');

      const badHook = await app.inject({
        method: 'POST',
        url: '/api/policy',
        headers: { cookie: cookieHeader, origin: 'http://localhost:5173' },
        payload: {},
      });
      expect(badHook.statusCode).toBe(403);
      expect(badHook.json().error).toBe('origin_not_allowed');

      const goodChallenge = await app.inject({
        method: 'POST',
        url: '/api/auth/challenge',
        headers: { origin: 'https://app.example.com' },
        payload: { pubkey: owner.publicKey.toBase58() },
      });
      expect(goodChallenge.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('binds AuditLog v2 hashes to sealed.iv while remaining backward-compatible with v1 entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-audit-v2-'));
    tempDirs.push(dir);
    const auditPath = join(dir, 'audit.jsonl');
    const saltPath = join(dir, 'audit-salt');

    // Write one legacy v1 entry (without hashVersion or sealed.iv in the hash).
    const v1Entry = {
      id: 'legacy-1',
      at: '2026-01-01T00:00:00.000Z',
      requestId: null,
      event: 'legacy.event',
      sealed: { iv: 'AAAA', tag: 'BBBB', ciphertext: 'CCCC' },
      prevHash: '0'.repeat(64),
      hash: '',
    };
    v1Entry.hash = createHash('sha256')
      .update(`${v1Entry.prevHash}:${v1Entry.id}:${v1Entry.at}::${v1Entry.event}:${v1Entry.sealed.ciphertext}:${v1Entry.sealed.tag}`)
      .digest('hex');
    writeFileSync(auditPath, `${JSON.stringify(v1Entry)}\n`);

    const audit = new AuditLog(auditPath, saltPath, 'test-passphrase-123');
    audit.record('modern.event', 'req_1', { ok: true });
    expect(audit.verifyIntegrity()).toEqual({ valid: true });

    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1]!);
    expect(second.hashVersion).toBe(2);
    second.sealed.iv = `${second.sealed.iv.slice(0, -1)}${second.sealed.iv.endsWith('A') ? 'B' : 'A'}`;
    writeFileSync(auditPath, `${lines[0]}\n${JSON.stringify(second)}\n`);

    expect(audit.verifyIntegrity()).toEqual({
      valid: false,
      compromisedIndex: 1,
      reason: 'tampered_entry_hash',
    });
  });

  it('serializes concurrent Task Vault payment calls for the same task', async () => {
    const { app, ctx } = await startHostedApp();
    try {
      const owner = Keypair.generate();
      const worker = Keypair.generate().publicKey.toBase58();
      const cookieHeader = await login(app, owner);
      const expiry = Math.floor(Date.now() / 1000) + 3600;

      const created = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId: 'task-race',
          budgetLamports: 100,
          perPaymentCapLamports: 60,
          expiry,
          allowedWorker: worker,
          allowedServiceId: 'svc',
          isSimulated: true,
        },
      });
      expect(created.statusCode).toBe(200);

      // Simulate async delay during store persistence to expose race conditions without serialization.
      const userCtx = ctx.getUserContext!(owner.publicKey.toBase58());
      const origSetPayment = userCtx.store.setPayment.bind(userCtx.store);
      let firstDone = false;
      vi.spyOn(userCtx.store, 'setPayment').mockImplementation((payment, options) => {
        origSetPayment(payment, options);
        firstDone = true;
      });

      const payloadSameId = {
        paymentId: 'pay-same',
        worker,
        serviceId: 'svc',
        amountLamports: 60,
        requestHash: 'a'.repeat(64),
      };
      const [r1, r2] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/tasks/task-race/payments', headers: { cookie: cookieHeader }, payload: payloadSameId }),
        app.inject({ method: 'POST', url: '/api/tasks/task-race/payments', headers: { cookie: cookieHeader }, payload: payloadSameId }),
      ]);
      expect(firstDone).toBe(true);
      expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);

      // Two concurrent distinct payments totaling 120 > remaining budget 40: both cannot succeed.
      const [b1, b2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/tasks/task-race/payments',
          headers: { cookie: cookieHeader },
          payload: { paymentId: 'pay-b1', worker, serviceId: 'svc', amountLamports: 30, requestHash: 'b'.repeat(64) },
        }),
        app.inject({
          method: 'POST',
          url: '/api/tasks/task-race/payments',
          headers: { cookie: cookieHeader },
          payload: { paymentId: 'pay-b2', worker, serviceId: 'svc', amountLamports: 30, requestHash: 'c'.repeat(64) },
        }),
      ]);
      expect([b1.statusCode, b2.statusCode].sort()).toEqual([200, 400]);
      expect(userCtx.store.getTask('task-race')?.spentLamports).toBe(90);
    } finally {
      await app.close();
    }
  });
});
