import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Per-tenant bearer token for MCP clients (remote /mcp or the local stdio bundle), so an MCP client never has to
 * impersonate the owner with a header. Format: `nxp_<ownerPubkey>_<secret>`; the owner
 * part only selects the tenant file, the secret is what authenticates.
 */
const TOKEN_FILE = 'mcp-token';
const BEARER = /^Bearer (nxp_([1-9A-HJ-NP-Za-km-z]{32,44})_[A-Za-z0-9_-]{43})$/;

// The MCP server only reads state and requests and proposes intents. Policy, approvals,
// owner binding, funding and task vault actions stay behind a wallet-signed session.
// Matched against the registered route pattern, not the raw URL, so path tricks such as
// dot segments, encodings or trailing slashes cannot widen the scope.
const MCP_ROUTES = new Set([
  'GET /api/state',
  'GET /api/requests',
  'GET /api/requests/:id',
  'POST /api/agent/intents',
]);

function tokenPath(usersDir: string, owner: string): string {
  return resolve(usersDir, owner, TOKEN_FILE);
}

export function loadOrCreateMcpToken(usersDir: string, owner: string, options: { rotate?: boolean } = {}): string {
  const path = tokenPath(usersDir, owner);
  if (!options.rotate && existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = `nxp_${owner}_${randomBytes(32).toString('base64url')}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

/** Returns the owner the bearer token belongs to, or null. */
export function verifyMcpToken(usersDir: string, authorization: string | undefined): string | null {
  const match = BEARER.exec(authorization ?? '');
  if (!match) return null;
  const [, presented, owner] = match as unknown as [string, string, string];
  const path = tokenPath(usersDir, owner);
  if (!existsSync(path)) return null;
  const expected = Buffer.from(readFileSync(path, 'utf8').trim());
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? owner : null;
}

type McpRequest = { method: string; routeOptions: { url?: string }; headers: { authorization?: string } };

/** Owner authenticated by an MCP token for this request, if the matched route is in the MCP scope. */
export function mcpOwnerFor(usersDir: string, req: McpRequest): string | null {
  if (!MCP_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ''}`)) return null;
  return verifyMcpToken(usersDir, req.headers.authorization);
}
