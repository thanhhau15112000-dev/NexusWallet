import type {
  AuditEntryView,
  PaymentRequest,
  Policy,
  TaskCapabilityRecord,
  TaskPaymentRecord,
  TaskReceiptRecord,
} from '@nexus/shared';

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
  };
  policy: Policy & { maxSolPerTx: number };
};

export type AgentHealth = {
  ok: boolean;
  agentId: string;
  cluster: string;
  authRequired: boolean;
  models: { stage1: string; stage2: string; mode: string };
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

const API_OVERRIDE_KEY = 'nexus.apiBase';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normaliseApiBase(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !LOOPBACK_HOSTS.has(host) ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function readStoredApiBase(): string | null {
  try {
    const stored = window.localStorage.getItem(API_OVERRIDE_KEY);
    if (!stored) return null;
    const valid = normaliseApiBase(stored);
    if (valid) return valid;
    window.localStorage.removeItem(API_OVERRIDE_KEY);
  } catch {
    // Private browsing and restricted iframe contexts can deny storage access.
  }
  return null;
}

function persistApiBase(value: string): void {
  try {
    window.localStorage.setItem(API_OVERRIDE_KEY, value);
  } catch {
    // A query override still works for this page even when storage is blocked.
  }
}

/**
 * Local Vite and the agent use separate ports. Hosted mode serves both from one
 * origin; Codespaces forwards each port on its own hostname.
 */
export function resolveApiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('api');
  if (fromQuery) {
    const valid = normaliseApiBase(fromQuery);
    if (valid) {
      persistApiBase(valid);
      return valid;
    }
  }
  const stored = readStoredApiBase();
  if (stored) return stored;

  const { protocol, hostname } = window.location;
  if (/-\d+\.(app\.github\.dev|githubpreview\.dev)$/i.test(hostname)) {
    return `${protocol}//${hostname.replace(/-\d+\./, '-8787.')}`;
  }
  if (LOOPBACK_HOSTS.has(hostname.toLowerCase())) return `${protocol}//${hostname}:8787`;
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
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`agent returned an invalid response (${response.status})`);
    }
  }
  if (!response.ok) {
    const errorBody =
      body && typeof body === 'object' ? (body as { message?: unknown; error?: unknown }) : {};
    const message = typeof errorBody.message === 'string' ? errorBody.message : undefined;
    const code = typeof errorBody.error === 'string' ? errorBody.error : 'request failed';
    throw new ApiError(message ?? `${code} (${response.status})`, response.status, code);
  }
  return body as T;
}

export const api = {
  health: () => request<AgentHealth>('/api/health'),

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
