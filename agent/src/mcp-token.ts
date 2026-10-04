import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLAINTEXT = /^nxp_[1-9A-HJ-NP-Za-km-z]{32,44}_[A-Za-z0-9_-]{43}$/;

/**
 * What a token file holds. Hosted mode keeps only `sha256(token)` in hex, so a copy of the data
 * directory does not hand out working tokens. Local mode keeps the token itself: the stdio bundle
 * finds it on disk, and the agent only listens on loopback there.
 */
type StoredToken = { kind: 'hash'; hash: Buffer } | { kind: 'plaintext'; token: string };

function readStored(path: string): StoredToken | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8').trim();
  if (SHA256_HEX.test(content)) return { kind: 'hash', hash: Buffer.from(content, 'hex') };
  if (PLAINTEXT.test(content)) return { kind: 'plaintext', token: content };
  return null;
}

// Temp file then rename, so a crash mid-write cannot leave a half-written token that locks the owner out.
function writeTokenFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function newToken(owner: string): string {
  return `nxp_${owner}_${randomBytes(32).toString('base64url')}`;
}

/** Whether this owner has a usable token on file, in either format. */
export function hasMcpToken(usersDir: string, owner: string): boolean {
  return readStored(tokenPath(usersDir, owner)) !== null;
}

/**
 * Makes a new token, replacing any earlier one, and returns it. This is the only time hosted mode can
 * return the plaintext: what is written to disk is its hash.
 */
export function createMcpToken(usersDir: string, owner: string, options: { hashed: boolean }): string {
  const token = newToken(owner);
  writeTokenFile(tokenPath(usersDir, owner), options.hashed ? sha256(token).toString('hex') : token);
  return token;
}

/** Local mode: the plaintext token on disk, created if missing. A hashed file cannot be read back, so it is replaced. */
export function loadOrCreateMcpToken(usersDir: string, owner: string, options: { rotate?: boolean } = {}): string {
  const stored = options.rotate ? null : readStored(tokenPath(usersDir, owner));
  if (stored?.kind === 'plaintext') return stored.token;
  return createMcpToken(usersDir, owner, { hashed: false });
}

type TokenConfig = { usersDir: string; authRequired: boolean };

/**
 * Returns the owner the bearer token belongs to, or null. Accepts either file format. In hosted mode a
 * plaintext file from an earlier version is rewritten as its hash on first read; the token keeps working.
 */
export function verifyMcpToken(config: TokenConfig, authorization: string | undefined): string | null {
  const match = BEARER.exec(authorization ?? '');
  if (!match) return null;
  const [, presented, owner] = match as unknown as [string, string, string];
  const path = tokenPath(config.usersDir, owner);
  const stored = readStored(path);
  if (!stored) return null;
  // Both sides are hashed, so the comparison is over fixed-length values whatever the file held.
  const expected = stored.kind === 'hash' ? stored.hash : sha256(stored.token);
  if (stored.kind === 'plaintext' && config.authRequired) {
    try {
      writeTokenFile(path, expected.toString('hex'));
    } catch {
      // A read-only data directory only delays the migration; the presented token is still judged below.
    }
  }
  return timingSafeEqual(expected, sha256(presented)) ? owner : null;
}

type McpRequest = { method: string; routeOptions: { url?: string }; headers: { authorization?: string } };

/** Owner authenticated by an MCP token for this request, if the matched route is in the MCP scope. */
export function mcpOwnerFor(config: TokenConfig, req: McpRequest): string | null {
  if (!MCP_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ''}`)) return null;
  return verifyMcpToken(config, req.headers.authorization);
}
