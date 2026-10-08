import type { FastifyInstance, FastifyRequest } from 'fastify';
import { handleRemoteMcpRequest } from '@nexus/mcp/remote';
import type { AppContext } from './context.js';
import { verifyMcpToken } from './mcp-token.js';

type McpUrlConfig = Pick<AppContext['config'], 'authRequired' | 'allowedOrigins' | 'PORT'>;

/**
 * The URL an MCP client connects to. Hosted: the dashboard origin, which this same server
 * answers. Local: the agent port directly, since the Vite dev proxy only forwards /api.
 */
export function remoteMcpUrl(config: McpUrlConfig): string {
  return config.authRequired ? `${config.allowedOrigins[0]}/mcp` : `http://127.0.0.1:${config.PORT}/mcp`;
}

const HOP_BY_HOP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

function headerValue(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Tool calls reach the agent API through app.inject, not the network, so they pass the same
 * auth hook and MCP route scope as the stdio server without depending on the public URL.
 */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string> | undefined,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(res.headers)) {
      const text = headerValue(value);
      if (text !== undefined && !HOP_BY_HOP.has(key)) headers.set(key, text);
    }
    const noBody = res.statusCode === 204 || res.statusCode === 304;
    return new Response(noBody ? null : res.body, { status: res.statusCode, headers });
  }) as typeof fetch;
}

function toWebRequest(req: FastifyRequest): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    const text = headerValue(value);
    if (text !== undefined && !HOP_BY_HOP.has(key)) headers.set(key, text);
  }
  // The body is handed over already parsed, so the web request carries headers only.
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers });
}

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). An AI client connects with the URL and
 * `Authorization: Bearer <MCP token>`; the token is the only credential it accepts, and the
 * tools behind it can only read status/requests and propose transfers through the policy.
 */
export function registerRemoteMcp(app: FastifyInstance, ctx: AppContext): void {
  const dashboardUrl = ctx.config.allowedOrigins[0] ?? 'http://localhost:5173';

  app.post('/mcp', async (req, reply) => {
    const owner = verifyMcpToken(ctx.config, req.headers.authorization);
    if (!owner) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send({
          error: 'authentication_required',
          message: 'Send Authorization: Bearer <MCP token> from the nexusPay dashboard (Wallet tab > Connect an AI agent).',
        });
    }
    const agentToken = req.headers.authorization!.slice('Bearer '.length);
    const result = await handleRemoteMcpRequest(toWebRequest(req), req.body, {
      agentToken,
      ownerPubkey: owner,
      dashboardUrl,
      fetchImpl: injectFetch(app),
    });
    for (const [key, value] of Object.entries(result.headers)) {
      if (!HOP_BY_HOP.has(key)) reply.header(key, value);
    }
    return reply.status(result.status).send(result.body);
  });

  // Stateless: there is no standalone SSE stream to open and no session to end.
  app.route({
    method: ['GET', 'DELETE'],
    url: '/mcp',
    handler: async (_req, reply) =>
      reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed', message: 'use POST' }),
  });
}
