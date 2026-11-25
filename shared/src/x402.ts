import { z } from 'zod';
import { type ModelAction } from './contract.js';
import type { Policy } from './policy.js';

export const X402AcceptOptionSchema = z.object({
  scheme: z.string().default('exact'),
  network: z.string(),
  amount: z.union([z.string(), z.number()]),
  asset: z.string(),
  payee: z.string(),
  resource: z.string().optional(),
  nonce: z.string().optional(),
  maxTimeoutSeconds: z.number().optional(),
});
export type X402AcceptOption = z.infer<typeof X402AcceptOptionSchema>;

export const X402PaymentRequiredSchema = z.object({
  x402Version: z.number().int().optional().default(2),
  error: z.string().optional(),
  accepts: z.array(X402AcceptOptionSchema).min(1),
});
export type X402PaymentRequired = z.infer<typeof X402PaymentRequiredSchema>;

export const X402PaymentSignatureSchema = z.object({
  x402Version: z.number().int().default(2),
  scheme: z.string().default('exact'),
  network: z.string(),
  payload: z.object({
    signature: z.string(),
    authorization: z
      .object({
        from: z.string(),
        to: z.string(),
        amount: z.union([z.string(), z.number()]),
        asset: z.string(),
        nonce: z.string().optional(),
      })
      .optional(),
    transaction: z.string().optional(),
  }),
});
export type X402PaymentSignature = z.infer<typeof X402PaymentSignatureSchema>;

export function parseX402Challenge(input: unknown): X402PaymentRequired {
  let json: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{')) {
      json = JSON.parse(trimmed);
    } else {
      try {
        const decoded = Buffer.from(trimmed, 'base64').toString('utf-8');
        json = JSON.parse(decoded);
      } catch {
        json = JSON.parse(trimmed);
      }
    }
  }
  return X402PaymentRequiredSchema.parse(json);
}

export function formatX402SignatureHeader(payload: X402PaymentSignature): string {
  const jsonStr = JSON.stringify(payload);
  return Buffer.from(jsonStr, 'utf-8').toString('base64');
}

export function isNativeSolAsset(asset: string): boolean {
  const lower = asset.trim().toLowerCase();
  return (
    lower === 'native' ||
    lower === 'sol' ||
    lower === 'solana' ||
    asset.trim() === 'So11111111111111111111111111111111111111112'
  );
}

export function findSupportedX402Option(
  challenge: X402PaymentRequired,
  cluster = 'devnet',
): X402AcceptOption | undefined {
  return challenge.accepts.find((opt) => {
    const net = opt.network.toLowerCase();
    const isSolana = net === 'solana' || net.startsWith('solana-') || net.startsWith('solana:');
    if (!isSolana) return false;
    if (net.includes('mainnet') && cluster !== 'mainnet-beta' && cluster !== 'mainnet') {
      return false;
    }
    return true;
  });
}

function parsePositiveBaseUnits(amount: string | number): bigint {
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new RangeError(`Invalid x402 integer base-unit amount: ${amount}`);
    }
    return BigInt(amount);
  }
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new RangeError(`Invalid x402 integer base-unit amount: ${amount}`);
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) {
    throw new RangeError(`Invalid x402 payment amount: ${amount}`);
  }
  return parsed;
}

function baseUnitsToHuman(baseUnits: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new RangeError(`Invalid token decimals: ${decimals}`);
  }
  if (decimals === 0) {
    const whole = Number(baseUnits);
    if (!Number.isSafeInteger(whole) || whole <= 0) {
      throw new RangeError(`x402 amount out of supported numeric range: ${baseUnits}`);
    }
    return whole;
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const fraction = (baseUnits % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  const value = Number(fraction ? `${whole}.${fraction}` : whole.toString());
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`x402 amount out of supported numeric range: ${baseUnits}`);
  }
  return value;
}

export function x402OptionToAction(
  option: X402AcceptOption,
  policy: Policy,
  splDecimals?: number,
): {
  action: Extract<ModelAction, { type: 'transfer_sol' | 'transfer_spl' }>;
  idempotencyKey: string;
} {
  const baseUnits = parsePositiveBaseUnits(option.amount);

  const cleanResource = (option.resource ?? 'endpoint')
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .slice(0, 40);
  const nonceKey = option.nonce ?? `${option.payee}:${option.amount}`;
  const rawKey = `x402:${policy.agentId}:${cleanResource}:${nonceKey}`;
  // Ensure idempotency key meets regex /^[A-Za-z0-9:_-]+$/ and max 100 length
  const idempotencyKey = rawKey.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 100);

  const isNative = isNativeSolAsset(option.asset);
  if (isNative) {
    const amountSol = baseUnitsToHuman(baseUnits, 9);
    return {
      action: {
        type: 'transfer_sol',
        recipient: option.payee,
        amountSol,
        memo: option.nonce ? `x402:${option.nonce}` : undefined,
      },
      idempotencyKey,
    };
  }

  if (splDecimals === undefined) {
    throw new RangeError(`Mint decimals are required for SPL x402 asset: ${option.asset}`);
  }

  return {
    action: {
      type: 'transfer_spl',
      recipient: option.payee,
      mint: option.asset,
      amount: baseUnitsToHuman(baseUnits, splDecimals),
      memo: option.nonce ? `x402:${option.nonce}` : undefined,
    },
    idempotencyKey,
  };
}
