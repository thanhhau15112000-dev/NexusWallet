export interface Env {
  MERCHANT_WALLET: string;
  USDC_MINT: string;
  /** Worker secret: public Devnet RPC blocks Cloudflare egress, so this points at a keyed provider. */
  SOLANA_RPC_URL?: string;
  UNTRUSTED_MERCHANT_WALLET?: string;
  /** x402 v2 facilitator; defaults to the free x402.org one, which sponsors the network fee. */
  FACILITATOR_URL?: string;
}

export type CatalogItem = {
  id: string;
  name: string;
  amountBaseUnits: string;
  humanPrice: string;
  useUntrustedWallet?: boolean;
  payload: Record<string, unknown>;
};

const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';
const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

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
      summary: 'x402 v2 exact SPL settlement confirmed.',
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

type PaymentRequirements = {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string };
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

function facilitatorUrl(env: Env): string {
  return (env.FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL).replace(/\/+$/, '');
}

/** The facilitator's fee payer for Solana devnet, read from its `/supported` list. */
async function fetchFeePayer(env: Env): Promise<string | null> {
  const res = await fetch(`${facilitatorUrl(env)}/supported`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    kinds?: Array<{ x402Version?: number; scheme?: string; network?: string; extra?: { feePayer?: string } }>;
  } | null;
  const kind = body?.kinds?.find((k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === SOLANA_DEVNET);
  return kind?.extra?.feePayer ?? null;
}

function paymentRequirements(env: Env, item: CatalogItem, payTo: string, feePayer: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: SOLANA_DEVNET,
    amount: item.amountBaseUnits,
    asset: env.USDC_MINT,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer },
  };
}

/** 402 with the challenge in the PAYMENT-REQUIRED header, mirrored in the body for readers. */
function paymentRequired(resourceUrl: string, item: CatalogItem, requirements: PaymentRequirements, error: string, detail?: unknown): Response {
  const challenge = {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: item.name, mimeType: 'application/json' },
    accepts: [requirements],
  };
  return jsonResponse(detail === undefined ? challenge : { ...challenge, settlement: detail }, 402, {
    [PAYMENT_REQUIRED_HEADER]: encodeBase64Json(challenge),
  });
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
            <td${sig.err ? ' class="failed"' : ''}>${sig.err ? 'failed' : 'confirmed'}</td>
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
    :root {
      color-scheme: dark;
      --bg: #121417; --panel: #191c20; --surface-muted: #20242a; --line: #2a2f36;
      --ink: #e6e9ec; --muted: #9aa2ab; --ok: #4fbf9c; --bad: #d8685b;
      font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink);
    }
    body { max-width: 1040px; margin: 32px auto; padding: 0 16px; line-height: 1.5; background: var(--bg); }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; min-width: 0; }
    .columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .columns .card { margin-bottom: 0; }
    @media (max-width: 760px) { .columns { grid-template-columns: minmax(0, 1fr); } }
    .wallet { display: inline-flex; align-items: center; gap: 6px; }
    button.copy { display: inline-flex; padding: 3px; border: 0; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
    button.copy:hover { background: var(--surface-muted); color: var(--ink); }
    button.copy svg { width: 14px; height: 14px; }
    button.copy .done, button.copy.copied .idle { display: none; }
    button.copy.copied .done { display: inline; color: var(--ok); }
    h1 { font-size: 20px; margin: 0 0 4px; }
    h2 { font-size: 15px; margin: 0 0 8px; }
    .muted { color: var(--muted); font-size: 13px; }
    .failed { color: var(--bad); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); }
    th { font-size: 12px; color: var(--muted); font-weight: 600; }
    tr:last-child td { border-bottom: 0; }
    .num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    a { color: var(--ok); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>nexusPay demo merchant</h1>
    <div class="muted">x402 · Solana Devnet · USDC · wallet <span class="wallet"><span title="${escapeHtml(env.MERCHANT_WALLET)}">${escapeHtml(shortKey(env.MERCHANT_WALLET))}</span><button type="button" class="copy" data-copy="${escapeHtml(env.MERCHANT_WALLET)}" aria-label="Copy wallet address" title="Copy wallet address"><svg class="idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><svg class="done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></button></span></div>
  </div>
  <div class="columns">
    <div class="card">
      <h2>Paid endpoints</h2>
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
  </div>
  <script>
    document.querySelectorAll('button.copy').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          button.classList.add('copied');
          button.title = 'Copied';
        } catch {
          button.title = 'Clipboard is not available; copy the address from the tooltip';
          return;
        }
        setTimeout(() => { button.classList.remove('copied'); button.title = 'Copy wallet address'; }, 1500);
      });
    });
  </script>
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

    const feePayer = await fetchFeePayer(env);
    if (!feePayer) {
      return jsonResponse({ error: 'Facilitator does not list Solana devnet' }, 502);
    }
    const resourceUrl = url.toString();
    const requirements = paymentRequirements(env, item, payTo, feePayer);

    const paymentHeader = request.headers.get(PAYMENT_SIGNATURE_HEADER);
    if (!paymentHeader) {
      return paymentRequired(resourceUrl, item, requirements, 'PAYMENT-SIGNATURE header is required');
    }

    let paymentPayload: unknown;
    try {
      paymentPayload = decodeBase64Json(paymentHeader);
      if (!paymentPayload || typeof paymentPayload !== 'object' || Array.isArray(paymentPayload)) {
        throw new Error('payload must be a JSON object');
      }
    } catch {
      return paymentRequired(resourceUrl, item, requirements, 'Invalid PAYMENT-SIGNATURE header');
    }

    // The server's own requirements, never the client's copy, decide what counts as paid.
    const facilitatorBody = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements });
    const post = (path: string) =>
      fetch(`${facilitatorUrl(env)}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: facilitatorBody });

    const verifyRes = await post('verify');
    const verifyJson = (await verifyRes.json().catch(() => null)) as { isValid?: boolean; invalidReason?: string } | null;
    if (!verifyRes.ok || !verifyJson?.isValid) {
      return paymentRequired(resourceUrl, item, requirements, verifyJson?.invalidReason || 'Payment verification failed', {
        httpStatus: verifyRes.status,
        ...verifyJson,
      });
    }

    const settleRes = await post('settle');
    const settleJson = (await settleRes.json().catch(() => null)) as SettleResponse | null;
    if (!settleRes.ok || !settleJson?.success) {
      // The facilitator's own answer, so a failed settlement can be diagnosed from the client.
      return paymentRequired(
        resourceUrl,
        item,
        requirements,
        settleJson?.errorMessage || settleJson?.errorReason || 'Payment settlement failed',
        { httpStatus: settleRes.status, ...settleJson },
      );
    }

    const settlement = {
      success: true,
      transaction: settleJson.transaction ?? '',
      network: settleJson.network ?? SOLANA_DEVNET,
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
      { [PAYMENT_RESPONSE_HEADER]: encodedSettlement },
    );
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
