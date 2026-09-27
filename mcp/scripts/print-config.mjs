// Prints ready-to-paste MCP client entries: this checkout's absolute bundle path plus the
// owner's MCP token. Usage: pnpm mcp:config -- <owner wallet address> [apiUrl]
// The owner must have signed in to the dashboard once so the agent created its tenant.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..');
// Forward slashes work for node on Windows and need no escaping in JSON or TOML.
const bundle = resolve(repoRoot, 'dist/mcp/nexuspay-mcp.mjs').replaceAll('\\', '/');
const [owner, apiUrl = 'http://127.0.0.1:8787'] = process.argv.slice(2).filter((arg) => arg !== '--');

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Same resolution as the agent: AGENT_DATA_DIR from the environment or the repo .env,
// relative to the agent package directory, default ./data.
function agentDataDir() {
  let value = process.env.AGENT_DATA_DIR;
  const envFile = resolve(repoRoot, '.env');
  if (!value && existsSync(envFile)) {
    value = /^AGENT_DATA_DIR=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim();
  }
  return resolve(repoRoot, 'agent', value || './data');
}

if (!owner || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) {
  fail('usage: pnpm mcp:config -- <owner wallet address> [apiUrl]');
}
if (!existsSync(bundle)) fail(`bundle missing at ${bundle}; run pnpm mcp:build first`);

const tenantDir = resolve(agentDataDir(), 'users', owner);
if (!existsSync(tenantDir)) {
  fail(`no agent tenant for ${owner} under ${tenantDir}; sign in to the dashboard with that wallet once, then rerun`);
}
// Must match agent/src/mcp-token.ts: nxp_<owner>_<32 random bytes, base64url>.
const tokenFile = resolve(tenantDir, 'mcp-token');
let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
if (!token) {
  token = `nxp_${owner}_${randomBytes(32).toString('base64url')}`;
  writeFileSync(tokenFile, token, { mode: 0o600 });
}

const env = { NEXUS_API_URL: apiUrl, NEXUS_AGENT_TOKEN: token };
const json = JSON.stringify({ mcpServers: { nexuspay: { command: 'node', args: [bundle], env } } }, null, 2);

console.log(`# The token is a secret for this owner's agent wallet; do not commit these entries.
# Claude Desktop: claude_desktop_config.json | Claude Code: .mcp.json in the project root
# Antigravity: ~/.gemini/config/mcp_config.json
${json}

# Codex: ~/.codex/config.toml
[mcp_servers.nexuspay]
command = "node"
args = [${JSON.stringify(bundle)}]
env = { NEXUS_API_URL = ${JSON.stringify(apiUrl)}, NEXUS_AGENT_TOKEN = ${JSON.stringify(token)} }
tool_timeout_sec = 90`);
