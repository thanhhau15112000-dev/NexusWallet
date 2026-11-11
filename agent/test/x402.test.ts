import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPolicy, solToLamports, formatX402SignatureHeader } from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chain.js')>();
  return {
    ...actual,
    transferSol: vi.fn().mockResolvedValue({ signature: 'sig-x402-sol-tx', slot: 101 }),
    transferSpl: vi.fn().mockResolvedValue({ signature: 'sig-x402-spl-tx', slot: 102 }),
  };
});

import { transferSol, transferSpl } from '../src/chain.js';
import { registerRoutes } from '../src/routes.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import type { AppContext } from '../src/context.js';
import { resolveX402Payment, fetchWithX402 } from '../src/x402.js';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const STRANGER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BAD_MINT = 'So11111111111111111111111111111111111111111';

const tempDirs: string[] = [];

function makeContext(overrides?: Partial<AppContext>): AppContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-x402-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [{ label: 'usdc', address: USDC_MINT }],
    maxTokenAmountByMint: { [USDC_MINT]: 10 },
  });

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
    connection: { getBalance: vi.fn().mockResolvedValue(100_000_000_000) } as never,
    signer: {} as never,
    agentPubkey: TREASURY,
    ownerPinned: false,
    sessions: new SessionManager(TREASURY, 1800),
    ...overrides,
  };
}

afterEach(() => {
  vi.mocked(transferSol).mockClear();
  vi.mocked(transferSpl).mockClear();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('x402 Payment Guard integration', () => {
  it('successfully resolves an allowlisted SOL x402 challenge within policy', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      error: 'Payment required',
      accepts: [
        {
          scheme: 'exact',
          network: 'solana-devnet',
          amount: '50000000', // 0.05 SOL in lamports
          asset: 'native',
          payee: TREASURY,
          resource: 'https://api.example.com/v1/data',
          nonce: 'invoice_12345',
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.signature).toBe('sig-x402-sol-tx');
      expect(result.paymentSignatureHeader).toBeTruthy();
      // Decode PAYMENT-SIGNATURE
      const decoded = JSON.parse(Buffer.from(result.paymentSignatureHeader, 'base64').toString('utf8'));
      expect(decoded.network).toBe('solana-devnet');
      expect(decoded.payload.signature).toBe('sig-x402-sol-tx');
      expect(decoded.payload.authorization.from).toBe(TREASURY);
      expect(decoded.payload.authorization.to).toBe(TREASURY);
      expect(decoded.payload.authorization.nonce).toBe('invoice_12345');
    }

    expect(transferSol).toHaveBeenCalledTimes(1);
  });

  it('successfully resolves base64-encoded PAYMENT-REQUIRED header', async () => {
    const ctx = makeContext();
    const challengeObj = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: 10000000, // 0.01 SOL
          asset: 'SOL',
          payee: TREASURY,
          nonce: 'b64_nonce_999',
        },
      ],
    };
    const b64Header = Buffer.from(JSON.stringify(challengeObj)).toString('base64');

    const result = await resolveX402Payment(ctx, b64Header, 'https://service.com/query');
    expect(result.status).toBe('completed');
    expect(transferSol).toHaveBeenCalledTimes(1);
  });

  it('resolves an allowlisted SPL token challenge', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: 2.5,
          asset: USDC_MINT,
          payee: TREASURY,
          nonce: 'spl_nonce_42',
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('completed');
    expect(transferSpl).toHaveBeenCalledTimes(1);
  });

  it('triggers pending_approval with fast-fail X402_APPROVAL_REQUIRED when exceeding limit', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: '500000000', // 0.5 SOL > 0.1 SOL limit
          asset: 'native',
          payee: TREASURY,
          nonce: 'large_invoice',
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('pending_approval');
    if (result.status === 'pending_approval') {
      expect(result.code).toBe('X402_APPROVAL_REQUIRED');
      expect(result.approvalUrl).toContain('/#requests');
      expect(result.requestId).toMatch(/^req_/);
      expect(result.request.status).toBe('pending_approval');
    }
    // No transaction was executed
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('denies payment when recipient is not on allowlist', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: '10000000',
          asset: 'native',
          payee: STRANGER,
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('RECIPIENT_NOT_IN_ALLOWLIST');
    }
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('denies payment when SPL mint is not on allowlist', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: 1,
          asset: BAD_MINT,
          payee: TREASURY,
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('MINT_NOT_IN_ALLOWLIST');
    }
    expect(transferSpl).not.toHaveBeenCalled();
  });

  it('denies payment when agent is frozen', async () => {
    const ctx = makeContext();
    ctx.store.setFrozen(true);

    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: '10000000',
          asset: 'native',
          payee: TREASURY,
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('AGENT_FROZEN');
    }
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('guarantees idempotency and prevents double-spend on retried x402 challenge', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: '10000000',
          asset: 'native',
          payee: TREASURY,
          resource: 'https://data.org/feed',
          nonce: 'feed_req_001',
        },
      ],
    };

    const first = await resolveX402Payment(ctx, challenge);
    expect(first.status).toBe('completed');
    expect(transferSol).toHaveBeenCalledTimes(1);

    // Retry with identical challenge & nonce
    const retry = await resolveX402Payment(ctx, challenge);
    expect(retry.status).toBe('completed');
    if (first.status === 'completed' && retry.status === 'completed') {
      expect(retry.signature).toBe(first.signature);
      expect(retry.request.id).toBe(first.request.id);
    }
    // Crucial: transferSol must NOT be called a second time!
    expect(transferSol).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported networks cleanly', async () => {
    const ctx = makeContext();
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          amount: '1000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payee: '0x1234567890123456789012345678901234567890',
        },
      ],
    };

    const result = await resolveX402Payment(ctx, challenge);
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('UNSUPPORTED_NETWORK');
    }
  });

  it('handles fetchWithX402 full negotiation loop', async () => {
    const ctx = makeContext();

    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation((url, init) => {
      attempts++;
      const headers = new Headers(init?.headers);
      if (headers.get('PAYMENT-SIGNATURE')) {
        return Promise.resolve(
          new Response(JSON.stringify({ secretData: 'unlocked-content' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      const challenge = {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'solana',
            amount: '20000000',
            asset: 'native',
            payee: TREASURY,
            nonce: 'nonce_fetch_test',
          },
        ],
      };
      return Promise.resolve(
        new Response(JSON.stringify(challenge), {
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64'),
          },
        }),
      );
    });

    vi.stubGlobal('fetch', mockFetch);

    try {
      const res = await fetchWithX402(ctx, 'https://premium.ai/api');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ secretData: 'unlocked-content' });
      expect(res.payment?.status).toBe('paid');
      expect(res.payment?.signature).toBe('sig-x402-sol-tx');
      expect(attempts).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HTTP routes for x402', () => {
  it('calls POST /api/agent/x402/resolve', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);

    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'solana',
          amount: '10000000',
          asset: 'native',
          payee: TREASURY,
          nonce: 'route_test_1',
        },
      ],
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/x402/resolve',
      payload: { challenge },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('completed');
    expect(body.signature).toBe('sig-x402-sol-tx');
    await app.close();
  });
});
