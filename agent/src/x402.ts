/**
 * x402 v2 client, scheme `exact` on Solana devnet.
 *
 * A 402 challenge becomes an SPL `transfer_spl` action and goes through the same policy gate as
 * any transfer (allowlist, per-transaction cap, owner approval). Only an authorised request is
 * signed, and only by the agent: the facilitator named in the challenge is the fee payer and adds
 * its signature when the resource server settles. A signed transaction can land as long as its
 * blockhash is valid, so a retry reuses it and a new one is signed only once the old one can no
 * longer land.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  X402_PAYMENT_HEADER,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER,
  baseUnitsToHuman,
  decodeX402PaymentResponse,
  encodeX402PaymentHeader,
  parseX402Challenge,
  selectX402Requirements,
  AGENT_ERROR_REMEDIATION,
  type PaymentRequest,
  type X402PaymentRequired,
  type X402Requirements,
} from '@nexus/shared';
import { explorerTxUrl, getMintDecimals, getX402TransactionState, signX402Transfer } from './chain.js';
import type { AppContext } from './context.js';
import { IdempotencyConflictError, blockIfNotExecutable, executionBlocker, runAction } from './pipeline.js';

type X402Error = {
  code: string;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type X402ResolutionResult =
  | {
      status: 'completed';
      idempotencyKey: string;
      /** The agent's signature on the payment; the transaction id is known only once it settles. */
      payerSignature: string;
      /** Value for the `PAYMENT-SIGNATURE` header on the retried request. */
      paymentHeader: string;
      request: PaymentRequest;
    }
  | ({
      status: 'pending_approval';
      code: 'X402_APPROVAL_REQUIRED';
      idempotencyKey: string;
      approvalUrl: string;
      requestId: string;
      request: PaymentRequest;
    } & X402Error)
  | ({ status: 'denied'; idempotencyKey?: string; request?: PaymentRequest } & X402Error);

