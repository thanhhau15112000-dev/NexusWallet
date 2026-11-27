import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from '@nexus/shared';
import { registerAuthHook } from '../src/auth-hook.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { runAction } from '../src/pipeline.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { Store } from '../src/store.js';
import { TelegramService } from '../src/telegram.js';

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  process.env = { ...ENV_BACKUP };
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
});

function makeConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig(),
    AGENT_DATA_DIR: dataDir,
    dataDir,
    usersDir: join(dataDir, 'users'),
    statePath: join(dataDir, 'state.json'),
    auditPath: join(dataDir, 'audit.jsonl'),
    keystorePath: join(dataDir, 'agent-keystore.json'),
    saltPath: join(dataDir, 'audit-salt'),
    ...overrides,
  };
}

function mockFetchRecorder(handler?: (url: string, body: Record<string, unknown> | null) => { status?: number; json: unknown }) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    const out = handler ? handler(url, body) : { status: 200, json: { ok: true, result: { message_id: 1 } } };
    return new Response(JSON.stringify(out.json), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

async function login(app: FastifyInstance, owner: Keypair): Promise<string> {
  const pubkey = owner.publicKey.toBase58();
  const challenge = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey));
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { challengeId: challenge.challengeId, pubkey, signature },
  });
  const session = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!;
  return `${session.name}=${session.value}`;
}

describe('Telegram config & store persistence', () => {
  it('normalizes TELEGRAM_BOT_USERNAME, derives webhook secret, and rejects invalid secret', () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN';
    process.env.TELEGRAM_BOT_USERNAME = '@nexuspay_alerts_bot';
    delete process.env.TELEGRAM_WEBHOOK_SECRET;

    const cfg = loadConfig();
    expect(cfg.telegramBotUsername).toBe('nexuspay_alerts_bot');
    expect(cfg.telegramWebhookSecret).toMatch(/^[A-Za-z0-9_-]{16,256}$/);

    process.env.TELEGRAM_WEBHOOK_SECRET = 'short';
    expect(() => loadConfig()).toThrow(/TELEGRAM_WEBHOOK_SECRET/i);
  });

  it('loads legacy state.json without notifications and persists link/settings/error/unlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-tg-store-'));
    const statePath = join(dir, 'state.json');
    const legacy = {
      policy: defaultPolicy('agent-001'),
      ownerPubkey: null,
      requests: [],
      idempotency: {},
    };
    writeFileSync(statePath, JSON.stringify(legacy));

    const store = new Store(statePath, 'agent-001', 200);
    expect(store.getNotificationSettings()).toEqual({
      telegram: {
        enabled: true,
        chatId: null,
        username: null,
        linkedAt: null,
        lastError: null,
        events: { pendingApproval: true },
      },
    });

    const linked = store.linkTelegram({ chatId: '987654321', username: 'alice' });
    expect(linked.chatId).toBe('987654321');
    expect(linked.username).toBe('alice');
    expect(linked.linkedAt).toBeTruthy();

    store.setTelegramSettings({ enabled: false, events: { pendingApproval: false } });
    store.setTelegramError('blocked');

    const reloaded = new Store(statePath, 'agent-001', 200);
    expect(reloaded.getNotificationSettings().telegram).toMatchObject({
      enabled: false,
      chatId: '987654321',
      username: 'alice',
      lastError: 'blocked',
      events: { pendingApproval: false },
    });

    const unlinked = reloaded.unlinkTelegram();
    expect(unlinked.chatId).toBeNull();
    expect(unlinked.username).toBeNull();
    expect(unlinked.lastError).toBeNull();
    expect(unlinked.events.pendingApproval).toBe(false);
  });
});

