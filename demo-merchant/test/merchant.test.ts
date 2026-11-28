import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, resetFeePayerCache, type Env } from '../src/index.js';

const BASE_ENV: Env = {
  MERCHANT_WALLET: '6VPd7LHbx96D2QiSsAo5JrEdRQUdW1PGk3bUNYhVECAz',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
};
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const FEE_PAYER = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';

function decode(header: string | null): any {
  return JSON.parse(atob(header!));
}

/** Facilitator stub: `/supported` lists devnet; verify and settle answer as given and record their bodies. */
function facilitator(answers: { verify?: unknown; settle?: unknown } = {}) {
  const calls: Record<string, any> = {};
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('/').pop()!;
    if (path === 'supported') {
      return new Response(JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET, extra: { feePayer: FEE_PAYER } }] }));
    }
    calls[path] = JSON.parse(String(init?.body));
    if (path === 'verify') return new Response(JSON.stringify(answers.verify ?? { isValid: true, payer: 'AgentWallet111' }));
    if (path === 'settle') {
      return new Response(
        JSON.stringify(answers.settle ?? { success: true, transaction: '5xSettledSig111', network: DEVNET, payer: 'AgentWallet111' }),
      );
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const paymentHeader = btoa(JSON.stringify({ x402Version: 2, accepted: {}, payload: { transaction: 'BASE64_TX' } }));

afterEach(() => {
  resetFeePayerCache();
  vi.unstubAllGlobals();
});

describe('demo-merchant x402 Worker', () => {
  it('answers 402 with a v2 challenge in PAYMENT-REQUIRED, priced per item, naming the facilitator fee payer', async () => {
    facilitator();
    const r1 = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);
    expect(r1.status).toBe(402);
    const c1 = decode(r1.headers.get('PAYMENT-REQUIRED'));
    expect(c1.x402Version).toBe(2);
    expect(c1.resource.url).toBe('https://merchant.example.com/items/coffee');
    expect(c1.accepts[0]).toEqual({
      scheme: 'exact',
      network: DEVNET,
      amount: '10000',
      asset: BASE_ENV.USDC_MINT,
      payTo: BASE_ENV.MERCHANT_WALLET,
      maxTimeoutSeconds: 60,
      extra: { feePayer: FEE_PAYER },
    });

    const r2 = await handleRequest(new Request('https://merchant.example.com/items/report'), BASE_ENV);
    expect(decode(r2.headers.get('PAYMENT-REQUIRED')).accepts[0].amount).toBe('2500000');
  });

  it('verifies then settles against its own requirements and returns 200 with PAYMENT-RESPONSE', async () => {
    const calls = facilitator();
    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', { headers: { 'PAYMENT-SIGNATURE': paymentHeader } }),
      BASE_ENV,
    );

    expect(res.status).toBe(200);
    expect(decode(res.headers.get('PAYMENT-RESPONSE'))).toEqual({
      success: true,
      transaction: '5xSettledSig111',
      network: DEVNET,
      payer: 'AgentWallet111',
    });
    // The client sent an empty `accepted`; the merchant still sends its own requirements.
    expect(calls.verify.x402Version).toBe(2);
    expect(calls.verify.paymentRequirements.amount).toBe('10000');
    expect(calls.settle.paymentRequirements.payTo).toBe(BASE_ENV.MERCHANT_WALLET);
    expect(calls.settle.paymentPayload.payload.transaction).toBe('BASE64_TX');
    const data = (await res.json()) as { ok: boolean; item: string };
    expect(data.ok).toBe(true);
    expect(data.item).toBe('coffee');
  });

  it('times out verify but never aborts settle, which may already be landing on chain', async () => {
    facilitator();
    const fetchMock = vi.mocked(globalThis.fetch);
    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', { headers: { 'PAYMENT-SIGNATURE': paymentHeader } }),
      BASE_ENV,
    );
    expect(res.status).toBe(200);
    const initFor = (path: string) => fetchMock.mock.calls.find(([url]) => String(url).endsWith(`/${path}`))?.[1];
    expect(initFor('verify')?.signal).toBeInstanceOf(AbortSignal);
    expect(initFor('settle')?.signal).toBeUndefined();
  });

  it('returns 402 without settling when verification fails', async () => {
    const calls = facilitator({ verify: { isValid: false, invalidReason: 'invalid_exact_svm_payload_amount' } });
    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', { headers: { 'PAYMENT-SIGNATURE': paymentHeader } }),
      BASE_ENV,
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe('invalid_exact_svm_payload_amount');
    expect(calls.settle).toBeUndefined();
  });

  it('returns 402 with the facilitator answer when settlement fails', async () => {
    facilitator({ settle: { success: false, errorReason: 'insufficient_funds', errorMessage: 'User has 0, but requires 10000' } });
    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', { headers: { 'PAYMENT-SIGNATURE': paymentHeader } }),
      BASE_ENV,
    );
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
    const body = (await res.json()) as { error: string; settlement: { errorReason: string } };
    expect(body.error).toContain('10000');
    expect(body.settlement.errorReason).toBe('insufficient_funds');
  });

  it('renders HTML catalog and recent payments from merchant USDC ATA on GET /', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === 'getTokenAccountsByOwner') {
        return new Response(JSON.stringify({ result: { value: [{ pubkey: 'MerchantUsdcAta111' }] } }), { status: 200 });
      }
      if (rpc.method === 'getSignaturesForAddress') {
        return new Response(
          JSON.stringify({
            result: [
              {
                signature: '5xConfirmedTxSig1234567890abcdef',
                slot: 420001,
                blockTime: 1732612800,
                confirmationStatus: 'confirmed',
                err: null,
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error('unexpected rpc call');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleRequest(new Request('https://merchant.example.com/'), BASE_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Devnet Espresso');
    expect(html).toContain('Deep Research Report');
    expect(html).toContain('5xConfirmedTxSig1234567890abcdef');
  });

  it('says the payments could not be read instead of guessing when the RPC fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 403 })));
    const html = await (await handleRequest(new Request('https://merchant.example.com/'), BASE_ENV)).text();
    expect(html).toContain('Could not read transactions from Devnet.');
    expect(html).not.toContain('No payments yet.');
  });

  it('shows no payments when the merchant has no USDC account yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { value: [] } }), { status: 200 })));
    const html = await (await handleRequest(new Request('https://merchant.example.com/'), BASE_ENV)).text();
    expect(html).toContain('No payments yet.');
  });

  it('caches facilitator feePayer across requests to the same facilitator', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET, extra: { feePayer: FEE_PAYER } }] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);
    const second = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);

    expect(first.status).toBe(402);
    expect(second.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode(second.headers.get('PAYMENT-REQUIRED')).accepts[0].extra.feePayer).toBe(FEE_PAYER);
  });

  it('does not cache failed facilitator /supported lookups', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream error', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ kinds: [{ x402Version: 2, scheme: 'exact', network: DEVNET, extra: { feePayer: FEE_PAYER } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);
    const second = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);

    expect(first.status).toBe(502);
    expect(second.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
