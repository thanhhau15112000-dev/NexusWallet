import type { FastifyInstance } from 'fastify';
import { getSession } from '../auth-hook.js';
import type { AppContext } from '../context.js';
import { registerRemoteMcp, remoteMcpUrl } from '../mcp-remote.js';
import { createMcpToken, hasMcpToken, loadOrCreateMcpToken } from '../mcp-token.js';

/**
 * What the dashboard may know about an owner's MCP token without being given one. Hosted mode keeps
 * only a hash, so there is nothing to show until the owner creates a new token.
 */
function mcpTokenStatus(ctx: AppContext, owner: string) {
  return { owner, url: remoteMcpUrl(ctx.config), hasToken: hasMcpToken(ctx.config.usersDir, owner), token: null };
}

/**
 * Ready-to-paste entries for the remote MCP endpoint: a URL plus the tenant token as a bearer
 * header, so nothing has to be installed or cloned on the client's machine.
 */
function mcpClientConfig(ctx: AppContext, owner: string, token: string) {
  const url = remoteMcpUrl(ctx.config);
  const authorization = `Bearer ${token}`;
  return {
    owner,
    url,
    hasToken: true,
    token,
    claudeCode: `claude mcp add --transport http nexuspay ${url} --header "Authorization: ${authorization}"`,
    codexToml: [
      '[mcp_servers.nexuspay]',
      `url = ${JSON.stringify(url)}`,
      `http_headers = { Authorization = ${JSON.stringify(authorization)} }`,
      'tool_timeout_sec = 90',
    ].join('\n'),
    antigravityJson: JSON.stringify(
      { mcpServers: { nexuspay: { serverUrl: url, headers: { Authorization: authorization } } } },
      null,
      2,
    ),
    // Claude Desktop's config file only starts local processes, so the mcp-remote bridge carries the header.
    claudeDesktopJson: JSON.stringify(
      {
        mcpServers: {
          nexuspay: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}'],
            env: { AUTH_HEADER: authorization },
          },
        },
      },
      null,
      2,
    ),
  };
}

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerRemoteMcp(app, ctx);

  // MCP connection details are only handed out to a wallet-signed session, never to an MCP token.
  app.get('/api/mcp/config', async (req, reply) => {
    const session = getSession(ctx, req);
    if (!session?.owner) return reply.status(401).send({ error: 'authentication_required' });
    reply.header('cache-control', 'no-store');
    // Hosted: the token exists only as a hash and is returned once, by the create/rotate call below.
    if (ctx.config.authRequired) return mcpTokenStatus(ctx, session.owner);
    return mcpClientConfig(ctx, session.owner, loadOrCreateMcpToken(ctx.config.usersDir, session.owner));
  });

  app.post('/api/mcp/token/rotate', async (req, reply) => {
    const session = getSession(ctx, req);
    if (!session?.owner) return reply.status(401).send({ error: 'authentication_required' });
    reply.header('cache-control', 'no-store');
    // Creates the first token or replaces the current one; clients holding the old token stop working.
    const token = ctx.config.authRequired
      ? createMcpToken(ctx.config.usersDir, session.owner, { hashed: true })
      : loadOrCreateMcpToken(ctx.config.usersDir, session.owner, { rotate: true });
    return mcpClientConfig(ctx, session.owner, token);
  });
}
