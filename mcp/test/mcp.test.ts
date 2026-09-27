import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NexusApi, type Fetch } from '../src/api.js';
import { loadMcpConfig, type McpConfig } from '../src/config.js';
import { createServer } from '../src/tools.js';

const OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const TOKEN = `nxp_${OWNER}_${'a'.repeat(43)}`;
const config: McpConfig = {
  apiUrl: 'http://127.0.0.1:8787',
  agentToken: TOKEN,
  ownerPubkey: OWNER,
  tokenSource: 'env',
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
  it('accepts a loopback agent and a valid token from env, setting tokenSource to env', () => {
    expect(loadMcpConfig({ NEXUS_AGENT_TOKEN: TOKEN })).toMatchObject({
      apiUrl: 'http://127.0.0.1:8787',
      agentToken: TOKEN,
      ownerPubkey: OWNER,
      tokenSource: 'env',
    });
  });

  it.each([
    ['https://nexus.example.com', 'hosted'],
    ['http://127.0.0.1:8787/api', 'path'],
    ['http://user:pw@127.0.0.1:8787', 'credentials'],
    ['http://0.0.0.0:8787', 'wildcard'],
  ])('rejects %s (%s)', (url) => {
    expect(() => loadMcpConfig({ NEXUS_API_URL: url, NEXUS_AGENT_TOKEN: TOKEN })).toThrow(/loopback/);
  });

  it('rejects malformed agent tokens', () => {
    expect(() => loadMcpConfig({ NEXUS_AGENT_TOKEN: OWNER })).toThrow(/malformed/);
    expect(() => loadMcpConfig({ NEXUS_AGENT_TOKEN: `${TOKEN}x` })).toThrow(/malformed/);
  });

  it('rejects nonexistent NEXUS_AGENT_DATA_DIR with clear message and path', () => {
    const bogus = resolve(tmpdir(), 'nexus-nonexistent-dir-' + Date.now());
    expect(() => loadMcpConfig({ NEXUS_AGENT_DATA_DIR: bogus })).toThrow(
      new RegExp(`NEXUS_AGENT_DATA_DIR directory does not exist: .*${bogus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  describe('token discovery from disk', () => {
    const OWNER_B = '7Y4b8zP16bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const TOKEN_B = `nxp_${OWNER_B}_${'b'.repeat(43)}`;

    it('discovers single valid owner token and ignores noise', () => {
      const tempRepo = mkdtempSync(resolve(tmpdir(), 'nexus-repo-'));
      try {
        const usersDir = resolve(tempRepo, 'agent/data/users');
        mkdirSync(usersDir, { recursive: true });

        // Noise entries that must be safely ignored:
        mkdirSync(resolve(usersDir, 'not-a-pubkey')); // invalid name
        mkdirSync(resolve(usersDir, '11111111111111111111111111111111')); // valid pubkey but no token
        const corruptedDir = resolve(usersDir, '22222222222222222222222222222222');
        mkdirSync(corruptedDir);
        writeFileSync(resolve(corruptedDir, 'mcp-token'), 'invalid-token-content');
        const mismatchedDir = resolve(usersDir, '33333333333333333333333333333333');
        mkdirSync(mismatchedDir);
        writeFileSync(resolve(mismatchedDir, 'mcp-token'), TOKEN); // owner mismatch with dir name

        // Valid owner entry
        const validDir = resolve(usersDir, OWNER);
        mkdirSync(validDir);
        const tokenPath = resolve(validDir, 'mcp-token');
        writeFileSync(tokenPath, TOKEN);

        const loaded = loadMcpConfig({}, { repoRoot: tempRepo });
        expect(loaded.ownerPubkey).toBe(OWNER);
        expect(loaded.agentToken).toBe(TOKEN);
        expect(loaded.tokenSource).toBe(tokenPath);
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('parses .env with quoted AGENT_DATA_DIR', () => {
      const tempRepo = mkdtempSync(resolve(tmpdir(), 'nexus-repo-'));
      try {
        const usersDir = resolve(tempRepo, 'agent/custom-data/users', OWNER);
        mkdirSync(usersDir, { recursive: true });
        writeFileSync(resolve(usersDir, 'mcp-token'), TOKEN);

        writeFileSync(resolve(tempRepo, '.env'), 'AGENT_DATA_DIR="./custom-data"\n');

        const loaded = loadMcpConfig({}, { repoRoot: tempRepo });
        expect(loaded.ownerPubkey).toBe(OWNER);
        expect(loaded.agentToken).toBe(TOKEN);
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('parses .env with absolute AGENT_DATA_DIR', () => {
      const tempRepo = mkdtempSync(resolve(tmpdir(), 'nexus-repo-'));
      const absDir = mkdtempSync(resolve(tmpdir(), 'nexus-absdata-'));
      try {
        const usersDir = resolve(absDir, 'users', OWNER);
        mkdirSync(usersDir, { recursive: true });
        writeFileSync(resolve(usersDir, 'mcp-token'), TOKEN);

        // Forward slashes in .env avoid unintended escape sequences on Windows
        const normalized = absDir.replaceAll('\\', '/');
        writeFileSync(resolve(tempRepo, '.env'), `AGENT_DATA_DIR="${normalized}"\n`);

        const loaded = loadMcpConfig({}, { repoRoot: tempRepo });
        expect(loaded.ownerPubkey).toBe(OWNER);
        expect(loaded.agentToken).toBe(TOKEN);
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
        rmSync(absDir, { recursive: true, force: true });
      }
    });

    it('requires NEXUS_OWNER_PUBKEY when multiple owners with tokens exist', () => {
      const tempRepo = mkdtempSync(resolve(tmpdir(), 'nexus-repo-'));
      try {
        const usersDir = resolve(tempRepo, 'agent/data/users');
        mkdirSync(resolve(usersDir, OWNER), { recursive: true });
        writeFileSync(resolve(usersDir, OWNER, 'mcp-token'), TOKEN);
        mkdirSync(resolve(usersDir, OWNER_B), { recursive: true });
        writeFileSync(resolve(usersDir, OWNER_B, 'mcp-token'), TOKEN_B);

        // Without NEXUS_OWNER_PUBKEY -> error listing owners
        expect(() => loadMcpConfig({}, { repoRoot: tempRepo })).toThrow(/multiple owners with MCP tokens found/);

        // With NEXUS_OWNER_PUBKEY -> selects specified owner
        const loaded = loadMcpConfig({ NEXUS_OWNER_PUBKEY: OWNER_B }, { repoRoot: tempRepo });
        expect(loaded.ownerPubkey).toBe(OWNER_B);
        expect(loaded.agentToken).toBe(TOKEN_B);

        // With nonexistent owner -> throws clear error
        expect(() =>
          loadMcpConfig({ NEXUS_OWNER_PUBKEY: '44444444444444444444444444444444' }, { repoRoot: tempRepo }),
        ).toThrow(/no MCP token found for owner/);
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    });

    it('fails with dashboard sign-in advice when 0 tokens found', () => {
      const tempRepo = mkdtempSync(resolve(tmpdir(), 'nexus-repo-'));
      try {
        expect(() => loadMcpConfig({}, { repoRoot: tempRepo })).toThrow(
          /sign in to the dashboard with the owner wallet once/,
        );
      } finally {
        rmSync(tempRepo, { recursive: true, force: true });
      }
    });
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

  it('submits a structured transfer with the bearer token and a fixed idempotency key', async () => {
    const fetchImpl = vi.fn(async () => json(200, { request: request() }));
    const client = await connect(fetchImpl as unknown as Fetch);

    const result = await client.callTool({
      name: 'nexuspay_transfer_sol',
      arguments: { recipient: 'treasury', amountSol: 0.5 },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).toBe('http://127.0.0.1:8787/api/agent/intents');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['x-owner-pubkey']).toBeUndefined();
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
    expect(parse(result).message).toMatch(/pnpm dev/);
  });

  it('tells the agent how to repair a rejected token when sourced from env', async () => {
    const client = await connect(vi.fn(async () => json(401, { error: 'authentication_required' })) as unknown as Fetch);

    const result = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe('mcp_token_rejected');
    expect(parse(result).message).toMatch(/Connect an AI agent|pnpm mcp:config/);
  });

  it('self-heals on 401 when token was read from file and file was rotated', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'nexus-token-heal-'));
    try {
      const tokenFile = resolve(tempDir, 'mcp-token');
      const oldToken = `nxp_${OWNER}_${'1'.repeat(43)}`;
      const newToken = `nxp_${OWNER}_${'2'.repeat(43)}`;
      writeFileSync(tokenFile, oldToken);

      const fileConfig: McpConfig = {
        ...config,
        agentToken: oldToken,
        tokenSource: tokenFile,
      };

      const calls: string[] = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.authorization || '';
        calls.push(auth);
        if (auth === `Bearer ${oldToken}`) {
          // Simulate token rotated on disk while server was running
          writeFileSync(tokenFile, newToken);
          return json(401, { error: 'unauthorized' });
        }
        if (auth === `Bearer ${newToken}`) {
          return json(200, {
            cluster: 'devnet',
            agent: { agentId: 'a', pubkey: OWNER, lamports: 100_000_000, rpcError: null, explorerUrl: 'x' },
            policy: { version: 1, maxSolPerTx: 1, allowedRecipients: [], allowedMints: [], maxTokenAmountByMint: {} },
          });
        }
        return json(500, { error: 'unexpected' });
      });

      const server = createServer(new NexusApi(fileConfig, fetchImpl as unknown as Fetch), fileConfig);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(clientTransport);

      const result = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
      expect(fileConfig.agentToken).toBe(newToken);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports token file path and NEXUS_AGENT_DATA_DIR advice when file token is rejected and unchanged', async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'nexus-token-reject-'));
    try {
      const tokenFile = resolve(tempDir, 'mcp-token');
      writeFileSync(tokenFile, TOKEN);

      const fileConfig: McpConfig = {
        ...config,
        agentToken: TOKEN,
        tokenSource: tokenFile,
      };

      const client = await (async () => {
        const server = createServer(
          new NexusApi(fileConfig, vi.fn(async () => json(401, { error: 'unauthorized' })) as unknown as Fetch),
          fileConfig,
        );
        const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(sTransport);
        const c = new Client({ name: 'test', version: '0.0.0' });
        await c.connect(cTransport);
        return c;
      })();

      const result = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });
      expect(result.isError).toBe(true);
      expect(parse(result).error).toBe('mcp_token_rejected');
      expect(parse(result).message).toContain(tokenFile);
      expect(parse(result).message).toContain('NEXUS_AGENT_DATA_DIR');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports mcp_setup_required without a token and recovers once one appears, without a restart', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        cluster: 'devnet',
        agent: { agentId: 'a', pubkey: OWNER, lamports: 0, rpcError: null, explorerUrl: 'x' },
        policy: { version: 1, maxSolLamportsPerTx: 1, maxSolPerTx: 0, allowedRecipients: [], allowedMints: [], maxTokenAmountByMint: {} },
      }),
    );
    let signedIn = false;
    const resolveToken = () => {
      if (!signedIn) throw new Error('multiple owners with MCP tokens found (a, b); set NEXUS_OWNER_PUBKEY to specify which one to use');
      return { agentToken: TOKEN, ownerPubkey: OWNER, tokenSource: '/data/users/owner/mcp-token' };
    };
    const noTokenConfig: McpConfig = { ...config, agentToken: '', ownerPubkey: '', tokenSource: 'none' };
    const server = createServer(new NexusApi(noTokenConfig, fetchImpl as unknown as Fetch, resolveToken), noTokenConfig);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);

    const before = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });
    expect(before.isError).toBe(true);
    expect(parse(before).error).toBe('mcp_setup_required');
    expect(parse(before).message).toMatch(/NEXUS_OWNER_PUBKEY/);
    expect(fetchImpl).not.toHaveBeenCalled();

    signedIn = true;
    const after = await client.callTool({ name: 'nexuspay_get_status', arguments: {} });
    expect(after.isError).toBeFalsy();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
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
      env: { ...process.env, NEXUS_AGENT_TOKEN: TOKEN },
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