function denied(error: X402Error, extra: { idempotencyKey?: string; request?: PaymentRequest } = {}): X402ResolutionResult {
  return { status: 'denied', ...error, ...extra };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function markConfirmed(ctx: AppContext, request: PaymentRequest, signature: string): PaymentRequest {
  if (request.status === 'confirmed') return request;
  const now = new Date().toISOString();
  ctx.audit.record('tx.confirmed', request.id, { signature, via: 'x402' });
  const confirmed = ctx.store.putRequest({
    ...request,
    status: 'confirmed',
    execution: {
      signature,
      explorerUrl: explorerTxUrl(signature, ctx.config.SOLANA_CLUSTER),
      submittedAt: request.execution?.submittedAt ?? now,
      confirmedAt: now,
      slot: null,
    },
  });
  void ctx.telegram?.notifyTransactionConfirmed(ctx, confirmed);
  return confirmed;
}

const inFlightX402Signs = new WeakMap<
  AppContext,
  Map<string, Promise<{ request: PaymentRequest } | { error: X402Error; request: PaymentRequest }>>
>();

/**
 * Sign the authorised payment, or hand back the one already signed while it can still land.
 * Serialised per request id so concurrent retries with the same key cannot sign twice.
 * Returns the request with `x402.transaction` set, or an error.
 */
function signAuthorised(
  ctx: AppContext,
  request: PaymentRequest,
  requirements: X402Requirements,
): Promise<{ request: PaymentRequest } | { error: X402Error; request: PaymentRequest }> {
  let pending = inFlightX402Signs.get(ctx);
  if (!pending) {
    pending = new Map();
    inFlightX402Signs.set(ctx, pending);
  }
  const current = pending.get(request.id);
  if (current) return current;

  const promise = signAuthorisedOnce(ctx, request, requirements).finally(() => {
    pending?.delete(request.id);
  });
  pending.set(request.id, promise);
  return promise;
}

async function signAuthorisedOnce(
  ctx: AppContext,
  initialRequest: PaymentRequest,
  requirements: X402Requirements,
): Promise<{ request: PaymentRequest } | { error: X402Error; request: PaymentRequest }> {
  const request = ctx.store.getRequest(initialRequest.id) ?? initialRequest;
  if (request.status === 'confirmed' && request.x402?.transaction) {
    return { request };
  }
  if (request.status !== 'auto_approved' && request.status !== 'approved') {
    return { request, error: request.error ?? { code: 'POLICY_DENIED', message: `payment is ${request.status}` } };
  }
  const x402 = request.x402!;
  const resolved = request.decision?.resolved;
  if (resolved?.type !== 'transfer_spl') {
    return { request, error: { code: 'NO_EXECUTABLE_ACTION', message: 'x402 request has no SPL transfer' } };
  }

  if (x402.transaction && x402.payerSignature && x402.lastValidBlockHeight !== null) {
    const found = await getX402TransactionState(ctx.connection, {
      payer: ctx.agentPubkey,
      payerSignature: x402.payerSignature,
      lastValidBlockHeight: x402.lastValidBlockHeight,
    });
    if (found.state === 'landed') return { request: markConfirmed(ctx, request, found.txId) };
    if (found.state === 'failed') {
      const failed = ctx.store.putRequest({
        ...request,
        status: 'failed',
        error: { code: 'X402_TRANSACTION_FAILED', message: `payment transaction ${found.txId} failed on chain` },
      });
      ctx.audit.record('tx.failed', request.id, { signature: found.txId, via: 'x402' });
      void ctx.telegram?.notifyTransactionFailed(ctx, failed);
      return { request: failed, error: failed.error! };
    }
    if (found.state === 'pending') {
      const blocker = executionBlocker(ctx, request);
      if (blocker) return { request, error: blocker };
      return { request };
    }
    // expired: it can no longer land, so fall through to guard and sign a replacement.
  }

  const blocked = blockIfNotExecutable(ctx, request);
  if (blocked) {
    return { request: blocked, error: blocked.error ?? { code: 'POLICY_DENIED', message: 'payment was blocked' } };
  }

  try {
    const signed = await signX402Transfer({
      connection: ctx.connection,
      payer: ctx.signer,
      recipient: resolved.recipient,
      mint: resolved.mint,
      baseUnits: BigInt(requirements.amount),
      feePayer: requirements.extra.feePayer,
      memo: requirements.extra.memo,
    });
    ctx.audit.record('x402.signed', request.id, {
      payerSignature: signed.payerSignature,
      feePayer: requirements.extra.feePayer,
      resource: x402.resource,
      lastValidBlockHeight: signed.lastValidBlockHeight,
    });
    return { request: ctx.store.putRequest({ ...request, x402: { ...x402, ...signed, accepted: requirements } }) };
  } catch (err) {
    ctx.audit.record('x402.sign_failed', request.id, { error: errorText(err) });
    return {
      request,
      error: {
        code: 'X402_SIGNING_FAILED',
        message: errorText(err),
        remediation:
          'Nothing was signed. Fix the cause (fund the agent token account, or ask the payee to open a token account), then retry with the same idempotencyKey.',
      },
    };
  }
}

/**
 * Turn a 402 challenge into a signed payment for the resource. `idempotencyKey` identifies one
 * purchase: reuse it to resume after owner approval or to retry; omit it to buy again.
 */
export async function resolveX402Payment(
  ctx: AppContext,
  challengeInput: unknown,
  resourceUrl?: string,
  idempotencyKeyInput?: string,
): Promise<X402ResolutionResult> {
  let challenge: X402PaymentRequired;
  try {
    challenge = parseX402Challenge(challengeInput);
  } catch (err) {
    return denied({
      code: 'INVALID_X402_CHALLENGE',
      message: `failed to parse x402 challenge: ${errorText(err)}`,
      remediation: 'The resource server must answer with an x402 v2 PaymentRequired object in the PAYMENT-REQUIRED header or the body.',
    });
  }

  const requirements = selectX402Requirements(challenge);
  if (!requirements) {
    return denied({
      code: 'UNSUPPORTED_NETWORK',
      message: 'the challenge has no x402 v2 `exact` option on Solana devnet with an SPL asset and a fee payer',
      remediation: 'The resource server must accept an SPL token on Solana devnet.',
      details: { cluster: ctx.config.SOLANA_CLUSTER },
    });
  }
  // Policy caps are in human units, so decimals come from the mint on chain, never the challenge.
  // A mint outside the allowlist is denied by the policy before any lookup matters.
  const policy = ctx.store.getPolicy();
  let decimals = 0;
  if (policy.allowedMints.some((entry) => entry.address === requirements.asset)) {
    try {
      decimals = await getMintDecimals(ctx.connection, requirements.asset);
    } catch (err) {
      return denied({ code: 'INVALID_X402_OPTION', message: `cannot read mint ${requirements.asset}: ${errorText(err)}` });
    }
  }
  let amount: number;
  try {
    amount = baseUnitsToHuman(requirements.amount, decimals);
  } catch (err) {
    return denied({ code: 'INVALID_X402_OPTION', message: errorText(err) });
  }

  const idempotencyKey = idempotencyKeyInput?.trim() || `x402:${randomUUID()}`;
  let request: PaymentRequest;
  try {
    request = await runAction(ctx, {
      action: { type: 'transfer_spl', recipient: requirements.payTo, mint: requirements.asset, amount },
      idempotencyKey,
      x402: { resource: challenge.resource.url || resourceUrl || '', network: requirements.network },
    });
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return denied({
        code: 'IDEMPOTENCY_CONFLICT',
        message: err.message,
        remediation: AGENT_ERROR_REMEDIATION.IDEMPOTENCY_CONFLICT,
      }, { idempotencyKey });
    }
    throw err;
  }

  if (request.status === 'pending_approval') {
    const dashboardUrl = ctx.config.allowedOrigins?.[0] ?? ctx.config.WEB_ORIGIN;
    return {
      status: 'pending_approval',
      code: 'X402_APPROVAL_REQUIRED',
      message: 'the x402 payment exceeds the policy limit and waits for the owner in the nexusPay dashboard',
      remediation: `${AGENT_ERROR_REMEDIATION.PENDING_APPROVAL_REQUIRED} Once approved, call again with idempotencyKey ${idempotencyKey}.`,
      approvalUrl: `${dashboardUrl}/#requests`,
      requestId: request.id,
      idempotencyKey,
      request,
    };
  }

  if (request.status === 'confirmed' && request.x402?.transaction) {
    // Already settled under this key; hand back the same payment so the server can recognise it.
    return {
      status: 'completed',
      idempotencyKey,
      payerSignature: request.x402.payerSignature!,
      paymentHeader: paymentHeaderFor(request),
      request,
    };
  }

  if (request.status !== 'auto_approved' && request.status !== 'approved') {
    return denied(
      request.error ?? { code: 'POLICY_DENIED', message: `payment is ${request.status}` },
      { idempotencyKey, request },
    );
  }

  const signed = await signAuthorised(ctx, request, requirements);
  if ('error' in signed) return denied(signed.error, { idempotencyKey, request: signed.request });
  return {
    status: 'completed',
    idempotencyKey,
    payerSignature: signed.request.x402!.payerSignature!,
    paymentHeader: paymentHeaderFor(signed.request),
    request: signed.request,
  };
}

