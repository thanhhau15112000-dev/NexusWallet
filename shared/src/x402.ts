/**
 * x402 v1, scheme `exact` on Solana: the shapes a resource server sends in a 402 and the
 * payment header the agent sends back. The agent pays with one SPL `TransferChecked`
 * transaction it signs as fee payer and does not broadcast; the server's facilitator
 * verifies and submits it.
 */
import { z } from 'zod';
import { PubkeySchema } from './contract.js';

/** CAIP-2 id of Solana devnet (its genesis hash) and the v1 short name for it. */
export const SOLANA_DEVNET_NETWORKS = ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'solana-devnet'] as const;

export const X402_PAYMENT_HEADER = 'X-PAYMENT';
export const X402_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

export const X402RequirementsSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    /** Integer base units of `asset`. */
    maxAmountRequired: z.string().regex(/^\d+$/, 'must be integer base units'),
    resource: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    payTo: PubkeySchema,
    maxTimeoutSeconds: z.number().optional(),
    /** SPL mint address. */
    asset: PubkeySchema,
    extra: z
      .object({
        feePayer: z.string().optional(),
        tokenDecimals: z.number().int().optional(),
        tokenProgram: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type X402Requirements = z.infer<typeof X402RequirementsSchema>;

export const X402PaymentRequiredSchema = z.object({
  x402Version: z.literal(1),
  error: z.string().optional(),
  // Entries for other chains or versions may not parse; keep them raw and pick ours later.
  accepts: z.array(z.unknown()).min(1),
});
export type X402PaymentRequired = z.infer<typeof X402PaymentRequiredSchema>;

export type X402PaymentPayload = {
  x402Version: 1;
  scheme: 'exact';
  network: string;
  payload: { transaction: string };
};

/** Accepts the JSON body, a JSON string or a base64 JSON string. */
export function parseX402Challenge(input: unknown): X402PaymentRequired {
  let json: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    json = JSON.parse(trimmed.startsWith('{') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf-8'));
  }
  return X402PaymentRequiredSchema.parse(json);
}

/** The first `exact` option on Solana devnet that parses; anything else is not payable here. */
export function selectX402Requirements(challenge: X402PaymentRequired): X402Requirements | undefined {
  for (const entry of challenge.accepts) {
    const parsed = X402RequirementsSchema.safeParse(entry);
    if (!parsed.success) continue;
    const option = parsed.data;
    if (option.scheme === 'exact' && (SOLANA_DEVNET_NETWORKS as readonly string[]).includes(option.network)) {
      return option;
    }
  }
  return undefined;
}

export function encodeX402PaymentHeader(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

/** Decodes `X-PAYMENT-RESPONSE`; returns null when absent or malformed. */
export function decodeX402PaymentResponse(header: string | null): Record<string, unknown> | null {
  if (!header) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Integer base units to a human amount with `decimals` places, exactly. */
export function baseUnitsToHuman(baseUnits: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`invalid token decimals: ${decimals}`);
  }
  const units = BigInt(baseUnits);
  if (units <= 0n) throw new RangeError(`x402 amount must be positive: ${baseUnits}`);
  // Beyond 2^53 base units a JS number no longer round-trips to the same integer.
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`x402 amount out of supported numeric range: ${baseUnits}`);
  }
  const divisor = 10n ** BigInt(decimals);
  const fraction = (units % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(fraction ? `${units / divisor}.${fraction}` : (units / divisor).toString());
}
