import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { isOriginAllowed, loadConfig, trustProxySetting } from './config.js';
import { createContext } from './context.js';
import { registerAuthHook } from './auth-hook.js';
import { registerRateLimit } from './rate-limit.js';
import { registerRoutes } from './routes.js';

const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/i;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    trustProxy: trustProxySetting(config),
    logger: {
      level: config.LOG_LEVEL,
      // Prompts and signatures must never land in the log verbatim.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
    },
  });

  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET, hook: 'onRequest' });

  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const allowed = isOriginAllowed(origin, config) || (config.authRequired && CHROME_EXTENSION_ORIGIN.test(origin));
      cb(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('permissions-policy')) reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });

  const ctx = createContext(config, app.log);

  // Hosted only: local mode binds loopback, where every client shares one address.
  if (config.authRequired) registerRateLimit(app, ctx);
  registerAuthHook(app, ctx);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_request', issues: error.issues });
    }
    app.log.error({ err: error }, 'unhandled error');
    const message = config.authRequired
      ? 'internal server error'
      : error instanceof Error
        ? error.message
        : 'unexpected error';
    return reply.status(500).send({ error: 'internal_error', message });
  });

  await registerRoutes(app, ctx);
  app.log.info({ adminPubkey: config.adminPubkey }, 'routes registered');

  if (config.authRequired) {
    const webRoot = resolve(process.cwd(), '../web/dist');
    if (!existsSync(resolve(webRoot, 'index.html'))) {
      throw new Error(`hosted dashboard build is missing at ${webRoot}; build the web workspace first`);
    }
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      maxAge: '1d',
      immutable: false,
    });
    app.get('/', async (_req, reply) => reply.sendFile('index.html', { maxAge: 0, immutable: false }));
    app.setNotFoundHandler(async (req, reply) => {
      const pathname = req.url.split('?', 1)[0] ?? req.url;
      if (
        !['GET', 'HEAD'].includes(req.method) ||
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/assets' ||
        pathname.startsWith('/assets/')
      ) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html', { maxAge: 0, immutable: false });
    });
  }

  app.addHook('onClose', async () => {
    ctx.telegram?.stop();
  });

  await app.listen({ port: config.PORT, host: config.HOST });

  void ctx.telegram?.start();

  const models = ctx.model.describe();
  app.log.info(
    {
      agentId: config.AGENT_ID,
      agentPubkey: ctx.agentPubkey,
      cluster: config.SOLANA_CLUSTER,
      stage1: models.stage1,
      stage2: models.stage2,
      owner: ctx.store.getOwner(),
    },
    'nexus agent ready',
  );
}

main().catch((err) => {
  console.error('agent failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
