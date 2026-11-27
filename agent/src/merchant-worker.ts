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

/** The demo merchant acting as a remote Task Vault worker (demo-merchant `/worker` routes). */
export type MerchantWorker = {
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
  let cached: { pubkey: string | null; until: number } | null = null;

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
    async pubkey() {
      if (cached && cached.until > now()) return cached.pubkey;
      try {
        const body = await call<{ pubkey: string }>('/worker', undefined, PUBKEY_TIMEOUT_MS);
        const pubkey = new PublicKey(body.pubkey).toBase58();
        cached = { pubkey, until: now() + PUBKEY_TTL_MS };
      } catch {
        cached = { pubkey: null, until: now() + PUBKEY_FAILURE_TTL_MS };
      }
      return cached.pubkey;
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
