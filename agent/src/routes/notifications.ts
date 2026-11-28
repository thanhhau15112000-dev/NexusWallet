import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSession } from '../auth-hook.js';
import type { AppContext } from '../context.js';
import { safeEqual } from '../crypto.js';
import { resolveUserContext } from './shared.js';

const TelegramSettingsBody = z.object({
  enabled: z.boolean().optional(),
  silent: z.boolean().optional(),
  language: z.enum(['en', 'vi']).optional(),
  events: z
    .object({
      pendingApproval: z.boolean().optional(),
      txDenied: z.boolean().optional(),
      txFailed: z.boolean().optional(),
      txConfirmed: z.boolean().optional(),
      approvalExpired: z.boolean().optional(),
    })
    .optional(),
});

export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/notifications/telegram', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    reply.header('cache-control', 'no-store');
    return {
      botConfigured: Boolean(ctx.telegram?.isConfigured()),
      botUsername: ctx.telegram?.getBotUsername() ?? null,
      mode: ctx.config.DEPLOYMENT_MODE,
      settings: userCtx.store.getNotificationSettings().telegram,
    };
  });

  app.post('/api/notifications/telegram/link-token', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    reply.header('cache-control', 'no-store');
    if (!ctx.telegram?.isConfigured()) {
      return reply.status(503).send({
        error: 'telegram_not_configured',
        message: 'Telegram bot token is not configured on this agent.',
      });
    }
    const owner = userCtx.store.getOwner() ?? getSession(ctx, req)?.owner;
    if (!owner) {
      return reply.status(400).send({
        error: 'no_owner',
        message: 'No owner wallet is bound to this agent.',
      });
    }
    try {
      const link = await ctx.telegram.createLinkToken(owner);
      return {
        deepLink: link.deepLink,
        startCommand: `/start ${link.token}`,
        expiresAt: link.expiresAt,
        botUsername: link.botUsername,
      };
    } catch (err) {
      return reply.status(502).send({
        error: 'telegram_unavailable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.put('/api/notifications/telegram', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    reply.header('cache-control', 'no-store');
    const body = TelegramSettingsBody.parse(req.body ?? {});
    const settings = userCtx.store.setTelegramSettings(body);
    userCtx.audit.record('notifications.telegram_updated', null, {
      enabled: settings.enabled,
      silent: settings.silent,
      language: settings.language,
      events: settings.events,
    });
    return { settings };
  });

  app.post('/api/notifications/telegram/test', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    reply.header('cache-control', 'no-store');
    if (!ctx.telegram?.isConfigured()) {
      return reply.status(503).send({
        error: 'telegram_not_configured',
        message: 'Telegram bot token is not configured on this agent.',
      });
    }
    const current = userCtx.store.getNotificationSettings().telegram;
    if (!current.chatId) {
      return reply.status(400).send({
        error: 'telegram_not_linked',
        message: 'Connect a Telegram account before sending a test alert.',
      });
    }
    const result = await ctx.telegram.sendTestNotification(userCtx);
    if (!result.ok) {
      return reply.status(502).send({
        error: 'telegram_send_failed',
        message: result.error,
        blocked: result.blocked,
      });
    }
    return { ok: true };
  });

  app.delete('/api/notifications/telegram', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    reply.header('cache-control', 'no-store');
    const settings = userCtx.store.unlinkTelegram();
    userCtx.audit.record('notifications.telegram_unlinked', null, {});
    return { settings };
  });

  app.post('/api/webhooks/telegram', async (req, reply) => {
    if (!ctx.telegram?.isConfigured()) {
      return reply.status(503).send({ error: 'telegram_not_configured' });
    }
    const header = req.headers['x-telegram-bot-api-secret-token'];
    const presented = typeof header === 'string' ? header : '';
    const expected = ctx.telegram.getWebhookSecret();
    if (!expected || !safeEqual(presented, expected)) {
      return reply.status(401).send({ error: 'invalid_webhook_secret' });
    }
    await ctx.telegram.handleUpdate(req.body);
    return { ok: true };
  });
}
