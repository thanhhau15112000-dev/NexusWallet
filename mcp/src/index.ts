/**
 * stdio MCP server for nexusPay. stdout carries JSON-RPC only; anything a human
 * should read goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { NexusApi } from './api.js';
import { loadBaseConfig, resolveAgentToken, type McpConfig, type ResolvedToken } from './config.js';
import { createServer } from './tools.js';

async function main(): Promise<void> {
  const resolveToken = () => resolveAgentToken(process.env);
  // Bad URL or timeout settings still stop the server. A missing or ambiguous token does not:
  // the tools report it (mcp_setup_required) and discovery is retried on each call.
  let token: ResolvedToken = { agentToken: '', ownerPubkey: '', tokenSource: 'none' };
  let setupError: string | null = null;
  try {
    token = resolveToken();
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err);
  }
  const config: McpConfig = { ...loadBaseConfig(process.env), ...token };
  const server = createServer(new NexusApi(config, fetch, resolveToken), config);
  await server.connect(new StdioServerTransport());
  console.error(
    setupError
      ? `nexuspay-mcp started without an agent token (tools will report it until fixed): ${setupError}`
      : `nexuspay-mcp ready: ${config.apiUrl} (owner ${config.ownerPubkey}, source ${config.tokenSource})`,
  );
}

main().catch((err) => {
  console.error('nexuspay-mcp failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
