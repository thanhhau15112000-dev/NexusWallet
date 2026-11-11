import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPolicy, solToLamports } from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

import { registerRoutes } from '../src/routes.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import type { AppContext } from '../src/context.js';
import {
  decodeTransaction,
  extractTargetRecipients,
  executeSolanaActionGuard,
  inspectAndSimulateAction,
} from '../src/actions-guard.js';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const STRANGER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

const tempDirs: string[] = [];

function makeContext(overrides?: Partial<AppContext>): AppContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-solana-actions-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [],
  });

  const agentKeypair = Keypair.generate();
  const agentPubkey = agentKeypair.publicKey.toBase58();

  return {
    config: {
      AGENT_ID: 'agent-001',
      SOLANA_CLUSTER: 'devnet',
      APPROVAL_TTL_SECONDS: 300,
      allowedOrigins: ['http://localhost:5173'],
      WEB_ORIGIN: 'http://localhost:5173',
      usersDir: join(tempDir, 'users'),
      authRequired: false,
      PORT: 8787,
    } as unknown as AppContext['config'],
    store,
    audit: { record: vi.fn() } as never,
    model: {
      understand: vi.fn(),
      plan: vi.fn(),
      describe: () => ({ stage1: 'mock', stage2: 'mock', mode: 'mock' }),
    } as never,
    connection: {
      getBalance: vi.fn().mockResolvedValue(10 * LAMPORTS_PER_SOL),
      simulateTransaction: vi.fn().mockResolvedValue({
        value: {
          err: null,
          logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program return: success'],
          accounts: [{ lamports: 9.95 * LAMPORTS_PER_SOL, data: ['', 'base64'], owner: '11111111111111111111111111111111' }],
        },
      }),
      sendTransaction: vi.fn().mockResolvedValue('sig-action-versioned-123'),
      sendRawTransaction: vi.fn().mockResolvedValue('sig-action-legacy-123'),
    } as never,
    signer: agentKeypair,
    agentPubkey,
    ownerPinned: false,
    sessions: new SessionManager(TREASURY, 1800),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function createMockActionTx(fromPubkey: string, toPubkey: string, lamports: number): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(fromPubkey),
      toPubkey: new PublicKey(toPubkey),
      lamports,
    }),
  );
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.feePayer = new PublicKey(fromPubkey);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

describe('Solana Actions Guard', () => {
  it('decodes transaction and extracts target recipient accurately', () => {
    const from = Keypair.generate().publicKey.toBase58();
    const raw = createMockActionTx(from, TREASURY, 50_000_000);
    const decoded = decodeTransaction(raw);
    const recipients = extractTargetRecipients(decoded, from);
    expect(recipients).toContain(TREASURY);
  });

  it('inspects and simulates a Solana Action', async () => {
    const ctx = makeContext();
    const mockTx = createMockActionTx(ctx.agentPubkey, TREASURY, 50_000_000);

    const mockFetch = vi.fn().mockImplementation((url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ transaction: mockTx, message: 'Donate 0.05 SOL' }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Donate to Treasury',
            description: 'Support treasury operations',
            label: 'Donate 0.05 SOL',
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', mockFetch);

    const inspection = await inspectAndSimulateAction(ctx, 'https://actions.org/api/donate');
    expect(inspection.actionMetadata.title).toBe('Donate to Treasury');
    expect(inspection.simulatedSolOutflowLamports).toBe(0.05 * LAMPORTS_PER_SOL);
    expect(inspection.detectedRecipients).toContain(TREASURY);
  });

  it('executes an allowed Solana Action within policy limits', async () => {
    const ctx = makeContext();
    const mockTx = createMockActionTx(ctx.agentPubkey, TREASURY, 50_000_000); // 0.05 SOL <= 0.1 SOL limit

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ transaction: mockTx }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Donate',
            description: 'Donate SOL',
            label: 'Donate',
          }),
          { status: 200 },
        ),
      );
    }));

    const result = await executeSolanaActionGuard(ctx, 'https://actions.org/api/donate');
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.signature).toMatch(/^sig-action-/);
      expect(result.solOutflowLamports).toBe(0.05 * LAMPORTS_PER_SOL);
    }
  });

  it('denies execution when recipient is not on allowlist', async () => {
    const ctx = makeContext();
    const mockTx = createMockActionTx(ctx.agentPubkey, STRANGER, 50_000_000);

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ transaction: mockTx }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Stranger Transfer',
            description: 'Send to stranger',
            label: 'Send',
          }),
          { status: 200 },
        ),
      );
    }));

    const result = await executeSolanaActionGuard(ctx, 'https://actions.org/api/stranger');
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('RECIPIENT_NOT_IN_ALLOWLIST');
    }
  });

  it('triggers pending_approval when simulated outflow exceeds per-transaction limit', async () => {
    const ctx = makeContext();
    // Simulate outflow of 0.5 SOL (preBalance = 10 SOL, post = 9.5 SOL)
    ctx.connection.simulateTransaction = vi.fn().mockResolvedValue({
      value: {
        err: null,
        logs: [],
        accounts: [{ lamports: 9.5 * LAMPORTS_PER_SOL, data: ['', 'base64'], owner: '11111111111111111111111111111111' }],
      },
    });

    const mockTx = createMockActionTx(ctx.agentPubkey, TREASURY, 500_000_000);

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ transaction: mockTx }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Large Transfer',
            description: 'Large amount transfer',
            label: 'Send Large',
          }),
          { status: 200 },
        ),
      );
    }));

    const result = await executeSolanaActionGuard(ctx, 'https://actions.org/api/large');
    expect(result.status).toBe('pending_approval');
    if (result.status === 'pending_approval') {
      expect(result.code).toBe('ACTION_APPROVAL_REQUIRED');
      expect(result.requestId).toMatch(/^req_/);
      expect(result.approvalUrl).toContain('/#requests');
    }
  });

  it('denies action execution when agent is frozen', async () => {
    const ctx = makeContext();
    ctx.store.setFrozen(true);

    const result = await executeSolanaActionGuard(ctx, 'https://actions.org/api/any');
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('AGENT_FROZEN');
    }
  });

  it('denies action execution when RPC simulation fails', async () => {
    const ctx = makeContext();
    ctx.connection.simulateTransaction = vi.fn().mockResolvedValue({
      value: {
        err: { InstructionError: [0, 'CustomError'] },
        logs: ['Instruction failed'],
      },
    });

    const mockTx = createMockActionTx(ctx.agentPubkey, TREASURY, 50_000_000);
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ transaction: mockTx }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Faulty Action',
            description: 'Action fails simulation',
            label: 'Run',
          }),
          { status: 200 },
        ),
      );
    }));

    const result = await executeSolanaActionGuard(ctx, 'https://actions.org/api/fail');
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('SIMULATION_FAILED');
    }
  });
});

describe('HTTP routes for Solana Actions', () => {
  it('calls POST /api/agent/actions/execute', async () => {
    const ctx = makeContext();
    const mockTx = createMockActionTx(ctx.agentPubkey, TREASURY, 50_000_000);

    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify({ transaction: mockTx }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            icon: 'https://example.com/icon.png',
            title: 'Route Test',
            description: 'Testing action route',
            label: 'Execute',
          }),
          { status: 200 },
        ),
      );
    }));

    const app = Fastify();
    await registerRoutes(app, ctx);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/actions/execute',
      payload: { actionUrl: 'https://actions.org/api/test' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('completed');
    expect(body.signature).toMatch(/^sig-action-/);
    await app.close();
  });
});
