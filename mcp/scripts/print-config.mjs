// Prints ready-to-paste MCP client entries with absolute bundle paths.
// Token is discovered automatically by the MCP server at startup from the agent data directory.
// Usage: pnpm mcp:config [apiUrl]
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..');
// Forward slashes work for node on Windows and need no escaping in JSON or TOML.
const bundle = resolve(repoRoot, 'dist/mcp/nexuspay-mcp.mjs').replaceAll('\\', '/');

const args = process.argv.slice(2).filter((arg) => arg !== '--');
// Support optional apiUrl argument (or pass owner argument as first arg for backward compatibility)
let apiUrl = 'http://127.0.0.1:8787';
for (const arg of args) {
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    apiUrl = arg;
  }
}

if (!existsSync(bundle)) {
  console.warn(`[WARN] bundle missing at ${bundle}; run pnpm mcp:build first\n`);
}

const env = apiUrl !== 'http://127.0.0.1:8787' ? { NEXUS_API_URL: apiUrl } : undefined;

const json = JSON.stringify(
  {
    mcpServers: {
      nexuspay: {
        command: 'node',
        args: [bundle],
        ...(env ? { env } : {}),
      },
    },
  },
  null,
  2,
);

console.log(`# nexusPay MCP Configuration (Zero-Config)
# The server discovers the agent token automatically from the agent data directory.
# Sign in to the dashboard with your wallet once before connecting your MCP client.
#
# Claude Desktop: claude_desktop_config.json | Claude Code: .mcp.json in the project root
# Cursor: .cursor/mcp.json | Antigravity: ~/.gemini/config/mcp_config.json
${json}

# Codex: ~/.codex/config.toml
[mcp_servers.nexuspay]
command = "node"
args = [${JSON.stringify(bundle)}]${env ? `\nenv = { NEXUS_API_URL = ${JSON.stringify(apiUrl)} }` : ''}
tool_timeout_sec = 90`);
