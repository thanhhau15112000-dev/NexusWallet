export interface Env {
  THIRDWEB_SECRET_KEY: string;
  MERCHANT_WALLET: string;
  USDC_MINT: string;
  SOLANA_RPC_URL: string;
  TOKEN_PROGRAM?: string;
  UNTRUSTED_MERCHANT_WALLET?: string;
}

export type CatalogItem = {
  id: string;
  name: string;
  description: string;
  amountBaseUnits: string;
  humanPrice: string;
  policyNote: string;
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
    description: 'Micro-payment item within typical auto-approval cap.',
    amountBaseUnits: '10000',
    humanPrice: '0.01 USDC',
    policyNote: 'auto-approve (<= cap)',
    payload: {
      item: 'coffee',
      brew: 'Devnet Espresso',
      quote: 'Spend policy verified before a single lamport moves.',
    },
  },
  {
    id: 'insights',
    name: 'Devnet Market Snapshot',
    description: 'Mid-tier API response within a 1 USDC per-tx limit.',
    amountBaseUnits: '100000',
    humanPrice: '0.10 USDC',
    policyNote: 'auto-approve (<= 1 USDC cap)',
    payload: {
      item: 'insights',
      cluster: 'solana:devnet',
      summary: 'x402 v1 exact SPL settlement confirmed.',
    },
  },
  {
    id: 'report',
    name: 'Deep Research Report',
    description: 'Higher-value item designed to trigger owner approval.',
    amountBaseUnits: '2500000',
    humanPrice: '2.50 USDC',
    policyNote: 'owner approval (> 1 USDC cap)',
    payload: {
      item: 'report',
      title: 'Solana Devnet Agentic Commerce Brief',
      sections: ['Policy Gate', 'Idempotent Signing', 'Facilitator Settlement'],
    },
  },
  {
    id: 'partner',
    name: 'Partner Feed (Unlisted Wallet)',
    description: 'Uses UNTRUSTED_MERCHANT_WALLET when configured to demonstrate allowlist denial.',
    amountBaseUnits: '10000',
    humanPrice: '0.01 USDC',
    policyNote: 'policy deny (recipient not allowlisted)',
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

async function fetchRecentPayments(
  env: Env,
): Promise<{ ata: string | null; payments: RpcSignature[]; rpcError: string | null }> {
  if (!env.SOLANA_RPC_URL || !env.MERCHANT_WALLET || !env.USDC_MINT) {
    return { ata: null, payments: [], rpcError: 'RPC or wallet configuration missing' };
  }
  try {
    const tokenRes = await fetch(env.SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [env.MERCHANT_WALLET, { mint: env.USDC_MINT }, { encoding: 'jsonParsed' }],
      }),
    });
    const tokenJson = (await tokenRes.json()) as {
      result?: { value?: Array<{ pubkey: string }> };
      error?: { message?: string };
    };
    if (tokenJson.error) {
      return { ata: null, payments: [], rpcError: tokenJson.error.message ?? 'RPC error' };
    }
    const ata = tokenJson.result?.value?.[0]?.pubkey ?? null;
    if (!ata) {
      return { ata: null, payments: [], rpcError: null };
    }

    const sigRes = await fetch(env.SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'getSignaturesForAddress',
        params: [ata, { limit: 15 }],
      }),
    });
    const sigJson = (await sigRes.json()) as {
      result?: RpcSignature[];
      error?: { message?: string };
    };
    if (sigJson.error) {
      return { ata, payments: [], rpcError: sigJson.error.message ?? 'RPC error' };
    }
    return { ata, payments: sigJson.result ?? [], rpcError: null };
  } catch (err) {
    return { ata: null, payments: [], rpcError: err instanceof Error ? err.message : String(err) };
  }
}

function renderHomePage(
  origin: string,
  env: Env,
  chain: { ata: string | null; payments: RpcSignature[]; rpcError: string | null },
): string {
  const visibleItems = CATALOG.filter((item) => payToForItem(item, env) !== null);
  const itemRows = visibleItems
    .map((item) => {
      const itemUrl = `${origin}/items/${item.id}`;
      return `<tr>
        <td><strong>${escapeHtml(item.name)}</strong><br /><span class="muted">${escapeHtml(item.description)}</span></td>
        <td class="num">${escapeHtml(item.humanPrice)}<br /><span class="muted">${escapeHtml(item.amountBaseUnits)} base units</span></td>
        <td><code>${escapeHtml(itemUrl)}</code></td>
        <td>${escapeHtml(item.policyNote)}</td>
      </tr>`;
    })
    .join('\n');

  const paymentRows = chain.payments.length
    ? chain.payments
        .map((sig) => {
          const shortSig = `${sig.signature.slice(0, 10)}…${sig.signature.slice(-8)}`;
          const explorer = `https://explorer.solana.com/tx/${encodeURIComponent(sig.signature)}?cluster=devnet`;
          const time = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : '-';
          const status = sig.err ? 'failed' : sig.confirmationStatus ?? 'confirmed';
          return `<tr>
            <td><a href="${explorer}" target="_blank" rel="noreferrer"><code>${escapeHtml(shortSig)}</code></a></td>
            <td class="num">${sig.slot}</td>
            <td>${escapeHtml(status)}</td>
            <td>${escapeHtml(time)}</td>
          </tr>`;
        })
        .join('\n')
    : `<tr><td colspan="4" class="muted">${
        chain.rpcError
          ? `RPC error: ${escapeHtml(chain.rpcError)}`
          : chain.ata
            ? 'No settled payments found on merchant USDC ATA yet.'
            : 'Merchant USDC token account (ATA) does not exist yet on Devnet.'
      }</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>nexusPay Demo Merchant (x402 v1 / Solana Devnet)</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; background: #f6f7f6; color: #111816; }
    body { max-width: 920px; margin: 32px auto; padding: 0 16px; line-height: 1.5; }
    .card { background: #fff; border: 1px solid #e3e7e5; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .muted { color: #5a6561; font-size: 13px; }
    .meta { display: grid; gap: 6px; font-size: 13px; margin-top: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e3e7e5; vertical-align: top; }
    th { font-size: 12px; color: #5a6561; font-weight: 600; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; background: #eef1ef; padding: 2px 5px; border-radius: 4px; }
    a { color: #177b65; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>nexusPay x402 Demo Merchant</h1>
    <p class="muted">HTTP 402 resource server on Cloudflare Workers using thirdweb facilitator (x402 v1, scheme <code>exact</code>, Solana Devnet SPL).</p>
    <div class="meta">
      <div><strong>Merchant wallet:</strong> <code>${escapeHtml(env.MERCHANT_WALLET)}</code></div>
      <div><strong>USDC mint:</strong> <code>${escapeHtml(env.USDC_MINT)}</code></div>
      <div><strong>Merchant USDC ATA:</strong> <code>${escapeHtml(chain.ata ?? 'not created yet')}</code></div>
    </div>
  </div>

  <div class="card">
    <h2>Catalog (GET /items/:id)</h2>
    <table>
      <thead>
        <tr><th>Item</th><th>Price</th><th>Endpoint</th><th>Policy demo case</th></tr>
      </thead>
      <tbody>
        ${itemRows}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Recent Devnet Payments (on-chain ATA signatures)</h2>
    <table>
      <thead>
        <tr><th>Signature</th><th>Slot</th><th>Status</th><th>Timestamp (UTC)</th></tr>
      </thead>
      <tbody>
        ${paymentRows}
      </tbody>
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
