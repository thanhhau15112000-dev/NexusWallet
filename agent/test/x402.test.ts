import Fastify from 'fastify';
import { ZodError } from 'zod';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SOLANA_DEVNET_NETWORK,
  X402_PAYMENT_HEADER,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  defaultPolicy,
  solToLamports,
} from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { PAYER_SIG, SETTLED_TX, mockLookup } = vi.hoisted(() => ({
  PAYER_SIG: '5xAgentSig1111111111111111111111111111111111111111111111111111111111111111111111111111',
  SETTLED_TX: '5xSettledTx111111111111111111111111111111111111111111111111111111111111111111111111111',
  mockLookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

// x402 requests go through undici's fetch; route them to the global fetch each test stubs.
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
}));

vi.mock('../src/chain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chain.js')>();
  return {
    ...actual,
    getMintDecimals: vi.fn().mockResolvedValue(6),
    transferSol: vi.fn().mockResolvedValue({ signature: 'sig-unused-sol', slot: 101 }),
    transferSpl: vi.fn().mockResolvedValue({ signature: 'sig-unused-spl', slot: 102 }),
    signX402Transfer: vi.fn().mockResolvedValue({
      transaction: 'AQIDBA==',
      payerSignature: PAYER_SIG,
      lastValidBlockHeight: 1000,
    }),
    getX402TransactionState: vi.fn().mockResolvedValue({ state: 'pending' }),
  };
});

import { approveRequest } from '../src/approvals.js';
import {
  getMintDecimals,
  getX402TransactionState,
  signX402Transfer,
  transferSol,
  transferSpl,
} from '../src/chain.js';
import { registerRoutes } from '../src/routes.js';
import { Store } from '../src/store.js';
import { SessionManager } from '../src/sessions.js';
import type { AppContext } from '../src/context.js';
import { resolveX402Payment, fetchWithX402, rejectPrivateLookup } from '../src/x402.js';

const MERCHANT = '6VPd7LHbx96D2QiSsAo5JrEdRQUdW1PGk3bUNYhVECAz';
const STRANGER = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEVNET_CAIP2 = SOLANA_DEVNET_NETWORK;
const FEE_PAYER = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';
const MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const tempDirs: string[] = [];

function requirements(overrides?: { amount?: string; payTo?: string; network?: string; extra?: Record<string, unknown> }) {
  return {
    scheme: 'exact',
    network: overrides?.network ?? DEVNET_CAIP2,
    amount: overrides?.amount ?? '10000', // 0.01 USDC
    asset: USDC_MINT,
    payTo: overrides?.payTo ?? MERCHANT,
    maxTimeoutSeconds: 60,
    extra: overrides?.extra ?? { feePayer: FEE_PAYER },
  };
}

function v2Challenge(overrides?: Parameters<typeof requirements>[0] & { resource?: string }) {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url: overrides?.resource ?? 'https://example.com/demo/item', mimeType: 'application/json' },
    accepts: [requirements(overrides)],
  };
}

function makeContext(overrides?: Partial<AppContext>): AppContext {
  const ownerKp = nacl.sign.keyPair();
  const ownerPubkey = bs58.encode(ownerKp.publicKey);
  const agentKp = nacl.sign.keyPair();
  const agentPubkey = bs58.encode(agentKp.publicKey);

  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-x402-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50, ownerPubkey);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'merchant', address: MERCHANT }],
    allowedMints: [{ label: 'usdc', address: USDC_MINT }],
    maxTokenAmountByMint: { [USDC_MINT]: 1 }, // 1 USDC auto-approved
  });

  const ctx = {
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
    agentPubkey,
    ownerPinned: false,
    sessions: new SessionManager(ownerPubkey, 1800),
    ...overrides,
  };

  return Object.assign(ctx, { _ownerKp: ownerKp }) as AppContext & { _ownerKp: nacl.SignKeyPair };
}

