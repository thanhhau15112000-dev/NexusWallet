import {
  AGENT_ERROR_REMEDIATION,
  findSupportedX402Option,
  formatX402SignatureHeader,
  parseX402Challenge,
  x402OptionToAction,
  type PaymentRequest,
  type X402PaymentRequired,
  type X402PaymentSignature,
} from '@nexus/shared';
import type { AppContext } from './context.js';
import { runAction } from './pipeline.js';

export type X402ResolutionResult =
  | {
      status: 'completed';
      signature: string;
      paymentSignatureHeader: string;
      request: PaymentRequest;
    }
  | {
      status: 'pending_approval';
      code: 'X402_APPROVAL_REQUIRED';
      message: string;
      remediation: string;
      approvalUrl: string;
      requestId: string;
      details?: Record<string, unknown>;
      request: PaymentRequest;
    }
  | {
      status: 'denied';
      code: string;
      message: string;
      remediation?: string;
      details?: Record<string, unknown>;
      request?: PaymentRequest;
    };

export async function resolveX402Payment(
  ctx: AppContext,
  challengeInput: unknown,
  resourceUrl?: string,
): Promise<X402ResolutionResult> {
  let challenge: X402PaymentRequired;
  try {
    challenge = parseX402Challenge(challengeInput);
  } catch (err) {
    return {
      status: 'denied',
      code: 'INVALID_X402_CHALLENGE',
      message: `Failed to parse x402 payment challenge: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Verify that the server responded with a valid x402 PaymentRequired payload or base64 header.',
    };
  }

  const option = findSupportedX402Option(challenge, ctx.config.SOLANA_CLUSTER);
  if (!option) {
    return {
      status: 'denied',
      code: 'UNSUPPORTED_NETWORK',
      message: 'No supported Solana payment option found in x402 challenge',
      remediation: 'Ensure the resource server accepts payment on the configured Solana cluster.',
      details: {
        cluster: ctx.config.SOLANA_CLUSTER,
        receivedOptions: challenge.accepts.map((o) => ({ network: o.network, asset: o.asset })),
      },
    };
  }

  if (resourceUrl && !option.resource) {
    option.resource = resourceUrl;
  }

  const policy = ctx.store.getPolicy();
  let actionWithKey;
  try {
    actionWithKey = x402OptionToAction(option, policy);
  } catch (err) {
    return {
      status: 'denied',
      code: 'INVALID_X402_OPTION',
      message: err instanceof Error ? err.message : String(err),
      remediation: 'Ensure the challenge specifies a valid positive amount and recipient address.',
    };
  }

  const request = await runAction(ctx, {
    action: actionWithKey.action,
    idempotencyKey: actionWithKey.idempotencyKey,
  });

  if (request.status === 'confirmed' || request.status === 'auto_approved') {
    const signature = request.execution?.signature ?? '';
    const sigPayload: X402PaymentSignature = {
      x402Version: challenge.x402Version ?? 2,
      scheme: option.scheme,
      network: option.network,
      payload: {
        signature,
        authorization: {
          from: ctx.agentPubkey,
          to: option.payee,
          amount: option.amount,
          asset: option.asset,
          nonce: option.nonce,
        },
      },
    };

    return {
      status: 'completed',
      signature,
      paymentSignatureHeader: formatX402SignatureHeader(sigPayload),
      request,
    };
  }

  const dashboardUrl = ctx.config.allowedOrigins?.[0] ?? ctx.config.WEB_ORIGIN;
  if (request.status === 'pending_approval') {
    return {
      status: 'pending_approval',
      code: 'X402_APPROVAL_REQUIRED',
      message:
        'x402 payment exceeds policy limit and requires owner approval in the nexusPay dashboard.',
      remediation: AGENT_ERROR_REMEDIATION.PENDING_APPROVAL_REQUIRED,
      approvalUrl: `${dashboardUrl}/#requests`,
      requestId: request.id,
      request,
    };
  }

  return {
    status: 'denied',
    code: request.error?.code ?? 'POLICY_DENIED',
    message: request.error?.message ?? 'Payment was denied by policy',
    remediation: request.error?.remediation,
    details: request.error?.details,
    request,
  };
}

export type X402FetchResult = {
  status: number;
  headers: Record<string, string>;
  data: unknown;
  payment?: {
    status: 'paid' | 'not_required';
    signature?: string;
    requestId?: string;
  };
  error?: {
    code: string;
    message: string;
    remediation?: string;
    details?: Record<string, unknown>;
  };
};

export async function fetchWithX402(
  ctx: AppContext,
  url: string,
  init?: RequestInit,
): Promise<X402FetchResult> {
  const initialRes = await fetch(url, init);
  if (initialRes.status !== 402) {
    const text = await initialRes.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // Keep as text
    }
    const headers: Record<string, string> = {};
    initialRes.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: initialRes.status,
      headers,
      data,
      payment: { status: 'not_required' },
    };
  }

  // 402 Payment Required: extract challenge
  const headerChallenge =
    initialRes.headers.get('payment-required') ||
    initialRes.headers.get('x-payment-required');
  let challengeInput: unknown = headerChallenge;

  if (!challengeInput) {
    try {
      challengeInput = await initialRes.json();
    } catch {
      challengeInput = null;
    }
  }

  if (!challengeInput) {
    return {
      status: 402,
      headers: {},
      data: null,
      error: {
        code: 'MISSING_X402_CHALLENGE',
        message: 'Endpoint returned 402 but no PAYMENT-REQUIRED header or JSON body was found.',
        remediation: 'Ensure the endpoint complies with the x402 specification.',
      },
    };
  }

  const resolution = await resolveX402Payment(ctx, challengeInput, url);
  if (resolution.status !== 'completed') {
    return {
      status: 402,
      headers: {},
      data: null,
      payment: { status: 'paid', requestId: resolution.request?.id },
      error: {
        code: resolution.code,
        message: resolution.message,
        remediation: resolution.remediation,
        details: resolution.details,
      },
    };
  }

  // Retry with PAYMENT-SIGNATURE
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.set('PAYMENT-SIGNATURE', resolution.paymentSignatureHeader);

  const finalRes = await fetch(url, { ...init, headers: retryHeaders });
  const finalText = await finalRes.text();
  let finalData: unknown = finalText;
  try {
    finalData = JSON.parse(finalText);
  } catch {
    // Keep as text
  }

  const finalHeaders: Record<string, string> = {};
  finalRes.headers.forEach((v, k) => {
    finalHeaders[k] = v;
  });

  return {
    status: finalRes.status,
    headers: finalHeaders,
    data: finalData,
    payment: {
      status: 'paid',
      signature: resolution.signature,
      requestId: resolution.request.id,
    },
  };
}
