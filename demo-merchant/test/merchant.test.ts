import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type Env } from '../src/index.js';

const BASE_ENV: Env = {
  THIRDWEB_SECRET_KEY: 'test-secret',
  MERCHANT_WALLET: '6VPd7LHbx96D2QiSsAo5JrEdRQUdW1PGk3bUNYhVECAz',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  TOKEN_PROGRAM: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};

function acceptsBody(amount: string, payTo = BASE_ENV.MERCHANT_WALLET) {
  return {
    x402Version: 1,
    error: 'Payment header is required',
    accepts: [
      {
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        maxAmountRequired: amount,
        resource: 'https://merchant.example.com/items/coffee',
        payTo,
        asset: BASE_ENV.USDC_MINT,
        extra: {
          facilitatorAddress: payTo,
          tokenDecimals: 6,
          tokenProgram: BASE_ENV.TOKEN_PROGRAM,
        },
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('demo-merchant x402 Worker', () => {
  it('returns 402 with thirdweb accepts challenge for items of different prices when X-PAYMENT is absent', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(acceptsBody(body.price.amount)), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r1 = await handleRequest(new Request('https://merchant.example.com/items/coffee'), BASE_ENV);
    expect(r1.status).toBe(402);
    const b1 = (await r1.json()) as { x402Version: number; accepts: Array<{ maxAmountRequired: string }> };
    expect(b1.x402Version).toBe(1);
    expect(b1.accepts[0]?.maxAmountRequired).toBe('10000');

    const r2 = await handleRequest(new Request('https://merchant.example.com/items/report'), BASE_ENV);
    expect(r2.status).toBe(402);
    const b2 = (await r2.json()) as { accepts: Array<{ maxAmountRequired: string }> };
    expect(b2.accepts[0]?.maxAmountRequired).toBe('2500000');
  });

  it('settles via thirdweb when X-PAYMENT is present and returns 200 with X-PAYMENT-RESPONSE', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/accepts')) {
        return new Response(JSON.stringify(acceptsBody('10000')), { status: 402 });
      }
      if (String(url).endsWith('/settle')) {
        return new Response(
          JSON.stringify({
            success: true,
            transaction: '5xSettledSig111',
            network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            payer: 'AgentWallet111',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const xPayment = btoa(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        payload: { transaction: 'BASE64_TX' },
      }),
    );

    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', {
        headers: { 'X-PAYMENT': xPayment },
      }),
      BASE_ENV,
    );

    expect(res.status).toBe(200);
    const responseHeader = res.headers.get('X-PAYMENT-RESPONSE');
    expect(responseHeader).toBeTruthy();
    const decoded = JSON.parse(atob(responseHeader!));
    expect(decoded).toEqual({
      success: true,
      transaction: '5xSettledSig111',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      payer: 'AgentWallet111',
    });

    const data = (await res.json()) as { ok: boolean; item: string };
    expect(data.ok).toBe(true);
    expect(data.item).toBe('coffee');
  });

  it('returns 402 when thirdweb /settle returns success: false', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/accepts')) {
        return new Response(JSON.stringify(acceptsBody('10000')), { status: 402 });
      }
      return new Response(
        JSON.stringify({
          success: false,
          errorReason: 'insufficient_funds',
          errorMessage: 'User has 0, but requires 10000',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const xPayment = btoa(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        payload: { transaction: 'BASE64_TX' },
      }),
    );

    const res = await handleRequest(
      new Request('https://merchant.example.com/items/coffee', {
        headers: { 'X-PAYMENT': xPayment },
      }),
      BASE_ENV,
    );

    expect(res.status).toBe(402);
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('10000');
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
    expect(html).toContain('MerchantUsdcAta111');
    expect(html).toContain('5xConfirmedTxSig1234567890abcdef');
  });
});
