/**
 * stdio MCP server for nexusPay. stdout carries JSON-RPC only; anything a human
 * should read goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NexusApi } from './api.js';
import { loadMcpConfig } from './config.js';
import { createServer } from './tools.js';

async function main(): Promise<void> {
  const config = loadMcpConfig();
  const server = createServer(new NexusApi(config), config);
  await server.connect(new StdioServerTransport());
  console.error(`nexuspay-mcp ready: ${config.apiUrl} (owner ${config.ownerPubkey}, source ${config.tokenSource})`);
}

main().catch((err) => {
  console.error('nexuspay-mcp failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
