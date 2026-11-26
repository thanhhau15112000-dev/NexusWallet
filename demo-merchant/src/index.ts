export interface Env {
  THIRDWEB_SECRET_KEY: string;
  MERCHANT_WALLET: string;
  USDC_MINT: string;
  /** Worker secret: public Devnet RPC blocks Cloudflare egress, so this points at a keyed provider. */
  SOLANA_RPC_URL?: string;
  TOKEN_PROGRAM?: string;
  UNTRUSTED_MERCHANT_WALLET?: string;
}

export type CatalogItem = {
  id: string;
  name: string;
  amountBaseUnits: string;
  humanPrice: string;
  useUntrustedWallet?: boolean;
  payload: Record<string, unknown>;
};

const THIRDWEB_BASE = 'https://api.thirdweb.com/v1/payments/x402';
const DEFAULT_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const X402_PAYMENT_HEADER = 'X-PAYMENT';
const X402_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export const CATALOG: CatalogItem[] = [
  {
    id: 'coffee',
    name: 'Devnet Espresso',
    amountBaseUnits: '10000',
    humanPrice: '0.01 USDC',
    payload: {
      item: 'coffee',
      brew: 'Devnet Espresso',
      quote: 'Spend policy verified before a single lamport moves.',
    },
  },
  {
    id: 'insights',
    name: 'Devnet Market Snapshot',
    amountBaseUnits: '100000',
    humanPrice: '0.10 USDC',
    payload: {
      item: 'insights',
      cluster: 'solana:devnet',
      summary: 'x402 v1 exact SPL settlement confirmed.',
    },
  },
  {
    id: 'report',
    name: 'Deep Research Report',
    amountBaseUnits: '2500000',
    humanPrice: '2.50 USDC',
    payload: {
      item: 'report',
      title: 'Solana Devnet Agentic Commerce Brief',
      sections: ['Policy Gate', 'Idempotent Signing', 'Facilitator Settlement'],
    },
  },
  {
    id: 'partner',
    name: 'Partner Feed (Unlisted Wallet)',
    amountBaseUnits: '10000',
    humanPrice: '0.01 USDC',
    useUntrustedWallet: true,
    payload: {
      item: 'partner',
      status: 'untrusted-merchant-test',
    },
  },
];

type AcceptsResponse = {
  x402Version?: number;
  error?: string;
  accepts?: Array<Record<string, unknown>>;
};

type SettleResponse = {
  success?: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
};

