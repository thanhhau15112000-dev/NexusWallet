/**
 * Everything the agent service and the dashboard must agree on: units, the two
 * model-stage outputs, the approval message, and the shape of a stored request.
 *
 * The one rule that decides whether a transfer may happen lives next door in
 * `policy.ts`.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- units

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Base58 alphabet; a 32-byte ed25519 public key encodes to 32..44 characters. */
export const PubkeySchema = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'not a base58 Solana address');

/** Human SOL to integer lamports, without float drift. */
export function solToLamports(amountSol: number): number {
  if (!Number.isFinite(amountSol) || amountSol < 0) {
    throw new RangeError(`invalid SOL amount: ${amountSol}`);
  }
  return Math.round(amountSol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

// ---------------------------------------------------- stage 1: intent

/**
 * What the context model returns. It restates the request; it never names a
 * signer, a key or an RPC endpoint.
 */
export const IntentEnvelopeSchema = z.object({
  goal: z.string().min(1).max(400),
  operation: z.enum(['transfer_sol', 'transfer_spl', 'get_balance', 'unknown']),
  entities: z.object({
    recipient: z.string().trim().max(64).optional(),
    amount: z.number().nonnegative().optional(),
    asset: z.string().trim().max(64).optional(),
  }),
  /** Anything the model found risky or ambiguous. Surfaced in the audit log. */
  riskNotes: z.array(z.string().max(200)).max(8).default([]),
  confidence: z.number().min(0).max(1),
  /** The model may ask for a human in the loop; it can never remove one. */
  requiresHuman: z.boolean().default(false),
});

export type IntentEnvelope = z.infer<typeof IntentEnvelopeSchema>;

// ----------------------------------------------------- stage 2: action

/**
 * The planner model may only return one of these four actions. No instructions,
 * no serialized transactions, no program ids. Anything else fails validation
 * before the policy engine sees it.
 */
export const ModelActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('get_balance') }),
  z.object({
    type: z.literal('transfer_sol'),
    /** Base58 address, or a label declared in the recipient allowlist. */
    recipient: z.string().trim().min(1).max(64),
    amountSol: z.number().positive().max(1_000_000),
    memo: z.string().trim().max(120).optional(),
  }),
  z.object({
    type: z.literal('transfer_spl'),
    recipient: z.string().trim().min(1).max(64),
    /** Base58 mint address, or a label declared in the mint allowlist. */
    mint: z.string().trim().min(1).max(64),
    amount: z.number().positive().max(1_000_000_000),
    memo: z.string().trim().max(120).optional(),
  }),
  z.object({
    type: z.literal('request_manual_approval'),
    reason: z.string().trim().min(1).max(200),
  }),
]);

export type ModelAction = z.infer<typeof ModelActionSchema>;

export const ActionPlanSchema = z.object({
  action: ModelActionSchema,
  rationale: z.string().trim().max(400).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type ActionPlan = z.infer<typeof ActionPlanSchema>;

/** An action after label resolution. Produced by the policy engine, never by a model. */
export type ResolvedAction =
  | { type: 'get_balance' }
  | {
      type: 'transfer_sol';
      recipient: string;
      recipientLabel: string;
      lamports: number;
      memo?: string;
    }
  | {
      type: 'transfer_spl';
      recipient: string;
      recipientLabel: string;
      mint: string;
      mintLabel: string;
      /** Human units. Base units are derived at execution time from on-chain decimals. */
      amount: number;
      memo?: string;
    };

// ------------------------------------------------------------ approval

/**
 * Everything an owner signature is bound to. Change any field and the message
 * changes, so a signature captured for one request cannot authorise another.
 */
export const ApprovalPayloadSchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  policyVersion: z.number().int().nonnegative(),
  actionType: z.enum(['transfer_sol', 'transfer_spl']),
  recipient: z.string().min(1),
  /** Lamports for SOL, human token units for SPL. */
  amount: z.number().nonnegative(),
  mint: z.string().min(1),
  /** Single-use random value issued by the agent service. */
  nonce: z.string().min(8),
  expiresAt: z.string().datetime(),
});

export type ApprovalPayload = z.infer<typeof ApprovalPayloadSchema>;

/**
 * Canonical approval message. The dashboard rebuilds it from the payload and
 * refuses to sign if the server's copy differs by a single byte.
 */
export function buildApprovalMessage(payload: ApprovalPayload): string {
  const amount =
    payload.actionType === 'transfer_sol'
      ? `${payload.amount / LAMPORTS_PER_SOL} SOL (${payload.amount} lamports)`
      : `${payload.amount} tokens of mint ${payload.mint}`;

  return [
    'NexusWallet - agent payment approval',
    '',
    `You are authorising ONE transaction by agent "${payload.agentId}".`,
    'This signature is not a transaction. It unlocks a single agent-signed transfer.',
    '',
    `request:  ${payload.requestId}`,
    `action:   ${payload.actionType}`,
    `amount:   ${amount}`,
    `to:       ${payload.recipient}`,
    `mint:     ${payload.mint}`,
    `policy:   v${payload.policyVersion}`,
    `nonce:    ${payload.nonce}`,
    `expires:  ${payload.expiresAt}`,
  ].join('\n');
}

export type ApprovalState = {
  payload: ApprovalPayload;
  message: string;
  signature: string | null;
  signerPubkey: string | null;
  signedAt: string | null;
  consumedAt: string | null;
};

// ------------------------------------------------------------- request

export const REQUEST_STATUSES = [
  'planned',
  'auto_approved',
  'pending_approval',
  'approved',
  'confirmed',
  'failed',
  'denied',
  'expired',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What the models are allowed to see: the request text plus public allowlist entries. */
export type ModelContext = {
  agentId: string;
  cluster: string;
  maxSolPerTx: number;
  recipients: { label: string; address: string }[];
  mints: { label: string; address: string }[];
};

export type StageMeta = {
  name: string;
  model: string;
  fallback: boolean;
  ms: number;
  error?: string;
};

export type ExecutionRecord = {
  signature: string;
  explorerUrl: string;
  submittedAt: string;
  confirmedAt: string;
  slot: number | null;
};

export type PaymentRequest = {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  status: RequestStatus;
  prompt: string;
  idempotencyKey: string | null;
  intent: IntentEnvelope | null;
  plan: ActionPlan | null;
  decision: PolicyDecisionRef | null;
  modelTrace: { stage1: StageMeta; stage2: StageMeta } | null;
  approval: ApprovalState | null;
  execution: ExecutionRecord | null;
  /** Result of a read-only action such as get_balance. */
  balanceLamports: number | null;
  error: { code: string; message: string } | null;
};

/** Declared in `policy.ts`; referenced here to keep the request shape in one place. */
type PolicyDecisionRef = import('./policy.js').PolicyDecision;

// --------------------------------------------------------------- audit

export type AuditEntry = {
  id: string;
  at: string;
  requestId: string | null;
  event: string;
  /** AES-256-GCM ciphertext of the event detail. */
  sealed: { iv: string; tag: string; ciphertext: string };
};

export type AuditEntryView = AuditEntry & { detail: unknown };
