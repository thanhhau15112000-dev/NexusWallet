import type {
  AuditEntryView,
  PaymentRequest,
  Policy,
  TaskCapabilityRecord,
  TaskPaymentRecord,
  TaskReceiptRecord,
} from '@nexus/shared';
import { getCurrentDictionary } from './i18n/context.js';

export type AgentState = {
  cluster: string;
  rpcUrl: string;
  models: { stage1: string; stage2: string; mode: string };
  owner: string | null;
  ownerPinned: boolean;
  isAdmin?: boolean;
  claimedInitialFunding?: boolean;
  masterFunder?: {
    pubkey: string;
    lamports: number | null;
  } | null;
  mockWorker?: { pubkey: string } | null;
  agent: {
    agentId: string;
    pubkey: string;
    lamports: number | null;
    rpcError: string | null;
    explorerUrl: string;
    frozen?: boolean;
    frozenAt?: string | null;
  };
  policy: Policy & { maxSolPerTx: number; maxSolPerDay?: number | null };
  usage?: { spentSol24h: number; remainingSol24h: number | null };
};

export type AgentHistoryItem = {
  signature: string;
  blockTime: number | null;
  status: 'confirmed' | 'failed';
  deltaLamports: number;
  balanceAfterLamports: number;
  feeLamports: number;
  explorerUrl: string;
};

export type AgentHealth = {
  ok: boolean;
  agentId: string;
  cluster: string;
  authRequired: boolean;
  models: { stage1: string; stage2: string; mode: string };
  commit?: string | null;
};

