import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { registerRoutes } from './routes.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

async function main(): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: {
      level: 'info',
      // Prompts and signatures must never land in the log verbatim.
      redact: ['req.headers.authorization', 'req.body'],
    },
  });

  await app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const allowed = LOCAL_ORIGIN.test(origin) || config.allowedOrigins.includes(origin);
      cb(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