afterEach(() => {
  mockLookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.mocked(getMintDecimals).mockReset().mockResolvedValue(6);
  vi.mocked(transferSol).mockClear();
  vi.mocked(transferSpl).mockClear();
  vi.mocked(signX402Transfer).mockReset().mockResolvedValue({
    transaction: 'AQIDBA==',
    payerSignature: PAYER_SIG,
    lastValidBlockHeight: 1000,
  });
  vi.mocked(getX402TransactionState).mockReset().mockResolvedValue({ state: 'pending' });
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('x402 v2 Payment Guard integration', () => {
  it('(a) resolves a v2 challenge within cap, signing with the facilitator as fee payer and without calling transferSpl', async () => {
    const ctx = makeContext();
    const result = await resolveX402Payment(ctx, v2Challenge());

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.payerSignature).toBe(PAYER_SIG);
      const decoded = JSON.parse(Buffer.from(result.paymentHeader, 'base64').toString('utf8'));
      expect(decoded).toEqual({
        x402Version: 2,
        resource: { url: 'https://example.com/demo/item' },
        accepted: requirements(),
        payload: { transaction: 'AQIDBA==' },
      });
      expect(result.request.status).toBe('auto_approved');
      expect(result.request.x402?.transaction).toBe('AQIDBA==');
    }

    expect(signX402Transfer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(signX402Transfer).mock.calls[0]![0]).toMatchObject({
      recipient: MERCHANT,
      mint: USDC_MINT,
      baseUnits: 10_000n,
      feePayer: FEE_PAYER,
      memo: undefined,
    });
    expect(transferSpl).not.toHaveBeenCalled();
    expect(transferSol).not.toHaveBeenCalled();
  });

  it('passes the seller memo to the signer', async () => {
    const ctx = makeContext();
    await resolveX402Payment(ctx, v2Challenge({ extra: { feePayer: FEE_PAYER, memo: 'order-42' } }));
    expect(vi.mocked(signX402Transfer).mock.calls[0]![0].memo).toBe('order-42');
  });

  it('(b) denies payTo outside recipient allowlist before signing', async () => {
    const ctx = makeContext();
    const result = await resolveX402Payment(ctx, v2Challenge({ payTo: STRANGER }));

    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.code).toBe('RECIPIENT_NOT_IN_ALLOWLIST');
    }
    expect(signX402Transfer).not.toHaveBeenCalled();
  });

  it('(c) holds over-cap payment for owner approval, stays approved without broadcasting, then signs on retry with same key', async () => {
    const ctx = makeContext() as AppContext & { _ownerKp: nacl.SignKeyPair };
    // 2.5 USDC > cap of 1 USDC
    const challenge = v2Challenge({ amount: '2500000' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'x402-approve-1');
    expect(first.status).toBe('pending_approval');
    if (first.status !== 'pending_approval') throw new Error('expected pending_approval');

    expect(first.code).toBe('X402_APPROVAL_REQUIRED');
    expect(first.idempotencyKey).toBe('x402-approve-1');
    expect(signX402Transfer).not.toHaveBeenCalled();

    const message = first.request.approval!.message;
    const ownerSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), ctx._ownerKp.secretKey));
    const approved = await approveRequest(ctx, {
      requestId: first.requestId,
      signature: ownerSig,
      signerPubkey: bs58.encode(ctx._ownerKp.publicKey),
    });

    expect(approved.status).toBe('approved');
    expect(approved.approval?.consumedAt).toBeTruthy();
    expect(transferSpl).not.toHaveBeenCalled();
    expect(signX402Transfer).not.toHaveBeenCalled();

    const resumed = await resolveX402Payment(ctx, challenge, undefined, 'x402-approve-1');
    expect(resumed.status).toBe('completed');
    if (resumed.status === 'completed') {
      expect(resumed.idempotencyKey).toBe('x402-approve-1');
      expect(resumed.request.status).toBe('approved');
      expect(resumed.request.x402?.transaction).toBe('AQIDBA==');
    }
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
    expect(transferSpl).not.toHaveBeenCalled();
  });

  it('(d) reuses the signed transaction on retry while chain state is pending', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValue({ state: 'pending' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'retry-pending-1');
    const second = await resolveX402Payment(ctx, challenge, undefined, 'retry-pending-1');

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (first.status === 'completed' && second.status === 'completed') {
      expect(second.paymentHeader).toBe(first.paymentHeader);
    }
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
    expect(getX402TransactionState).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent calls with the same idempotencyKey so only one tx is signed', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    let resolveSign: ((v: { transaction: string; payerSignature: string; lastValidBlockHeight: number }) => void) | undefined;
    vi.mocked(signX402Transfer).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSign = resolve;
        }),
    );

    const p1 = resolveX402Payment(ctx, challenge, undefined, 'concurrent-key');
    const p2 = resolveX402Payment(ctx, challenge, undefined, 'concurrent-key');
    await vi.waitFor(() => expect(resolveSign).toBeTypeOf('function'));
    resolveSign!({
      transaction: 'CONCURRENT_TX',
      payerSignature: '5xConcurrentSig1111111111111111111111111111111111111111111111111111111111111111111111',
      lastValidBlockHeight: 1500,
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('completed');
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('(e) signs a new transaction when the previously signed transaction is expired', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(signX402Transfer)
      .mockResolvedValueOnce({ transaction: 'OLD_TX', payerSignature: 'OldSig111', lastValidBlockHeight: 100 })
      .mockResolvedValueOnce({ transaction: 'NEW_TX', payerSignature: 'NewSig222', lastValidBlockHeight: 200 });
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'expired' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'retry-expired-1');
    const second = await resolveX402Payment(ctx, challenge, undefined, 'retry-expired-1');

    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    if (second.status === 'completed') {
      expect(second.payerSignature).toBe('NewSig222');
      const decoded = JSON.parse(Buffer.from(second.paymentHeader, 'base64').toString('utf8'));
      expect(decoded.payload.transaction).toBe('NEW_TX');
    }
    expect(signX402Transfer).toHaveBeenCalledTimes(2);
  });

  it('(f) marks request confirmed when chain state is landed', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'landed', txId: SETTLED_TX });

    await resolveX402Payment(ctx, challenge, undefined, 'landed-1');
    const second = await resolveX402Payment(ctx, challenge, undefined, 'landed-1');

    expect(second.status).toBe('completed');
    if (second.status === 'completed') {
      expect(second.request.status).toBe('confirmed');
      expect(second.request.execution?.signature).toBe(SETTLED_TX);
    }
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('returns AGENT_FROZEN on pending retry after freeze without marking request denied or re-signing', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'pending' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'pending-freeze-1');
    expect(first.status).toBe('completed');

    ctx.store.setFrozen(true);
    const second = await resolveX402Payment(ctx, challenge, undefined, 'pending-freeze-1');
    expect(second.status).toBe('denied');
    if (second.status === 'denied') {
      expect(second.code).toBe('AGENT_FROZEN');
    }

    const stored = ctx.store.findByIdempotencyKey('pending-freeze-1');
    expect(stored?.status).toBe('auto_approved');
    expect(stored?.x402?.transaction).toBe('AQIDBA==');
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('returns policy_changed on pending retry after policy update without marking request denied', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'pending' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'pending-policy-1');
    expect(first.status).toBe('completed');

    const current = ctx.store.getPolicy();
    ctx.store.setPolicy({
      maxSolLamportsPerTx: current.maxSolLamportsPerTx,
      maxSolLamportsPerDay: current.maxSolLamportsPerDay,
      allowedRecipients: current.allowedRecipients,
      allowedMints: current.allowedMints,
      maxTokenAmountByMint: { [USDC_MINT]: 2 },
    });

    const second = await resolveX402Payment(ctx, challenge, undefined, 'pending-policy-1');
    expect(second.status).toBe('denied');
    if (second.status === 'denied') {
      expect(second.code).toBe('policy_changed');
    }

    const stored = ctx.store.findByIdempotencyKey('pending-policy-1');
    expect(stored?.status).toBe('auto_approved');
    expect(stored?.x402?.transaction).toBe('AQIDBA==');
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('marks request confirmed when signed tx landed even if agent is frozen', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'landed', txId: SETTLED_TX });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'landed-frozen-1');
    expect(first.status).toBe('completed');

    ctx.store.setFrozen(true);
    const second = await resolveX402Payment(ctx, challenge, undefined, 'landed-frozen-1');
    expect(second.status).toBe('completed');
    if (second.status === 'completed') {
      expect(second.request.status).toBe('confirmed');
    }
    expect(ctx.store.findByIdempotencyKey('landed-frozen-1')?.status).toBe('confirmed');
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('denies expired signed tx when frozen without signing a new transaction', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge();
    vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'expired' });

    const first = await resolveX402Payment(ctx, challenge, undefined, 'expired-frozen-1');
    expect(first.status).toBe('completed');

    ctx.store.setFrozen(true);
    const second = await resolveX402Payment(ctx, challenge, undefined, 'expired-frozen-1');
    expect(second.status).toBe('denied');
    if (second.status === 'denied') {
      expect(second.code).toBe('AGENT_FROZEN');
    }

    expect(ctx.store.findByIdempotencyKey('expired-frozen-1')?.status).toBe('denied');
    expect(signX402Transfer).toHaveBeenCalledTimes(1);
  });

  it('(g) rejects Solana mainnet CAIP-2 and x402 v1 challenges', async () => {
    const ctx = makeContext();

    const mainnetRes = await resolveX402Payment(ctx, v2Challenge({ network: MAINNET_CAIP2 }));
    expect(mainnetRes.status).toBe('denied');
    if (mainnetRes.status === 'denied') expect(mainnetRes.code).toBe('UNSUPPORTED_NETWORK');

    const v1Res = await resolveX402Payment(ctx, {
      x402Version: 1,
      accepts: [{ scheme: 'exact', network: 'solana-devnet', maxAmountRequired: '10000', asset: USDC_MINT, payTo: MERCHANT }],
    });
    expect(v1Res.status).toBe('denied');
    if (v1Res.status === 'denied') expect(v1Res.code).toBe('INVALID_X402_CHALLENGE');
  });

  it('(h) rejects an option with no facilitator fee payer', async () => {
    const ctx = makeContext();
    const res = await resolveX402Payment(ctx, v2Challenge({ extra: {} }));
    expect(res.status).toBe('denied');
    if (res.status === 'denied') expect(res.code).toBe('UNSUPPORTED_NETWORK');
    expect(signX402Transfer).not.toHaveBeenCalled();
  });

  it('(i) returns X402_SIGNING_FAILED and signs nothing when the signer refuses', async () => {
    const ctx = makeContext();
    vi.mocked(signX402Transfer).mockRejectedValueOnce(new Error(`agent token account holds 0 base units of ${USDC_MINT}, needs 10000`));

    const res = await resolveX402Payment(ctx, v2Challenge());
    expect(res.status).toBe('denied');
    if (res.status === 'denied') {
      expect(res.code).toBe('X402_SIGNING_FAILED');
    }
  });

  it('(j) returns IDEMPOTENCY_CONFLICT when the same key is reused for a different resource', async () => {
    const ctx = makeContext();
    await resolveX402Payment(
      ctx,
      v2Challenge({ resource: 'https://example.com/items/1' }),
      undefined,
      'shared-key',
    );
    const conflict = await resolveX402Payment(
      ctx,
      v2Challenge({ resource: 'https://example.com/items/2' }),
      undefined,
      'shared-key',
    );
    expect(conflict.status).toBe('denied');
    if (conflict.status === 'denied') {
      expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    }
  });

  it('(k) fetchWithX402 reads PAYMENT-REQUIRED, settles 402 -> 200 with PAYMENT-RESPONSE, and returns X402_SETTLEMENT_FAILED on second 402 keeping request intact', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge({ resource: 'https://merchant.example.com/items/coffee' });
    const challengeHeader = Buffer.from(JSON.stringify(challenge)).toString('base64');
    const settlementPayload = {
      success: true,
      transaction: SETTLED_TX,
      network: DEVNET_CAIP2,
      payer: ctx.agentPubkey,
    };

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (headers.get(X402_PAYMENT_HEADER)) {
        return new Response(JSON.stringify({ item: 'coffee', unlocked: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            [X402_PAYMENT_RESPONSE_HEADER]: Buffer.from(JSON.stringify(settlementPayload)).toString('base64'),
          },
        });
      }
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', [X402_PAYMENT_REQUIRED_HEADER]: challengeHeader },
      });
    });

    vi.stubGlobal('fetch', mockFetch);
    try {
      vi.mocked(getX402TransactionState).mockResolvedValueOnce({ state: 'landed', txId: SETTLED_TX });
      const okRes = await fetchWithX402(ctx, 'https://merchant.example.com/items/coffee', undefined, 'fetch-ok-1');
      expect(okRes.status).toBe(200);
      expect(okRes.data).toEqual({ item: 'coffee', unlocked: true });
      expect(okRes.payment?.status).toBe('paid');
      expect(okRes.payment?.settlement).toEqual(settlementPayload);
      expect(okRes.payment?.signature).toBe(SETTLED_TX);
      expect(vi.mocked(getX402TransactionState).mock.calls.at(-1)![1]).toMatchObject({
        payer: ctx.agentPubkey,
        payerSignature: PAYER_SIG,
        txId: SETTLED_TX,
      });
      expect(ctx.store.findByIdempotencyKey('fetch-ok-1')?.status).toBe('confirmed');

      // The same key again: already paid, so the transaction is not resent.
      mockFetch.mockClear();
      const again = await fetchWithX402(ctx, 'https://merchant.example.com/items/coffee', undefined, 'fetch-ok-1');
      expect(again.status).toBe(402);
      expect(again.data).toBeNull();
      expect(again.payment?.status).toBe('paid');
      expect(again.payment?.signature).toBe(SETTLED_TX);
      expect(again.error?.code).toBe('X402_ALREADY_PAID');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(new Headers(mockFetch.mock.calls[0]![1]?.headers).get(X402_PAYMENT_HEADER)).toBeNull();
      expect(signX402Transfer).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }

    // Now test second 402 -> X402_SETTLEMENT_FAILED, request kept for retry
    const mockFailFetch = vi.fn(async () => {
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', [X402_PAYMENT_REQUIRED_HEADER]: challengeHeader },
      });
    });
    vi.stubGlobal('fetch', mockFailFetch);
    try {
      const failRes = await fetchWithX402(ctx, 'https://merchant.example.com/items/coffee', undefined, 'fetch-fail-1');
      expect(failRes.status).toBe(402);
      expect(failRes.payment?.status).toBe('not_settled');
      expect(failRes.error?.code).toBe('X402_SETTLEMENT_FAILED');
      const saved = ctx.store.findByIdempotencyKey('fetch-fail-1');
      expect(saved?.status).toBe('auto_approved');
      expect(saved?.x402?.transaction).toBe('AQIDBA==');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a paid retry that fails in transit as submitted, not settled', async () => {
    const ctx = makeContext();
    const challenge = v2Challenge({ resource: 'https://merchant.example.com/items/coffee' });
    const challengeHeader = Buffer.from(JSON.stringify(challenge)).toString('base64');
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get(X402_PAYMENT_HEADER)) throw new Error('socket hang up');
      return new Response('{}', {
        status: 402,
        headers: { 'content-type': 'application/json', [X402_PAYMENT_REQUIRED_HEADER]: challengeHeader },
      });
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const res = await fetchWithX402(ctx, 'https://merchant.example.com/items/coffee', undefined, 'fetch-lost-1');
      expect(res.status).toBe(502);
      expect(res.error?.code).toBe('X402_FETCH_FAILED');
      expect(res.payment?.status).toBe('submitted');
      expect(res.error?.remediation).toContain('fetch-lost-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('refuses connections whose DNS answer is a private address', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      rejectPrivateLookup('localhost', { all: true }, (err) => resolve(err));
    });
    expect(error?.code).toBe('ERR_PRIVATE_ADDRESS');
  });

  it('blocks SSRF targets in fetchWithX402 before calling fetch', async () => {
    const ctx = makeContext();
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    try {
      for (const badUrl of [
        'http://127.0.0.1:8787/secret',
        'http://localhost:3000/api',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/internal',
      ]) {
        const res = await fetchWithX402(ctx, badUrl);
        expect(res.status).toBe(400);
        expect(res.error?.code).toBe('INVALID_TARGET_URL');
      }
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('HTTP routes for x402', () => {
  it('passes idempotencyKey and returns paymentHeader on POST /api/agent/x402/resolve', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);

    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/x402/resolve',
      payload: { challenge: v2Challenge(), idempotencyKey: 'route-key-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('completed');
    expect(body.idempotencyKey).toBe('route-key-1');
    expect(body.paymentHeader).toBeTruthy();

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/agent/x402/resolve',
      payload: {
        challenge: v2Challenge({ resource: 'https://example.com/other' }),
        idempotencyKey: 'route-key-1',
      },
    });
    expect(conflict.statusCode).toBe(409);
    await app.close();
  });

  it('passes idempotencyKey on POST /api/agent/x402/fetch', async () => {
    const ctx = makeContext();
    const app = Fastify();
    await registerRoutes(app, ctx);

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent/x402/fetch',
        payload: { url: 'https://example.com/free', idempotencyKey: 'route-fetch-1' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe(200);
      expect(body.payment.status).toBe('not_required');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('blocks DNS-resolved private IPs and unresolvable hosts before calling fetch', async () => {
    const ctx = makeContext();
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    try {
      for (const address of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
        mockLookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }]);
        const res = await fetchWithX402(ctx, 'https://rebind.example.com/secret');
        expect(res.status).toBe(400);
        expect(res.error?.code).toBe('INVALID_TARGET_URL');
      }

      mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
      const unresolvable = await fetchWithX402(ctx, 'https://missing.example.com/secret');
      expect(unresolvable.status).toBe(400);
      expect(unresolvable.error?.code).toBe('INVALID_TARGET_URL');
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects oversized response bodies and invalid HTTP methods on x402/fetch', async () => {
    const ctx = makeContext();
    const app = Fastify();
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'invalid_request', issues: error.issues });
      }
      throw error;
    });
    await registerRoutes(app, ctx);
    const oversized = new Uint8Array(2 * 1024 * 1024 + 64).fill(65);
    const mockFetch = vi.fn(async () => new Response(oversized, { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);
    try {
      const res = await fetchWithX402(ctx, 'https://example.com/huge');
      expect(res.status).toBe(502);
      expect(res.error?.code).toBe('X402_FETCH_FAILED');

      const badMethod = await app.inject({
        method: 'POST',
        url: '/api/agent/x402/fetch',
        payload: { url: 'https://example.com/free', method: 'TRACE' },
      });
      expect(badMethod.statusCode).toBe(400);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
});
