import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Fetch } from '../src/api.js';
import { handleRemoteMcpRequest } from '../src/remote.js';

const TOKEN = `nxp_${'1'.repeat(44)}_${'A'.repeat(43)}`;

const state = {
  cluster: 'devnet',
  agent: { agentId: 'agent-1', pubkey: 'AgentPubkey111', lamports: 2_500_000_000, rpcError: null, explorerUrl: 'https://x' },
  policy: { version: 3, maxSolLamportsPerTx: 1, maxSolPerTx: 0.5, allowedRecipients: [], allowedMints: [], maxTokenAmountByMint: {} },
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

describe('remote MCP endpoint', () => {
  it('serves a real Streamable HTTP client and forwards its bearer token to the agent API', async () => {
    const apiCalls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: Fetch = async (input, init) => {
      apiCalls.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // Stand-in for the agent's /mcp route: the host verifies the token, then hands the request over.
    const http = createHttpServer(async (req, res) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string' && key !== 'content-length') headers.set(key, value);
      }
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const result = await handleRemoteMcpRequest(
        new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers }),
        body,
        { agentToken: TOKEN, ownerPubkey: '1'.repeat(44), dashboardUrl: 'https://dash.example', fetchImpl },
      );
      res.writeHead(result.status, result.headers).end(result.body);
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const { port } = http.address() as AddressInfo;

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['nexuspay_get_status', 'nexuspay_transfer_sol', 'nexuspay_list_requests']),
      );

      const result = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });
      expect(result.isError).toBeFalsy();
      const status = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(status.wallet.address).toBe('AgentPubkey111');
      expect(status.wallet.balanceSol).toBe(2.5);
      expect(status.policy.maxSolPerTransaction).toBe(0.5);

      // Tool calls reuse the caller's token against the API, so the API's MCP route scope applies.
      expect(apiCalls).toEqual([{ url: 'http://nexus.internal/api/state', authorization: `Bearer ${TOKEN}` }]);
    } finally {
      await client.close();
      await new Promise((done) => http.close(done));
    }
  });
});
