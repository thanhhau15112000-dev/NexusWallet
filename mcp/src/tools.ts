import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  AGENT_ERROR_REMEDIATION,
  TASK_STATUSES,
  type PaymentRequest,
  type Policy,
  type RequestStatus,
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
} from '@nexus/shared';
import { ApiError, ApiUnreachableError, McpSetupError, type NexusApi } from './api.js';
import type { McpConfig } from './config.js';

const LAMPORTS_PER_SOL = 1_000_000_000;
/** How often an agent should poll a held request; approvals need a human, so faster polling gains nothing. */
export const APPROVAL_POLL_INTERVAL_MS = 5_000;
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
  'If a transfer returns AGENT_FROZEN, the owner has locked the agent; stop proposing transfers and ask the owner to unfreeze it in the dashboard.',
  'For Task Vault, read the task first: the owner funds it and delegates a budget, payment cap, expiry, worker and service.',
  'nexuspay_execute_task_payment moves funds into escrow only; the worker must sign a receipt to receive them.',
  'Task Vault limits reject payments outside the capability; they do not enter the transfer approval queue.',
  'Keep the same paymentId and all parameters after an uncertain outcome; never use a new paymentId to retry.',
  'Tasks and payments marked simulated do not move SOL. The current on-chain demo uses a server-held mock worker.',
  'You cannot create or fund tasks, revoke them, run the mock worker, settle escrows or refund through MCP.',
].join(' ');

type StateResponse = {
  cluster: string;
  agent: {
    agentId: string;
    pubkey: string;
    lamports: number | null;
    rpcError: string | null;
    explorerUrl: string;
    /** Absent when the agent service predates it. */
    feeReserveLamports?: number;
    frozen?: boolean;
    frozenAt?: string | null;
  };
  policy: Policy & { maxSolPerTx: number; maxSolPerDay?: number | null };
  usage?: {
    spentSol24h: number;
    remainingSol24h: number | null;
  };
};

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// `error` predates `code` and is kept for clients that already read it.
function fail(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  structured: { remediation?: string; details?: Record<string, unknown> } = {},
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, code, message, ...structured, ...extra }, null, 2) }],
  };
}

// Error messages name the fix, so an agent on another machine can repair its setup without the repo history.
function failFromError(err: unknown, config: McpConfig, extra: Record<string, unknown> = {}): CallToolResult {
  if (err instanceof McpSetupError) return fail('mcp_setup_required', err.message, extra);
  if (err instanceof ApiError && err.status === 401) {
    const message =
      config.tokenSource === 'remote'
        ? 'The nexusPay agent rejected this connection token (it was rotated or copied wrong). A hosted dashboard cannot show an existing token again: create a new one in the dashboard (Wallet tab > Connect an AI agent) and update the MCP client with it.'
        : config.tokenSource === 'env'
          ? 'The nexusPay agent rejected NEXUS_AGENT_TOKEN (rotated, from another checkout, or copied wrong). Copy the MCP entry again from the dashboard (Wallet tab > Connect an AI agent) or run pnpm mcp:config, then restart the MCP client.'
          : `The nexusPay agent rejected the MCP token from ${config.tokenSource}. If the agent is using a different data directory, set NEXUS_AGENT_DATA_DIR to point to it, or sign in to the dashboard with the owner wallet once.`;
    return fail('mcp_token_rejected', message, extra);
  }
  if (err instanceof ApiError) {
    return fail(err.code, err.message, extra, { remediation: err.remediation, details: err.details });
  }
  if (err instanceof ApiUnreachableError) {
    return fail(
      'agent_unreachable',
      err.timedOut ? err.message : `${err.message}. Start the agent service from the repository root with pnpm dev, then retry.`,
      extra,
    );
  }
  throw err;
}

export function requestDeepLink(dashboardUrl: string, requestId: string): string {
  // Hosted mode takes the dashboard origin from env config; a malformed one must not break the tool result.
  try {
    const url = new URL(dashboardUrl);
    url.searchParams.set('request', requestId);
    return url.toString();
  } catch {
    return dashboardUrl;
  }
}

