import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PaymentRequest, Policy, RequestStatus } from '@nexus/shared';
import { ApiError, ApiUnreachableError, type NexusApi } from './api.js';
import type { McpConfig } from './config.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
const REQUEST_STATUSES = [
  'planned',
  'auto_approved',
  'pending_approval',
  'approved',
  'confirmed',
  'failed',
  'denied',
  'expired',
] as const satisfies readonly RequestStatus[];

const INSTRUCTIONS = [
  'nexusPay gives you a Solana Devnet agent wallet behind a spending policy set by its owner.',
  'You propose transfers; the policy decides. Inside the policy a transfer is signed at once.',
  'Above the per-transaction limit it waits for the owner to approve in the nexusPay dashboard;',
  'you cannot approve it and must not ask the user for keys or seed phrases.',
  'Recipients outside the allowlist are denied. Call nexuspay_get_status to see the allowlist labels.',
  'If a transfer returns outcome_unknown, call it again with the same idempotencyKey; do not change the amount.',
].join(' ');

type StateResponse = {
  cluster: string;
  agent: { agentId: string; pubkey: string; lamports: number | null; rpcError: string | null; explorerUrl: string };
  policy: Policy & { maxSolPerTx: number };
};

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, message, ...extra }, null, 2) }],
  };
}

function failFromError(err: unknown, extra: Record<string, unknown> = {}): CallToolResult {
  if (err instanceof ApiError) return fail(err.code, err.message, extra);
  if (err instanceof ApiUnreachableError) return fail('agent_unreachable', err.message, extra);
  throw err;
}

/** What an agent needs to act on a request. Prompt text, nonces and model traces stay out. */
export function summarizeRequest(request: PaymentRequest, dashboardUrl: string) {
  return {
    requestId: request.id,
    status: request.status,
    createdAt: request.createdAt,
    action: request.plan?.action ?? null,
    verdict: request.decision?.verdict ?? null,
    reasons: request.decision?.reasons ?? [],
    idempotencyKey: request.idempotencyKey,
    execution: request.execution
      ? { signature: request.execution.signature, explorerUrl: request.execution.explorerUrl }
      : null,
    approval:
      request.status === 'pending_approval' && request.approval
        ? {
            expiresAt: request.approval.payload.expiresAt,
            nextStep: `The owner must approve this request in the nexusPay dashboard (${dashboardUrl}) before it expires. Poll nexuspay_get_request for the outcome.`,
          }
        : null,
    balanceSol: request.balanceLamports === null ? null : request.balanceLamports / LAMPORTS_PER_SOL,
    error: request.error,
  };
}

const idempotencyKeyInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9:_-]+$/)
  .optional()
  .describe('Reuse the same key only to retry the same transfer after outcome_unknown. Omit for a new transfer.');

export function createServer(api: NexusApi, config: McpConfig): McpServer {
  const server = new McpServer({ name: 'nexuspay', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  async function submit(action: Record<string, unknown>, idempotencyKey: string | undefined) {
    // Fixed before the call, so a timed-out submission can be retried without paying twice.
    const key = idempotencyKey ?? `mcp:${randomUUID()}`;
    try {
      const { request } = await api.post<{ request: PaymentRequest }>('/api/agent/intents', {
        action,
        idempotencyKey: key,
      });
      return ok(summarizeRequest(request, config.dashboardUrl));
    } catch (err) {
      // A timeout or a server error may come after the transfer was signed.
      if ((err instanceof ApiUnreachableError && err.timedOut) || (err instanceof ApiError && err.status >= 500)) {
        return fail(
          'outcome_unknown',
          'The agent did not confirm the outcome and the transfer may have been submitted. Retry with the same idempotencyKey, or check nexuspay_list_requests.',
          { idempotencyKey: key },
        );
      }
      return failFromError(err, { idempotencyKey: key });
    }
  }

  server.registerTool(
    'nexuspay_get_status',
    {
      title: 'Get nexusPay wallet status',
      description:
        'Agent wallet address and SOL balance on Devnet, plus the owner policy: per-transaction SOL limit and the allowlisted recipient and mint labels you may use.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const state = await api.get<StateResponse>('/api/state');
        return ok({
          cluster: state.cluster,
          wallet: {
            address: state.agent.pubkey,
            balanceSol: state.agent.lamports === null ? null : state.agent.lamports / LAMPORTS_PER_SOL,
            balanceError: state.agent.rpcError,
            explorerUrl: state.agent.explorerUrl,
          },
          policy: {
            version: state.policy.version,
            maxSolPerTransaction: state.policy.maxSolPerTx,
            recipients: state.policy.allowedRecipients,
            mints: state.policy.allowedMints,
            maxTokenAmountByMint: state.policy.maxTokenAmountByMint,
          },
        });
      } catch (err) {
        return failFromError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_list_requests',
    {
      title: 'List nexusPay requests',
      description: 'Most recent payment requests for this wallet, newest first, with policy verdicts and outcomes.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
        status: z.enum(REQUEST_STATUSES).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, status }) => {
      try {
        const { requests } = await api.get<{ requests: PaymentRequest[] }>('/api/requests');
        return ok(
          requests
            .filter((request) => !status || request.status === status)
            .slice(0, limit)
            .map((request) => summarizeRequest(request, config.dashboardUrl)),
        );
      } catch (err) {
        return failFromError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_get_request',
    {
      title: 'Get a nexusPay request',
      description: 'Current state of one request, for example to see whether the owner approved a held transfer.',
      inputSchema: { requestId: z.string().trim().regex(/^req_[A-Za-z0-9-]{1,40}$/) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ requestId }) => {
      try {
        const { request } = await api.get<{ request: PaymentRequest }>(
          `/api/requests/${encodeURIComponent(requestId)}`,
        );
        return ok(summarizeRequest(request, config.dashboardUrl));
      } catch (err) {
        return failFromError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_transfer_sol',
    {
      title: 'Send SOL (policy-gated)',
      description:
        'Propose a Devnet SOL transfer from the agent wallet. The owner policy decides: allowed transfers are signed immediately, larger ones wait for owner approval, off-allowlist recipients are denied.',
      inputSchema: {
        recipient: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .describe('An allowlisted recipient label or its exact address.'),
        amountSol: z.number().positive().max(1_000_000),
        idempotencyKey: idempotencyKeyInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, amountSol, idempotencyKey }) =>
      submit({ type: 'transfer_sol', recipient, amountSol }, idempotencyKey),
  );

  server.registerTool(
    'nexuspay_transfer_spl',
    {
      title: 'Send an SPL token (policy-gated)',
      description:
        'Propose a Devnet SPL token transfer. Both the recipient and the mint must be allowlisted by the owner; the amount is in token units, not base units.',
      inputSchema: {
        recipient: z.string().trim().min(1).max(64).describe('An allowlisted recipient label or its exact address.'),
        mint: z.string().trim().min(1).max(64).describe('An allowlisted mint label or its exact address.'),
        amount: z.number().positive().max(1_000_000_000),
        idempotencyKey: idempotencyKeyInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, mint, amount, idempotencyKey }) =>
      submit({ type: 'transfer_spl', recipient, mint, amount }, idempotencyKey),
  );

  return server;
}
