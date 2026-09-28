import type { FastifyInstance } from 'fastify';
import { LOCAL_ORIGIN_REGEX } from './config.js';
import type { AppContext } from './context.js';
import { mcpOwnerFor } from './mcp-token.js';
import { SESSION_COOKIE_NAME } from './sessions.js';

export const PUBLIC_AUTH_PATHS = new Set([
  '/api/health',
  '/api/auth/challenge',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
]);
export const PUBLIC_ACTION_PATH_PREFIX = '/api/actions/';

/**
 * Every /api route needs a wallet-signed session, in every deployment mode. The one
 * exception is MCP: a per-tenant MCP token (sent by the remote /mcp endpoint or the local
 * stdio bundle) may call the small read/propose route set listed in mcp-token.ts.
 */
export function registerAuthHook(app: FastifyInstance, ctx: AppContext): void {
  const { config } = ctx;
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const pathname = req.url.split('?', 1)[0] ?? req.url;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const isPublicAction = pathname.startsWith(PUBLIC_ACTION_PATH_PREFIX);
    if (
      mutating &&
      !isPublicAction &&
      req.headers.origin &&
      !config.allowedOrigins.includes(req.headers.origin) &&
      !LOCAL_ORIGIN_REGEX.test(req.headers.origin)
    ) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    if (PUBLIC_AUTH_PATHS.has(pathname) || isPublicAction) return;

    const cookieValue = req.cookies?.[SESSION_COOKIE_NAME];
    const unsigned = cookieValue ? req.unsignCookie(cookieValue) : null;
    const session = unsigned?.valid && unsigned.value ? ctx.sessions.getSession(unsigned.value) : null;
    if (session) return;
    if (mcpOwnerFor(config.usersDir, req)) return;
    return reply.status(401).send({ error: 'authentication_required' });
  });
}