/** What an agent needs to act on a request. Prompt text, nonces and model traces stay out. */
export function summarizeRequest(request: PaymentRequest, dashboardUrl: string) {
  const held = request.status === 'pending_approval' && request.approval;
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
    approval: held
      ? {
          code: 'PENDING_APPROVAL_REQUIRED',
          message: (request.decision?.reasons ?? []).join('; '),
          remediation: AGENT_ERROR_REMEDIATION.PENDING_APPROVAL_REQUIRED,
          details: { reason: request.decision?.code ?? null, ...request.decision?.details },
          expiresAt: held.payload.expiresAt,
          pollIntervalMs: APPROVAL_POLL_INTERVAL_MS,
          dashboardUrl: requestDeepLink(dashboardUrl, request.id),
          nextStep: `The owner must approve this request in the nexusPay dashboard before it expires. Poll nexuspay_get_request for the outcome.`,
        }
      : null,
    balanceSol: request.balanceLamports === null ? null : request.balanceLamports / LAMPORTS_PER_SOL,
    error: request.error,
  };
}

// `.positive()` would emit `exclusiveMinimum`, which Gemini function calling (Antigravity) rejects.
// A 1e-9 floor keeps the schema to plain `minimum`; the policy still denies amounts that round to zero.
function amountInput(description: string) {
  return z.number().min(1e-9).max(1_000_000_000).describe(description);
}

type TaskDetailResponse = {
  task: TaskCapabilityRecord;
  payments: TaskPaymentRecord[];
  receipts: TaskReceiptRecord[];
};

/** Local records, with expiry made explicit; these reads do not reconcile chain state. */
function summarizeTask(task: TaskCapabilityRecord) {
  const expired = Math.floor(Date.now() / 1000) >= task.expiry;
  return {
    ...task,
    status: task.status === 'active' && expired ? 'expired' : task.status,
    expired,
    remainingBudgetLamports: Math.max(0, task.budgetLamports - task.spentLamports),
    mode: task.isSimulated === false ? 'devnet' : 'simulated',
    source: 'agent_local_record',
  };
}

