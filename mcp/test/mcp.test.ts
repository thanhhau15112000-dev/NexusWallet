import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NexusApi, type Fetch } from '../src/api.js';
import { loadMcpConfig, type McpConfig } from '../src/config.js';
import { createServer } from '../src/tools.js';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const config: McpConfig = {
  apiUrl: 'http://127.0.0.1:8787',
  ownerPubkey: OWNER,
  dashboardUrl: 'http://localhost:5173',
  timeoutMs: 5_000,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req_abc123',
    agentId: 'agent-001',
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    status: 'pending_approval',
    prompt: '[agent] transfer_sol 0.5 SOL -> treasury',
    idempotencyKey: 'mcp:1',
    intent: null,
    plan: { action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.5 }, rationale: '', confidence: 1 },
    decision: { verdict: 'require_approval', policyVersion: 2, reasons: ['above limit'], resolved: null },
    modelTrace: null,
    approval: {
      payload: { expiresAt: '2026-09-27T00:05:00.000Z', nonce: 'secret-nonce' },
      message: 'approval message',
      signature: null,
      signerPubkey: null,
      signedAt: null,
      consumedAt: null,
    },
    execution: null,
    balanceLamports: null,
    error: null,
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function connect(fetchImpl: Fetch) {
  const server = createServer(new NexusApi(config, fetchImpl), config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function parse(result: Awaited<ReturnType<Client['callTool']>>) {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first!.text);
}

describe('loadMcpConfig', () => {
  it('accepts a loopback agent and a valid owner', () => {
    expect(loadMcpConfig({ NEXUS_OWNER_PUBKEY: OWNER })).toMatchObject({
      apiUrl: 'http://127.0.0.1:8787',
      ownerPubkey: OWNER,
    });
  });

  it.each([
    ['https://nexus.example.com', 'hosted'],
    ['http://127.0.0.1:8787/api', 'path'],
    ['http://user:pw@127.0.0.1:8787', 'credentials'],
    ['http://0.0.0.0:8787', 'wildcard'],
  ])('rejects %s (%s)', (url) => {
    expect(() => loadMcpConfig({ NEXUS_API_URL: url, NEXUS_OWNER_PUBKEY: OWNER })).toThrow(/loopback/);
  });

  it('requires an owner address', () => {
    expect(() => loadMcpConfig({})).toThrow(/NEXUS_OWNER_PUBKEY/);
    expect(() => loadMcpConfig({ NEXUS_OWNER_PUBKEY: 'not-an-address' })).toThrow(/NEXUS_OWNER_PUBKEY/);
  });
});

describe('nexusPay MCP tools', () => {
  it('lists five tools and marks transfers as destructive', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'nexuspay_get_request',
      'nexuspay_get_status',
      'nexuspay_list_requests',
      'nexuspay_transfer_sol',
      'nexuspay_transfer_spl',
    ]);
    expect(tools.find((tool) => tool.name === 'nexuspay_transfer_sol')?.annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(tools.find((tool) => tool.name === 'nexuspay_get_status')?.annotations?.readOnlyHint).toBe(true);
  });

  it('keeps tool schemas inside the subset Gemini function calling accepts', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();

    // Gemini (Antigravity) rejects these with "Unknown name"; OpenAI and Anthropic accept the rest.
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/exclusiveMinimum|exclusiveMaximum|oneOf|allOf|\$ref/);
    }
    const transfer = tools.find((tool) => tool.name === 'nexuspay_transfer_sol')!;
    expect(transfer.inputSchema.properties?.amountSol).toMatchObject({ type: 'number', minimum: 1e-9 });
  });

  it('submits a structured transfer with the owner header and a fixed idempotency key', async () => {
    const fetchImpl = vi.fn(async () => json(200, { request: request() }));
    const client = await connect(fetchImpl as unknown as Fetch);

    const result = await client.callTool({
      name: 'nexuspay_transfer_sol',
      arguments: { recipient: 'treasury', amountSol: 0.5 },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe('http://127.0.0.1:8787/api/agent/intents');
    expect((init.headers as Record<string, string>)['x-owner-pubkey']).toBe(OWNER);
    expect(body.action).toEqual({ type: 'transfer_sol', recipient: 'treasury', amountSol: 0.5 });
    expect(body.idempotencyKey).toMatch(/^mcp:[0-9a-f-]{36}$/);

    const summary = parse(result);
    expect(result.isError).toBeFalsy();
    expect(summary.status).toBe('pending_approval');
    expect(summary.approval.nextStep).toContain('http://localhost:5173');
    expect(JSON.stringify(summary)).not.toContain('secret-nonce');
  });

  it('reports outcome_unknown with the key when the agent times out', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    const client = await connect(fetchImpl as unknown as Fetch);

    const result = await client.callTool({
      name: 'nexuspay_transfer_sol',
      arguments: { recipient: 'treasury', amountSol: 0.05, idempotencyKey: 'retry-me' },
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'outcome_unknown', idempotencyKey: 'retry-me' });
  });

  it('reports outcome_unknown when a real agent stalls after sending headers', async () => {
    const stalled = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"request":');
    });
    await new Promise<void>((done) => stalled.listen(0, '127.0.0.1', done));
    const { port } = stalled.address() as AddressInfo;
    try {
      const shortConfig = { ...config, apiUrl: `http://127.0.0.1:${port}`, timeoutMs: 1_000 };
      const server = createServer(new NexusApi(shortConfig), shortConfig);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'nexuspay_transfer_sol',
        arguments: { recipient: 'treasury', amountSol: 0.05, idempotencyKey: 'stall-1' },
      });

      expect(result.isError).toBe(true);
      expect(parse(result)).toMatchObject({ error: 'outcome_unknown', idempotencyKey: 'stall-1' });
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  });

  it('treats a server error on a transfer as an unknown outcome', async () => {
    const client = await connect(
      vi.fn(async () => json(500, { error: 'internal_error', message: 'disk full' })) as unknown as Fetch,
    );

    const result = await client.callTool({
      name: 'nexuspay_transfer_sol',
      arguments: { recipient: 'treasury', amountSol: 0.05, idempotencyKey: 'k5' },
    });

    expect(parse(result)).toMatchObject({ error: 'outcome_unknown', idempotencyKey: 'k5' });
  });

  it('applies the default list limit when no arguments are given', async () => {
    const requests = Array.from({ length: 12 }, (_, i) => request({ id: `req_${i}` }));
    const client = await connect(vi.fn(async () => json(200, { requests })) as unknown as Fetch);

    const list = parse(await client.callTool({ name: 'nexuspay_list_requests', arguments: {} }));

    expect(list).toHaveLength(10);
  });

  it('passes API errors through as tool errors', async () => {
    const client = await connect(
      vi.fn(async () => json(409, { error: 'idempotency_conflict', message: 'key reused' })) as unknown as Fetch,
    );

    const result = await client.callTool({
      name: 'nexuspay_transfer_sol',
      arguments: { recipient: 'treasury', amountSol: 0.05, idempotencyKey: 'k1' },
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ error: 'idempotency_conflict', idempotencyKey: 'k1' });
  });

  it('reports an unreachable agent without claiming an unknown outcome', async () => {
    const client = await connect(
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as Fetch,
    );

    const result = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe('agent_unreachable');
  });

  it('returns wallet status without admin or RPC details', async () => {
    const client = await connect(
      vi.fn(async () =>
        json(200, {
          cluster: 'devnet',
          rpcUrl: 'https://api.devnet.solana.com',
          isAdmin: true,
          masterFunder: { pubkey: 'funder', lamports: 1 },
          agent: { agentId: 'a', pubkey: OWNER, lamports: 250_000_000, rpcError: null, explorerUrl: 'x' },
          policy: {
            version: 3,
            maxSolPerTx: 0.1,
            allowedRecipients: [{ label: 'treasury', address: OWNER }],
            allowedMints: [],
            maxTokenAmountByMint: {},
          },
        }),
      ) as unknown as Fetch,
    );

    const status = parse(await client.callTool({ name: 'nexuspay_get_status', arguments: {} }));

    expect(status.wallet.balanceSol).toBe(0.25);
    expect(status.policy.recipients).toEqual([{ label: 'treasury', address: OWNER }]);
    expect(JSON.stringify(status)).not.toMatch(/masterFunder|isAdmin|rpcUrl/);
  });

  it('filters and limits the request list', async () => {
    const client = await connect(
      vi.fn(async () =>
        json(200, {
          requests: [
            request({ id: 'req_1', status: 'confirmed' }),
            request({ id: 'req_2', status: 'denied' }),
            request({ id: 'req_3', status: 'confirmed' }),
          ],
        }),
      ) as unknown as Fetch,
    );

    const list = parse(
      await client.callTool({ name: 'nexuspay_list_requests', arguments: { status: 'confirmed', limit: 1 } }),
    );

    expect(list.map((item: { requestId: string }) => item.requestId)).toEqual(['req_1']);
  });

  it('rejects malformed request ids before calling the agent', async () => {
    const fetchImpl = vi.fn();
    const client = await connect(fetchImpl as unknown as Fetch);

    const result = await client.callTool({ name: 'nexuspay_get_request', arguments: { requestId: '../state' } });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('stdio entry point', () => {
  it('writes only JSON-RPC to stdout', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(__dirname, '../src/index.ts')], {
      env: { ...process.env, NEXUS_OWNER_PUBKEY: OWNER },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      })}\n`,
    );
    await vi.waitFor(() => expect(stdout).toContain('\n'), { timeout: 15_000 });
    child.kill();

    const lines = stdout.trim().split('\n');
    for (const line of lines) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    expect(JSON.parse(lines[0]!).result.serverInfo.name).toBe('nexuspay');
  }, 20_000);
});
