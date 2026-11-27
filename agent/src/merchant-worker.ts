import { PublicKey, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

/** What a worker hands back for a job: the output, its hash, and its receipt signature. */
export type WorkerOutput = {
  workerPubkey: string;
  workerSignature: string;
  resultHash: string;
  resultPayload: Record<string, unknown>;
};

export type MerchantJob = {
  owner: string;
  taskId: string;
  paymentId: string;
  serviceId: string;
  requestHash: string;
  scenario: 'valid' | 'invalid_schema';
};

export class MerchantWorkerError extends Error {
  constructor(readonly code: string) {
    super(`merchant worker: ${code}`);
  }
}

/** The merchant's worker key, and the wallet its x402 endpoints are paid to. */
export type MerchantInfo = { pubkey: string; wallet: string | null };

/** The demo merchant acting as a remote Task Vault worker (demo-merchant `/worker` routes). */
export type MerchantWorker = {
  /** Its keys, or null when the merchant does not answer or has no worker key. */
  info(): Promise<MerchantInfo | null>;
  /** Its signing key, or null when the merchant does not answer or has no worker key. */
  pubkey(): Promise<string | null>;
  runJob(job: MerchantJob): Promise<WorkerOutput>;
  /** Asks the merchant to co-sign a settlement the agent built, and adds its signature. */
  coSignSettlement(transaction: Transaction): Promise<void>;
};

const PUBKEY_TTL_MS = 5 * 60_000;
const PUBKEY_FAILURE_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The key lookup sits on the state read, so it gives up sooner than a job or settlement. */
const PUBKEY_TIMEOUT_MS = 5_000;

export function createMerchantWorker(baseUrl: string, fetchImpl: typeof fetch = fetch, now = Date.now): MerchantWorker {
  const root = baseUrl.replace(/\/+$/, '');
  let cached: { info: MerchantInfo | null; until: number } | null = null;

  async function call<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new MerchantWorkerError('unreachable');
    }
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || !body) throw new MerchantWorkerError(body?.error ?? `http_${res.status}`);
    return body;
  }

  return {
    async info() {
      if (cached && cached.until > now()) return cached.info;
      try {
        const body = await call<{ pubkey: string; wallet?: unknown }>('/worker', undefined, PUBKEY_TIMEOUT_MS);
        const pubkey = new PublicKey(body.pubkey).toBase58();
        cached = { info: { pubkey, wallet: walletOrNull(body.wallet) }, until: now() + PUBKEY_TTL_MS };
      } catch {
        cached = { info: null, until: now() + PUBKEY_FAILURE_TTL_MS };
      }
      return cached.info;
    },

    async pubkey() {
      return (await this.info())?.pubkey ?? null;
    },

    async runJob(job) {
      const output = await call<WorkerOutput>('/worker/jobs', { method: 'POST', body: JSON.stringify(job) });
      if (output.workerPubkey !== (await this.pubkey())) throw new MerchantWorkerError('worker_key_changed');
      return output;
    },

    async coSignSettlement(transaction) {
      const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      const body = await call<{ workerPubkey: string; signature: string }>('/worker/settlements', {
        method: 'POST',
        body: JSON.stringify({ transaction: serialized.toString('base64') }),
      });
      transaction.addSignature(new PublicKey(body.workerPubkey), Buffer.from(bs58.decode(body.signature)));
      if (!transaction.verifySignatures()) throw new MerchantWorkerError('invalid_settlement_signature');
    },
  };
}

/** A merchant that does not publish a valid wallet still works as a worker; it just cannot be allowlisted from here. */
function walletOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}