type RpcSignature = {
  signature: string;
  slot: number;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: unknown;
};

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Json(header: string): unknown {
  const binary = atob(header.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonResponse(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function payToForItem(item: CatalogItem, env: Env): string | null {
  if (item.useUntrustedWallet) {
    return env.UNTRUSTED_MERCHANT_WALLET?.trim() || null;
  }
  return env.MERCHANT_WALLET;
}

async function fetchThirdwebAccepts(
  env: Env,
  resourceUrl: string,
  item: CatalogItem,
  payTo: string,
): Promise<{ status: number; body: AcceptsResponse }> {
  const res = await fetch(`${THIRDWEB_BASE}/accepts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-secret-key': env.THIRDWEB_SECRET_KEY,
    },
    body: JSON.stringify({
      resourceUrl,
      method: 'GET',
      network: 'solana:devnet',
      price: {
        amount: item.amountBaseUnits,
        asset: {
          address: env.USDC_MINT,
          decimals: 6,
          tokenProgram: env.TOKEN_PROGRAM || DEFAULT_TOKEN_PROGRAM,
        },
      },
      serverWalletAddress: payTo,
    }),
  });
  const body = (await res.json()) as AcceptsResponse;
  return { status: res.status, body };
}

type ChainView = { payments: RpcSignature[]; rpcError: boolean };

async function rpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(env.SOLANA_RPC_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error || json.result === undefined) throw new Error(json.error?.message ?? `${method} failed`);
  return json.result;
}

async function fetchRecentPayments(env: Env): Promise<ChainView> {
  if (!env.SOLANA_RPC_URL) return { payments: [], rpcError: true };
  try {
    const accounts = await rpc<{ value: Array<{ pubkey: string }> }>(env, 'getTokenAccountsByOwner', [
      env.MERCHANT_WALLET,
      { mint: env.USDC_MINT },
      { encoding: 'jsonParsed' },
    ]);
    const ata = accounts.value[0]?.pubkey;
    // No USDC account means nothing has been paid to this merchant yet.
    if (!ata) return { payments: [], rpcError: false };
    const payments = await rpc<RpcSignature[]>(env, 'getSignaturesForAddress', [ata, { limit: 10 }]);
    return { payments, rpcError: false };
  } catch {
    return { payments: [], rpcError: true };
  }
}

function shortKey(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function renderHomePage(origin: string, env: Env, chain: ChainView): string {
  const itemRows = CATALOG.filter((item) => payToForItem(item, env) !== null)
    .map((item) => {
      const path = `/items/${item.id}`;
      return `<tr>
        <td>${escapeHtml(item.name)}</td>
        <td class="num">${escapeHtml(item.humanPrice)}</td>
        <td><a href="${escapeHtml(origin + path)}"><code>${escapeHtml(path)}</code></a></td>
      </tr>`;
    })
    .join('\n');

  const paymentRows = chain.payments.length
    ? chain.payments
        .map((sig) => {
          const explorer = `https://explorer.solana.com/tx/${encodeURIComponent(sig.signature)}?cluster=devnet`;
          const time = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19) : '-';
          return `<tr>
            <td><a href="${explorer}" target="_blank" rel="noreferrer" title="${escapeHtml(sig.signature)}">${escapeHtml(shortKey(sig.signature))}</a></td>
            <td class="num">${escapeHtml(time)}</td>
            <td>${sig.err ? 'failed' : 'confirmed'}</td>
          </tr>`;
        })
        .join('\n')
    : `<tr><td colspan="3" class="muted">${chain.rpcError ? 'Could not read payments from Devnet.' : 'No payments yet.'}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>nexusPay demo merchant</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; background: #f6f7f6; color: #111816; }
    body { max-width: 720px; margin: 32px auto; padding: 0 16px; line-height: 1.5; }
    .card { background: #fff; border: 1px solid #e3e7e5; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 0 0 8px; }
    .muted { color: #5a6561; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e3e7e5; }
    th { font-size: 12px; color: #5a6561; font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    a { color: #177b65; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>nexusPay demo merchant</h1>
    <div class="muted">x402 · Solana Devnet · USDC · wallet <span title="${escapeHtml(env.MERCHANT_WALLET)}">${escapeHtml(shortKey(env.MERCHANT_WALLET))}</span></div>
  </div>
  <div class="card">
    <h2>Items</h2>
    <table>
      <thead><tr><th>Item</th><th>Price</th><th>Endpoint</th></tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Recent payments</h2>
    <table>
      <thead><tr><th>Transaction</th><th>Time (UTC)</th><th>Status</th></tr></thead>
      <tbody>${paymentRows}</tbody>
    </table>
  </div>
</body>
</html>`;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    const chain = await fetchRecentPayments(env);
    return new Response(renderHomePage(url.origin, env, chain), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse({ ok: true, network: 'solana:devnet', merchantWallet: env.MERCHANT_WALLET }, 200);
  }

  const itemMatch = url.pathname.match(/^\/items\/([a-z0-9_-]+)$/i);
  if (request.method === 'GET' && itemMatch) {
    const itemId = itemMatch[1]!;
    const item = CATALOG.find((entry) => entry.id === itemId);
    const payTo = item ? payToForItem(item, env) : null;
    if (!item || !payTo) {
      return jsonResponse({ error: 'Item not found' }, 404);
    }

    if (!env.THIRDWEB_SECRET_KEY) {
      return jsonResponse({ error: 'THIRDWEB_SECRET_KEY is not configured' }, 500);
    }

    const accepts = await fetchThirdwebAccepts(env, url.toString(), item, payTo);
    const paymentRequirements = accepts.body.accepts?.[0];
    if (!paymentRequirements) {
      return jsonResponse({ error: 'Facilitator did not return payment requirements', detail: accepts.body }, 502);
    }

    const xPaymentHeader = request.headers.get(X402_PAYMENT_HEADER);
    if (!xPaymentHeader) {
      return jsonResponse(accepts.body, 402);
    }

    let paymentPayload: unknown;
    try {
      paymentPayload = decodeBase64Json(xPaymentHeader);
      if (!paymentPayload || typeof paymentPayload !== 'object' || Array.isArray(paymentPayload)) {
        throw new Error('payload must be a JSON object');
      }
    } catch {
      return jsonResponse({ ...accepts.body, error: 'Invalid X-PAYMENT header' }, 402);
    }

    const settleRes = await fetch(`${THIRDWEB_BASE}/settle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-secret-key': env.THIRDWEB_SECRET_KEY,
      },
      body: JSON.stringify({
        paymentPayload,
        paymentRequirements,
        waitUntil: 'confirmed',
      }),
    });

    const settleJson = (await settleRes.json().catch(() => null)) as SettleResponse | null;
    if (!settleRes.ok || !settleJson?.success) {
      return jsonResponse(
        {
          ...accepts.body,
          error: settleJson?.errorMessage || settleJson?.errorReason || 'Payment settlement failed',
        },
        402,
      );
    }

    const settlement = {
      success: true,
      transaction: settleJson.transaction ?? '',
      network: settleJson.network ?? String(paymentRequirements.network ?? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
      payer: settleJson.payer ?? '',
    };
    const encodedSettlement = encodeBase64Json(settlement);

    return jsonResponse(
      {
        ok: true,
        item: item.id,
        name: item.name,
        paid: item.humanPrice,
        data: item.payload,
        settlement,
      },
      200,
      { [X402_PAYMENT_RESPONSE_HEADER]: encodedSettlement },
    );
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
