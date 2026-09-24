import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { registerRoutes } from './routes.js';
import { SESSION_COOKIE_NAME } from './sessions.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const CHROME_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/i;
const PUBLIC_AUTH_PATHS = new Set([
  '/api/health',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
]);

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: {
      level: 'info',
      // Prompts and signatures must never land in the log verbatim.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body'],
    },
  });

  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET, hook: 'onRequest' });

  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const allowed = config.authRequired
        ? config.allowedOrigins.includes(origin) || CHROME_EXTENSION_ORIGIN.test(origin)
        : LOCAL_ORIGIN.test(origin) || config.allowedOrigins.includes(origin);
      cb(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.addHook('preHandler', async (req, reply) => {
    if (!config.authRequired || !req.url.startsWith('/api/')) return;
    const pathname = req.url.split('?', 1)[0] ?? req.url;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && req.headers.origin !== config.allowedOrigins[0]) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    if (PUBLIC_AUTH_PATHS.has(pathname)) return;

    const cookieValue = req.cookies?.[SESSION_COOKIE_NAME];
    const unsigned = cookieValue ? req.unsignCookie(cookieValue) : null;
    const session = unsigned?.valid && unsigned.value ? ctx.sessions.getSession(unsigned.value) : null;
    if (!session) return reply.status(401).send({ error: 'authentication_required' });
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'invalid_request', issues: error.issues });
    }
    app.log.error({ err: error }, 'unhandled error');
    const message = error instanceof Error ? error.message : 'unexpected error';
    return reply.status(500).send({ error: 'internal_error', message });
  });

  const ctx = createContext(config);
  await registerRoutes(app, ctx);

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

  await app.listen({ port: config.PORT, host: config.HOST });

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