// A task ID is a single URL segment. Reject dot segments and slashes before encoding.
const taskIdInput = z.string().trim().min(1).max(64).regex(/^(?!\.{1,2}$)[^/\\]+$/);
const paymentIdInput = z.string().trim().min(1).max(64)
  .describe('A unique ID for this payment within the task. Reuse it with identical parameters after an uncertain outcome.');

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
  const handleError = (err: unknown, extra: Record<string, unknown> = {}) => failFromError(err, config, extra);

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
      return handleError(err, { idempotencyKey: key });
    }
  }

  server.registerTool(
    'nexuspay_get_status',
    {
      title: 'Get nexusPay wallet status',
      description:
        'Agent wallet address and SOL balance on Devnet, 24-hour spending usage, the fee reserve a SOL transfer needs on top of its amount (estimatedFeeSol), plus the owner policy: per-transaction and daily SOL limits and the allowlisted recipient and mint labels you may use.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const state = await api.get<StateResponse>('/api/state');
        return ok({
          cluster: state.cluster,
          frozen: Boolean(state.agent.frozen),
          wallet: {
            address: state.agent.pubkey,
            balanceSol: state.agent.lamports === null ? null : state.agent.lamports / LAMPORTS_PER_SOL,
            balanceError: state.agent.rpcError,
            explorerUrl: state.agent.explorerUrl,
          },
          // Fee reserve the agent checks on top of a SOL transfer amount; an upper bound, not the fee charged.
          estimatedFeeSol:
            state.agent.feeReserveLamports === undefined ? null : state.agent.feeReserveLamports / LAMPORTS_PER_SOL,
          policy: {
            version: state.policy.version,
            maxSolPerTransaction: state.policy.maxSolPerTx,
            maxSolPerDay: state.policy.maxSolPerDay ?? null,
            recipients: state.policy.allowedRecipients,
            mints: state.policy.allowedMints,
            maxTokenAmountByMint: state.policy.maxTokenAmountByMint,
          },
          spentSol24h: state.usage?.spentSol24h ?? 0,
          remainingSol24h: state.usage?.remainingSol24h ?? null,
        });
      } catch (err) {
        return handleError(err);
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
        return handleError(err);
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
        return handleError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_list_tasks',
    {
      title: 'List delegated Task Vault budgets',
      description:
        'List this owner\'s Task Vault records with remaining budget in lamports, per-payment cap, expiry and allowed worker/service. Results explicitly distinguish simulated records from Devnet tasks; local records are not a fresh chain reconciliation.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
        status: z.enum(TASK_STATUSES).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, status }) => {
      try {
        const { tasks } = await api.get<{ tasks: TaskCapabilityRecord[] }>('/api/tasks');
        const summaries = tasks.map(summarizeTask).filter((task) => !status || task.status === status);
        return ok({ tasks: summaries.slice(0, limit), matchingCount: summaries.length });
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_get_task',
    {
      title: 'Get a Task Vault and its escrow outcomes',
      description:
        'Read one task, its escrow payments and receipts for this owner. Use before payment and after an uncertain submission. A held payment has not paid the worker; a receipt records a signed result hash, not verified work quality.',
      inputSchema: { taskId: taskIdInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ taskId }) => {
      try {
        const detail = await api.get<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(taskId)}`);
        return ok({ ...detail, task: summarizeTask(detail.task) });
      } catch (err) {
        return handleError(err);
      }
    },
  );

  server.registerTool(
    'nexuspay_execute_task_payment',
    {
      title: 'Create an escrow from a delegated Task Vault',
      description:
        'Move a task budget into escrow on Devnet (or simulate for a simulated task). The task must be open, active and unexpired; the agent must be unfrozen. Budget, cap, worker and service restrictions are enforced by the API and the on-chain program for Devnet tasks. This does not settle or pay the worker. The agent wallet pays transaction fees and escrow rent. The on-chain demo currently supports only the configured mock worker.',
      inputSchema: {
        taskId: taskIdInput,
        paymentId: paymentIdInput,
        worker: z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
          .describe('Exact worker public key allowed by the task; no labels.'),
        serviceId: z.string().trim().min(1).max(64).describe('Exact service ID allowed by the task.'),
        amountLamports: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
          .describe('Integer lamports, not SOL. 1 SOL = 1000000000 lamports.'),
        requestHash: z.string().trim().regex(/^[0-9a-f]{64}$/)
          .describe('Lowercase SHA-256 hex digest of the service request payload.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ taskId, ...payment }) => {
      const path = `/api/tasks/${encodeURIComponent(taskId)}`;
      const ids = { taskId, paymentId: payment.paymentId };
      const outcomeUnknown = () => fail(
        'outcome_unknown',
        'The escrow may have been submitted. Read nexuspay_get_task using this taskId. Keep the same paymentId and identical parameters; never create a new paymentId to retry. If no local record appears, ask the owner to reconcile the escrow on Devnet before starting another payment.',
        ids,
      );
      const recordedResult = (detail: TaskDetailResponse): CallToolResult | null => {
        const existing = detail.payments.find((item) => item.paymentId === payment.paymentId);
        if (!existing) return null;
        if (existing.worker !== payment.worker || existing.serviceId !== payment.serviceId
          || existing.amountLamports !== payment.amountLamports || existing.requestHash !== payment.requestHash) {
          return fail('IDEMPOTENCY_CONFLICT', 'This paymentId already belongs to a different payment. Do not reuse it with changed parameters.', ids);
        }
        return ok({ task: summarizeTask(detail.task), payment: existing, reused: true });
      };
      let paymentSubmissionAttempted = false;
      try {
        // A recorded retry is a read, including after freeze, revoke or task closure.
        const existing = recordedResult(await api.get<TaskDetailResponse>(path));
        if (existing) return existing;
        paymentSubmissionAttempted = true;
        const result = await api.post<{ task: TaskCapabilityRecord; payment: TaskPaymentRecord }>(
          `${path}/payments`, payment,
        );
        return ok({ task: summarizeTask(result.task), payment: result.payment, reused: false });
      } catch (err) {
        // Keep the API's existing duplicate rejection. Recover an already-recorded identical
        // payment for MCP callers without submitting another transaction or changing its ID.
        if (err instanceof ApiError && err.code === 'payment_exists') {
          try {
            const detail = await api.get<TaskDetailResponse>(path);
            return recordedResult(detail) ?? outcomeUnknown();
          } catch (readError) {
            return handleError(readError, ids);
          }
        }
        // A failed initial GET cannot have created an escrow. Once POST starts, the
        // API's 502 does not distinguish pre-send errors from an unconfirmed send.
        if (paymentSubmissionAttempted
          && (err instanceof ApiUnreachableError || (err instanceof ApiError && err.status >= 500))) {
          return outcomeUnknown();
        }
        return handleError(err, ids);
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
        amountSol: amountInput('SOL amount, for example 0.05.'),
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
        amount: amountInput('Token amount in token units, not base units.'),
        idempotencyKey: idempotencyKeyInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ recipient, mint, amount, idempotencyKey }) =>
      submit({ type: 'transfer_spl', recipient, mint, amount }, idempotencyKey),
  );

  return server;
}