export type AuthSession = {
  authenticated: boolean;
  owner: string | null;
  expiresAt: string | null;
  isAdmin?: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The dashboard always calls the agent on its own origin: hosted mode serves both from one
 * origin, and in development Vite proxies /api to the agent (vite.config.ts). A cross-origin
 * API base would drop the session cookie, so every call after login would return 401.
 */
export function resolveApiBase(): string {
  try {
    // Older builds persisted a cross-origin API base override; it breaks sessions, so drop it.
    window.localStorage.removeItem('nexus.apiBase');
  } catch {
    // Private browsing and restricted iframe contexts can deny storage access.
  }
  return window.location.origin;
}

export const API_BASE = resolveApiBase();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  // The agent always answers errors with a JSON `error` field. A 5xx without one comes from
  // the dev proxy (or a hosting layer) when the agent service itself is down.
  const hasErrorField = Boolean(body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string');
  if (response.status >= 500 && !hasErrorField) {
    throw new Error('nexusPay agent service is not reachable. Start it with pnpm dev from the repository root, then reload.');
  }
  if (text && body === null) {
    throw new Error(`agent returned an invalid response (${response.status})`);
  }
  body ??= {};
  if (!response.ok) {
    const errorBody =
      body && typeof body === 'object' ? (body as { message?: unknown; error?: unknown }) : {};
    const message = typeof errorBody.message === 'string' ? errorBody.message : undefined;
    const code = typeof errorBody.error === 'string' ? errorBody.error : 'request failed';
    if (response.status === 429 && code === 'RATE_LIMITED') {
      const seconds = Number(response.headers.get('retry-after')) || 1;
      const template = getCurrentDictionary().apiErrors.rateLimited;
      throw new ApiError(template.replace('{seconds}', String(seconds)), response.status, code);
    }
    if (response.status === 429 && code === 'seed_cap_reached') {
      throw new ApiError(getCurrentDictionary().apiErrors.seedCapReached, response.status, code);
    }
    throw new ApiError(message ?? `${code} (${response.status})`, response.status, code);
  }
  return body as T;
}

/**
 * Remote MCP connection for one owner: a URL plus the MCP token as a bearer header. Hosted mode returns
 * the token only from the create/rotate call; local mode also returns it when the config is read.
 */
export type McpClientConfig = {
  owner: string;
  url: string;
  hasToken: true;
  token: string;
  claudeCode: string;
  codexToml: string;
  antigravityJson: string;
  claudeDesktopJson: string;
};

/** What a hosted agent says about an owner's token when it cannot show it: only whether one exists. */
export type McpTokenStatus = { owner: string; url: string; hasToken: boolean; token: null };

export const api = {
  health: () => request<AgentHealth>('/api/health'),

  mcpConfig: () => request<McpClientConfig | McpTokenStatus>('/api/mcp/config'),

  rotateMcpToken: () =>
    request<McpClientConfig>('/api/mcp/token/rotate', { method: 'POST', body: JSON.stringify({}) }),

  authSession: () => request<AuthSession>('/api/auth/session'),

  authChallenge: (pubkey: string) =>
    request<{ challengeId: string; message: string; expiresAt: string }>('/api/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ pubkey }),
    }),

  authLogin: (input: { challengeId: string; pubkey: string; signature: string }) =>
    request<{ authenticated: true; owner: string; expiresAt: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  authLogout: () =>
    request<{ authenticated: false }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  state: () => request<AgentState>('/api/state'),

  bindOwner: (pubkey: string) =>
    request<{ owner: string }>('/api/owner', {
      method: 'POST',
      body: JSON.stringify({ pubkey }),
    }),

  savePolicy: (input: {
    maxSolPerTx: number;
    maxSolPerDay?: number | null;
    allowedRecipients: { label: string; address: string }[];
    allowedMints: { label: string; address: string }[];
    maxTokenAmountByMint: Record<string, number>;
  }) =>
    request<{ policy: AgentState['policy'] }>('/api/policy', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  airdrop: (sol: number) =>
    request<{ signature: string; lamports: number }>('/api/agent/airdrop', {
      method: 'POST',
      body: JSON.stringify({ sol }),
    }),

  claimSeed: () =>
    request<{ signature: string; lamports: number; claimedInitialFunding: boolean }>(
      '/api/agent/claim-seed',
      { method: 'POST', body: JSON.stringify({}) },
    ),

  freeze: () =>
    request<{ frozen: boolean; frozenAt: string | null }>('/api/agent/freeze', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  unfreeze: () =>
    request<{ frozen: boolean; frozenAt: string | null }>('/api/agent/unfreeze', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  command: (prompt: string, idempotencyKey?: string) =>
    request<{ request: PaymentRequest }>('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ prompt, idempotencyKey }),
    }),

  requests: () => request<{ requests: PaymentRequest[] }>('/api/requests'),

  approve: (id: string, signature: string, signerPubkey: string) =>
    request<{ request: PaymentRequest }>(`/api/requests/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ signature, signerPubkey }),
    }),

  agentHistory: (options: { before?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.before) query.set('before', options.before);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.toString();
    return request<{ items: AgentHistoryItem[]; nextBefore: string | null }>(
      `/api/agent/history${suffix ? `?${suffix}` : ''}`,
    );
  },

  cancelRequest: (id: string) =>
    request<{ request: PaymentRequest }>(`/api/requests/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),

  audit: (limit = 60) => request<{ entries: AuditEntryView[] }>(`/api/audit?limit=${limit}`),
  tasks: () => request<{ tasks: TaskCapabilityRecord[] }>('/api/tasks'),
  taskDetail: (taskId: string) =>
    request<{
      task: TaskCapabilityRecord;
      payments: TaskPaymentRecord[];
      receipts: TaskReceiptRecord[];
    }>(`/api/tasks/${taskId}`),
  createTask: (input: {
    taskId: string;
    budgetLamports: number;
    perPaymentCapLamports: number;
    expiry: number;
    allowedWorker?: string;
    allowedServiceId?: string;
    txSignature?: string;
    isSimulated?: boolean;
  }) =>
    request<{ task: TaskCapabilityRecord }>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  executeTaskPayment: (
    taskId: string,
    input: {
      paymentId: string;
      worker: string;
      serviceId: string;
      amountLamports: number;
      requestHash: string;
      txSignature?: string;
      isSimulated?: boolean;
    },
  ) =>
    request<{ task: TaskCapabilityRecord; payment: TaskPaymentRecord }>(
      `/api/tasks/${taskId}/payments`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  settleTaskPayment: (
    taskId: string,
    paymentId: string,
    input: {
      resultHash: string;
      workerPubkey: string;
      workerSignature: string;
      txSignature?: string;
      isSimulated?: boolean;
    },
  ) =>
    request<{ payment: TaskPaymentRecord; receipt: TaskReceiptRecord }>(
      `/api/tasks/${taskId}/payments/${paymentId}/settle`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  closeTaskReceipt: (taskId: string, paymentId: string, txSignature: string) =>
    request<{ receipt: TaskReceiptRecord }>(
      `/api/tasks/${taskId}/receipts/${paymentId}/close`,
      { method: 'POST', body: JSON.stringify({ txSignature }) },
    ),
  revokeTask: (taskId: string, txSignature?: string) =>
    request<{ task: TaskCapabilityRecord }>(`/api/tasks/${taskId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ txSignature }),
    }),
  refundTask: (taskId: string, txSignature?: string) =>
    request<{ task: TaskCapabilityRecord; refundedLamports: number }>(
      `/api/tasks/${taskId}/refund`,
      { method: 'POST', body: JSON.stringify({ txSignature }) },
    ),
  runMockService: (input: { taskId: string; paymentId?: string; serviceId: string; payload?: Record<string, unknown> }) =>
    request<{
      serviceId: string;
      workerPubkey: string;
      workerSignature: string;
      requestHash: string;
      resultHash: string;
      resultPayload: unknown;
    }>('/api/tasks/mock-service/run', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