/** The payment as the resource server receives it: the same transaction with the requirements it answers. */
function paymentHeaderFor(request: PaymentRequest): string {
  const x402 = request.x402!;
  return encodeX402PaymentHeader({
    x402Version: 2,
    resource: { url: x402.resource },
    accepted: x402.accepted as X402Requirements,
    payload: { transaction: x402.transaction! },
  });
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateOrLocalHostname(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('::ffff:')) {
      const mapped = host.slice('::ffff:'.length);
      if (isIP(mapped) === 4) return isPrivateIpv4(mapped);
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0]!, 16);
        const lo = Number.parseInt(hexParts[1]!, 16);
        if (Number.isInteger(hi) && Number.isInteger(lo)) {
          return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
        }
      }
      return true;
    }
    const firstHextet = Number.parseInt(host.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
  }
  return false;
}

export function assertSafeExternalHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid target URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error(`Refusing request to local or private host: ${parsed.hostname}`);
  }
  return parsed;
}


export type X402FetchResult = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  payment?: {
    status: 'not_required' | 'paid' | 'submitted' | 'not_settled' | 'pending_approval' | 'denied';
    idempotencyKey?: string;
    requestId?: string;
    signature?: string;
    explorerUrl?: string;
    /** Decoded `PAYMENT-RESPONSE` from the resource server. */
    settlement?: Record<string, unknown> | null;
  };
  error?: X402Error;
};

async function readResponse(res: Response): Promise<{ headers: Record<string, string>; data: unknown }> {
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON; keep the text
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { headers, data };
}

/**
 * Fetch a resource; on 402, pay through `resolveX402Payment` and retry once with `PAYMENT-SIGNATURE`.
 * The payment counts as settled only when its transaction is confirmed on chain.
 */