describe('TelegramService linking, isolation & outbound delivery', () => {
  it('resolves bot username via getMe, creates single-use expiring link tokens, and isolates tenants', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-tg-svc-'));
    const config = makeConfig(dataDir, {
      TELEGRAM_BOT_TOKEN: '123456:TEST_TOKEN',
      telegramBotUsername: '',
      telegramWebhookSecret: 'secret_token_1234567890',
    });
    const ctx = createContext(config);

    let nowMs = 1_700_000_000_000;
    const { calls, fetchImpl } = mockFetchRecorder((url) => {
      if (url.endsWith('/getMe')) {
        return { json: { ok: true, result: { username: 'nexuspay_test_bot' } } };
      }
      return { json: { ok: true, result: { message_id: 10 } } };
    });

    const telegram = new TelegramService({
      config,
      getUserContext: (owner) => ctx.getUserContext!(owner),
      fetchImpl,
      now: () => nowMs,
    });

    const ownerA = Keypair.generate().publicKey.toBase58();
    const ownerB = Keypair.generate().publicKey.toBase58();

    const linkA = await telegram.createLinkToken(ownerA);
    expect(linkA.botUsername).toBe('nexuspay_test_bot');
    expect(linkA.deepLink).toBe(`https://t.me/nexuspay_test_bot?start=${linkA.token}`);
    expect(calls.filter((c) => c.url.endsWith('/getMe'))).toHaveLength(1);

    // Group chat updates are ignored.
    const groupRes = await telegram.handleUpdate({
      message: { chat: { id: -100123, type: 'group' }, text: `/start ${linkA.token}` },
    });
    expect(groupRes).toEqual({ handled: false, action: 'ignored' });

    // Valid private /start links ownerA and not ownerB.
    const linkRes = await telegram.handleUpdate({
      message: {
        chat: { id: 111222, type: 'private' },
        from: { username: 'owner_a_tg' },
        text: `/start ${linkA.token}`,
      },
    });
    expect(linkRes).toEqual({ handled: true, action: 'linked' });
    expect(ctx.getUserContext!(ownerA).store.getNotificationSettings().telegram).toMatchObject({
      chatId: '111222',
      username: 'owner_a_tg',
      enabled: true,
    });
    expect(ctx.getUserContext!(ownerB).store.getNotificationSettings().telegram.chatId).toBeNull();

    // Replay of the same token fails.
    const replayRes = await telegram.handleUpdate({
      message: { chat: { id: 333444, type: 'private' }, text: `/start ${linkA.token}` },
    });
    expect(replayRes).toEqual({ handled: true, action: 'invalid_token' });

    // Expired token fails.
    const linkB = await telegram.createLinkToken(ownerB);
    nowMs += 11 * 60 * 1000;
    const expiredRes = await telegram.handleUpdate({
      message: { chat: { id: 555666, type: 'private' }, text: `/start ${linkB.token}` },
    });
    expect(expiredRes).toEqual({ handled: true, action: 'invalid_token' });
    expect(ctx.getUserContext!(ownerB).store.getNotificationSettings().telegram.chatId).toBeNull();
  });

  it('sends over-limit alerts with inline URL button in hosted mode and text fallback on localhost', async () => {
    const recipient = Keypair.generate().publicKey.toBase58();

    // 1. Local mode: http://localhost -> no inline_keyboard, URL included in text
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'nexus-tg-local-'));
      const config = makeConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: '123456:LOCAL_TOKEN',
        telegramBotUsername: 'nexus_local_bot',
        allowedOrigins: ['http://localhost:5173'],
      });
      const ctx = createContext(config);
      const { calls, fetchImpl } = mockFetchRecorder();
      const ownerCtx = ctx.getUserContext!(config.adminPubkey);
      ownerCtx.telegram = new TelegramService({
        config,
        getUserContext: (owner) => ctx.getUserContext!(owner),
        fetchImpl,
      });
      ownerCtx.store.setPolicy({
        maxSolLamportsPerTx: 100_000_000,
        maxSolLamportsPerDay: null,
        allowedRecipients: [{ label: 'vendor', address: recipient }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      });
      ownerCtx.store.linkTelegram({ chatId: '777', username: 'localuser' });

      const req = await runAction(ownerCtx, {
        action: { type: 'transfer_sol', recipient, amountSol: 0.5 },
      });
      expect(req.status).toBe('pending_approval');

      await vi.waitFor(() => {
        expect(calls.some((c) => c.url.endsWith('/sendMessage'))).toBe(true);
      });
      const sent = calls.find((c) => c.url.endsWith('/sendMessage'))!;
      expect(sent.body?.reply_markup).toBeUndefined();
      expect(String(sent.body?.text)).toContain(`http://localhost:5173/?request=${req.id}`);
      expect(String(sent.body?.text)).toContain('0.5 SOL');
    }

    // 2. Hosted mode: https:// -> inline_keyboard URL button, and 403 records lastError without failing pipeline
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'nexus-tg-hosted-'));
      const config = makeConfig(dataDir, {
        DEPLOYMENT_MODE: 'hosted',
        authRequired: true,
        TELEGRAM_BOT_TOKEN: '123456:HOSTED_TOKEN',
        telegramBotUsername: 'nexus_hosted_bot',
        allowedOrigins: ['https://nexuspay.example.com'],
      });
      const ctx = createContext(config);
      const { calls, fetchImpl } = mockFetchRecorder(() => ({
        status: 403,
        json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      }));
      const ownerCtx = ctx.getUserContext!(config.adminPubkey);
      ownerCtx.telegram = new TelegramService({
        config,
        getUserContext: (owner) => ctx.getUserContext!(owner),
        fetchImpl,
      });
      ownerCtx.store.setPolicy({
        maxSolLamportsPerTx: 100_000_000,
        maxSolLamportsPerDay: null,
        allowedRecipients: [{ label: 'vendor', address: recipient }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      });
      ownerCtx.store.linkTelegram({ chatId: '888', username: 'hosteduser' });

      const req = await runAction(ownerCtx, {
        action: { type: 'transfer_sol', recipient, amountSol: 0.5 },
      });
      expect(req.status).toBe('pending_approval');

      await vi.waitFor(() => {
        expect(ownerCtx.store.getNotificationSettings().telegram.lastError).toMatch(/blocked/i);
      });
      const sent = calls.find((c) => c.url.endsWith('/sendMessage'))!;
      expect(sent.body?.reply_markup).toEqual({
        inline_keyboard: [
          [
            {
              text: 'Review & approve in nexusPay',
              url: `https://nexuspay.example.com/?request=${req.id}`,
            },
          ],
        ],
      });
    }

    // 3. Disabled toggle sends nothing
    {
      const dataDir = mkdtempSync(join(tmpdir(), 'nexus-tg-disabled-'));
      const config = makeConfig(dataDir, {
        TELEGRAM_BOT_TOKEN: '123456:DISABLED_TOKEN',
        telegramBotUsername: 'nexus_disabled_bot',
      });
      const ctx = createContext(config);
      const { calls, fetchImpl } = mockFetchRecorder();
      const ownerCtx = ctx.getUserContext!(config.adminPubkey);
      ownerCtx.telegram = new TelegramService({
        config,
        getUserContext: (owner) => ctx.getUserContext!(owner),
        fetchImpl,
      });
      ownerCtx.store.setPolicy({
        maxSolLamportsPerTx: 100_000_000,
        maxSolLamportsPerDay: null,
        allowedRecipients: [{ label: 'vendor', address: recipient }],
        allowedMints: [],
        maxTokenAmountByMint: {},
      });
      ownerCtx.store.linkTelegram({ chatId: '999', username: 'quietuser' });
      ownerCtx.store.setTelegramSettings({ enabled: false });

      const req = await runAction(ownerCtx, {
        action: { type: 'transfer_sol', recipient, amountSol: 0.5 },
      });
      expect(req.status).toBe('pending_approval');
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toHaveLength(0);
    }
  });
});

