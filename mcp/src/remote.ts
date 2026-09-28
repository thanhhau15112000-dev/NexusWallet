/**
 * Remote (Streamable HTTP) MCP endpoint. The agent service mounts this at /mcp so an AI
 * client connects with a URL and a bearer token, with nothing to install or clone.
 * Each request is stateless: a fresh server runs the same tools as the stdio bundle.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NexusApi, type Fetch } from './api.js';
import type { McpConfig } from './config.js';
import { createServer } from './tools.js';

export type RemoteMcpOptions = {
  /** The caller's MCP token, already verified by the host. Tool calls reuse it, so the API applies the MCP route scope. */
  agentToken: string;
  ownerPubkey: string;
  dashboardUrl: string;
  /** Calls the agent API in-process; the base URL below is never resolved over the network. */
  fetchImpl: Fetch;
  timeoutMs?: number;
};

export type RemoteMcpResponse = { status: number; headers: Record<string, string>; body: string };

const IN_PROCESS_API = 'http://nexus.internal';

export async function handleRemoteMcpRequest(
  request: Request,
  parsedBody: unknown,
  options: RemoteMcpOptions,
): Promise<RemoteMcpResponse> {
  const config: McpConfig = {
    apiUrl: IN_PROCESS_API,
    dashboardUrl: options.dashboardUrl,
    timeoutMs: options.timeoutMs ?? 45_000,
    agentToken: options.agentToken,
    ownerPubkey: options.ownerPubkey,
    tokenSource: 'remote',
  };
  const server = createServer(new NexusApi(config, options.fetchImpl), config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, { parsedBody });
    // Read the whole body before closing: JSON responses complete once the tool call returns.
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body };
  } finally {
    await server.close();
  }
}
