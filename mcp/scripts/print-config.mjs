// Prints ready-to-paste MCP client entries with the absolute bundle path of this checkout.
// Usage: pnpm mcp:config -- <ownerPubkey> [apiUrl]
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Forward slashes work for node on Windows and need no escaping in JSON or TOML.
const bundle = resolve(packageRoot, '../dist/mcp/nexuspay-mcp.mjs').replaceAll('\\', '/');
const [owner = '<owner wallet address>', apiUrl = 'http://127.0.0.1:8787'] = process.argv
  .slice(2)
  .filter((arg) => arg !== '--');

if (!existsSync(bundle)) {
  console.error(`bundle missing at ${bundle}; run pnpm mcp:build first`);
  process.exit(1);
}

const env = { NEXUS_API_URL: apiUrl, NEXUS_OWNER_PUBKEY: owner };
const json = JSON.stringify({ mcpServers: { nexuspay: { command: 'node', args: [bundle], env } } }, null, 2);

console.log(`# Claude Desktop: claude_desktop_config.json | Claude Code: .mcp.json in the project root
# Antigravity: ~/.gemini/config/mcp_config.json or .agents/mcp_config.json in the workspace
${json}

# Codex: ~/.codex/config.toml
[mcp_servers.nexuspay]
command = "node"
args = [${JSON.stringify(bundle)}]
env = { NEXUS_API_URL = ${JSON.stringify(apiUrl)}, NEXUS_OWNER_PUBKEY = ${JSON.stringify(owner)} }
tool_timeout_sec = 90`);