describe('Telegram HTTP routes & auth boundaries', () => {
  it('protects /api/notifications/telegram from MCP tokens, verifies webhook secret, and handles test alerts', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-tg-routes-'));
    const config = makeConfig(dataDir, {
      authRequired: true,
      TELEGRAM_BOT_TOKEN: '123456:ROUTES_TOKEN',
      telegramBotUsername: 'nexus_routes_bot',
      telegramWebhookSecret: 'webhook_secret_token_value',
    });
    const ctx = createContext(config);

    let failTestSend = false;
    const { fetchImpl } = mockFetchRecorder((url) => {
      if (url.endsWith('/sendMessage') && failTestSend) {
        return { status: 403, json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' } };
      }
      return { json: { ok: true, result: { message_id: 42 } } };
    });
    ctx.telegram = new TelegramService({
      config,
      getUserContext: (owner) => ctx.getUserContext!(owner),
      fetchImpl,
    });

    const app = Fastify();
    await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
    registerAuthHook(app, ctx);
    await registerRoutes(app, ctx);

    try {
      const owner = Keypair.generate();
      const cookieHeader = await login(app, owner);
      const tokenRes = await app.inject({
        method: 'POST',
        url: '/api/mcp/token/rotate',
        headers: { cookie: cookieHeader },
      });
      const mcpToken = tokenRes.json().token as string;

      // MCP bearer token must not access notification routes.
      for (const [method, url] of [
        ['GET', '/api/notifications/telegram'],
        ['POST', '/api/notifications/telegram/link-token'],
        ['PUT', '/api/notifications/telegram'],
        ['POST', '/api/notifications/telegram/test'],
        ['DELETE', '/api/notifications/telegram'],
      ] as const) {
        const denied = await app.inject({
          method,
          url,
          headers: { authorization: `Bearer ${mcpToken}` },
          payload: method === 'PUT' ? { enabled: false } : {},
        });
        expect(denied.statusCode, `${method} ${url}`).toBe(401);
      }

      // Create link token via session cookie.
      const linkRes = await app.inject({
        method: 'POST',
        url: '/api/notifications/telegram/link-token',
        headers: { cookie: cookieHeader },
      });
      expect(linkRes.statusCode).toBe(200);
      const { deepLink, startCommand } = linkRes.json() as { deepLink: string; startCommand: string };
      const token = new URL(deepLink).searchParams.get('start')!;
      expect(startCommand).toBe(`/start ${token}`);

      // Webhook rejects missing or wrong secret.
      expect(
        (await app.inject({ method: 'POST', url: '/api/webhooks/telegram', payload: {} })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/webhooks/telegram',
            headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
            payload: {},
          })
        ).statusCode,
      ).toBe(401);

      // Valid webhook links the owner's Telegram chat.
      const webhookRes = await app.inject({
        method: 'POST',
        url: '/api/webhooks/telegram',
        headers: { 'x-telegram-bot-api-secret-token': 'webhook_secret_token_value' },
        payload: {
          update_id: 1,
          message: {
            chat: { id: 54321, type: 'private' },
            from: { username: 'session_owner' },
            text: `/start ${token}`,
          },
        },
      });
      expect(webhookRes.statusCode).toBe(200);

      const stateRes = await app.inject({
        method: 'GET',
        url: '/api/notifications/telegram',
        headers: { cookie: cookieHeader },
      });
      expect(stateRes.statusCode).toBe(200);
      expect(stateRes.json().settings).toMatchObject({
        enabled: true,
        chatId: '54321',
        username: 'session_owner',
      });

      // Test notification 200 then 502 on Telegram failure.
      const testOk = await app.inject({
        method: 'POST',
        url: '/api/notifications/telegram/test',
        headers: { cookie: cookieHeader },
      });
      expect(testOk.statusCode).toBe(200);

      failTestSend = true;
      const testFail = await app.inject({
        method: 'POST',
        url: '/api/notifications/telegram/test',
        headers: { cookie: cookieHeader },
      });
      expect(testFail.statusCode).toBe(502);
      expect(testFail.json().blocked).toBe(true);

      // Update settings and unlink.
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/notifications/telegram',
        headers: { cookie: cookieHeader },
        payload: { enabled: false, events: { pendingApproval: false } },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().settings.enabled).toBe(false);

      const unlinked = await app.inject({
        method: 'DELETE',
        url: '/api/notifications/telegram',
        headers: { cookie: cookieHeader },
      });
      expect(unlinked.statusCode).toBe(200);
      expect(unlinked.json().settings.chatId).toBeNull();
    } finally {
      await app.close();
    }
  });
});
