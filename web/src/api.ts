import type { AuditEntryView, PaymentRequest, Policy } from '@nexus/shared';

export type AgentState = {
  cluster: string;
  rpcUrl: string;
  models: { stage1: string; stage2: string; mode: string };
  owner: string | null;
  ownerPinned: boolean;
  agent: {
    agentId: string;
    pubkey: string;
    lamports: number | null;
    rpcError: string | null;
    explorerUrl: string;
  };
  policy: Policy & { maxSolPerTx: number };
};

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
 * The agent API lives on a different port than the dev server. Codespaces
 * forwards each port on its own hostname (`<name>-5173.app.github.dev`), so the
 * port is swapped in the hostname rather than appended.
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
  return `${protocol}//${hostname}:8787`;
}

export const API_BASE = resolveApiBase();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
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
    throw new Error(message ?? `${code} (${response.status})`);
  }
  return body as T;
}

export const api = {
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
};