export async function fetchWithX402(
  ctx: AppContext,
  url: string,
  init?: RequestInit,
  idempotencyKey?: string,
): Promise<X402FetchResult> {
  try {
    assertSafeExternalHttpUrl(url);
  } catch (err) {
    return {
      status: 400,
      headers: {},
      data: null,
      error: { code: 'INVALID_TARGET_URL', message: errorText(err), remediation: 'Provide a public HTTP or HTTPS URL.' },
    };
  }

  const fetchInit: RequestInit = { ...init, redirect: 'manual' };
  const first = await fetch(url, fetchInit);
  if (first.status !== 402) {
    return { status: first.status, ...(await readResponse(first)), payment: { status: 'not_required' } };
  }

  // v2 carries the challenge in the PAYMENT-REQUIRED header; a JSON body is accepted as a fallback.
  let challenge: unknown = first.headers.get(X402_PAYMENT_REQUIRED_HEADER);
  if (!challenge) {
    try {
      challenge = await first.json();
    } catch {
      challenge = null;
    }
  }
  if (!challenge) {
    return {
      status: 402,
      headers: {},
      data: null,
      error: { code: 'MISSING_X402_CHALLENGE', message: 'the endpoint returned 402 without an x402 PAYMENT-REQUIRED header or body' },
    };
  }

  const resolution = await resolveX402Payment(ctx, challenge, url, idempotencyKey);
  if (resolution.status !== 'completed') {
    const { status, idempotencyKey: key, request, code, message, remediation, details } = resolution;
    return {
      status: 402,
      headers: {},
      data: null,
      payment: { status, idempotencyKey: key, requestId: request?.id },
      error: { code, message, remediation, details },
    };
  }

  // A key whose payment is already on chain has nothing left to settle: resending the same
  // transaction can only be rejected by the facilitator. The resource was due on the call that paid.
  if (resolution.request.status === 'confirmed') {
    const txId = resolution.request.execution?.signature;
    return {
      status: first.status,
      headers: {},
      data: null,
      payment: {
        status: 'paid',
        idempotencyKey: resolution.idempotencyKey,
        requestId: resolution.request.id,
        signature: txId,
        explorerUrl: txId ? explorerTxUrl(txId, ctx.config.SOLANA_CLUSTER) : undefined,
      },
      error: {
        code: 'X402_ALREADY_PAID',
        message: `idempotencyKey ${resolution.idempotencyKey} already paid for this resource; nothing was signed or sent`,
        remediation: 'To buy the resource again, call without idempotencyKey or with a new one.',
      },
    };
  }

  const headers = new Headers(init?.headers);
  headers.set(X402_PAYMENT_HEADER, resolution.paymentHeader);
  const final = await fetch(url, { ...fetchInit, headers });
  const body = await readResponse(final);
  const settlement = decodeX402PaymentResponse(final.headers.get(X402_PAYMENT_RESPONSE_HEADER));
  const { payerSignature, idempotencyKey: key } = resolution;
  let request = resolution.request;
  const reportedTxId = typeof settlement?.transaction === 'string' && settlement.transaction ? settlement.transaction : null;
  const payment = { idempotencyKey: key, requestId: request.id, settlement };

  if (!final.ok) {
    ctx.audit.record('x402.not_settled', request.id, { httpStatus: final.status, payerSignature });
    return {
      status: final.status,
      ...body,
      payment: { ...payment, status: 'not_settled' },
      error: {
        code: 'X402_SETTLEMENT_FAILED',
        message: `the resource server answered ${final.status} to the signed payment`,
        remediation: `Retry with idempotencyKey ${key}: the same signed payment is reused while it can still land, so a retry cannot pay twice.`,
      },
    };
  }

  // The server's word is not proof: the payment counts as paid only once a transaction holding
  // the agent's signature is confirmed on chain.
  const lastValidBlockHeight = request.x402?.lastValidBlockHeight;
  const found =
    lastValidBlockHeight !== null && lastValidBlockHeight !== undefined
      ? await getX402TransactionState(ctx.connection, {
          payer: ctx.agentPubkey,
          payerSignature,
          lastValidBlockHeight,
          txId: reportedTxId,
        }).catch(() => ({ state: 'pending' as const }))
      : { state: 'pending' as const };
  if (found.state === 'landed') {
    request = markConfirmed(ctx, request, found.txId);
    return {
      status: final.status,
      ...body,
      payment: {
        ...payment,
        requestId: request.id,
        status: 'paid',
        signature: found.txId,
        explorerUrl: explorerTxUrl(found.txId, ctx.config.SOLANA_CLUSTER),
      },
    };
  }
  return { status: final.status, ...body, payment: { ...payment, status: 'submitted' } };
}
