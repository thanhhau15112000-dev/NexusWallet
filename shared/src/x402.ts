import { z } from 'zod';
import { LAMPORTS_PER_SOL, PubkeySchema, type ModelAction } from './contract.js';
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

export function x402OptionToAction(
  option: X402AcceptOption,
  policy: Policy,
): {
  action: Extract<ModelAction, { type: 'transfer_sol' | 'transfer_spl' }>;
  idempotencyKey: string;
} {
  const rawAmount = typeof option.amount === 'string' ? Number(option.amount) : option.amount;
  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    throw new RangeError(`Invalid x402 payment amount: ${option.amount}`);
  }

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
    const lamports = Math.round(rawAmount);
    const amountSol = lamports / LAMPORTS_PER_SOL;
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

  return {
    action: {
      type: 'transfer_spl',
      recipient: option.payee,
      mint: option.asset,
      amount: rawAmount,
      memo: option.nonce ? `x402:${option.nonce}` : undefined,
    },
    idempotencyKey,
  };
}
