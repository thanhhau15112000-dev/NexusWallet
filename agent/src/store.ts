import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultPolicy, PolicySchema, type PaymentRequest, type Policy } from '@nexus/shared';

export type StoreData = {
  policy: Policy;
  ownerPubkey: string | null;
  requests: PaymentRequest[];
  /** idempotency key -> request id, so a retried command never sends twice. */
  idempotency: Record<string, string>;
  claimedInitialFunding?: boolean;
};

/**
 * Small synchronous JSON store. The whole dataset is a few hundred kilobytes at
 * most, and writing it atomically (tmp file + rename) keeps state consistent
 * across a container restart without pulling in a database.
 */
export class Store {
  private data: StoreData;

  constructor(
    private readonly path: string,
    private readonly agentId: string,
    private readonly maxRequests: number,
    private readonly initialOwner?: string,
  ) {
    this.data = this.read();
  }

  private read(): StoreData {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as StoreData;
      return {
        policy: PolicySchema.parse(raw.policy),
        ownerPubkey: raw.ownerPubkey ?? this.initialOwner ?? null,
        requests: Array.isArray(raw.requests) ? raw.requests : [],
        idempotency: raw.idempotency ?? {},
        claimedInitialFunding: Boolean(raw.claimedInitialFunding),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt or schema-drifted state file must not silently wipe history.
        if (!(err instanceof SyntaxError)) throw err;
        throw new Error(`state file ${this.path} is not valid JSON; move it aside to reset`);
      }
      const policy = defaultPolicy(this.agentId);
      if (this.initialOwner) {
        policy.allowedRecipients = [{ label: 'my-wallet', address: this.initialOwner }];
      }
      return {
        policy,
        ownerPubkey: this.initialOwner ?? null,
        requests: [],
        idempotency: {},
        claimedInitialFunding: false,
      };
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  getPolicy(): Policy {
    return this.data.policy;
  }

  /** Every policy write bumps the version; pending approvals bound to an older version die with it. */
  setPolicy(next: Omit<Policy, 'version' | 'updatedAt' | 'agentId'>): Policy {
    this.data.policy = PolicySchema.parse({
      ...next,
      agentId: this.agentId,
      version: this.data.policy.version + 1,
      updatedAt: new Date().toISOString(),
    });
    this.flush();
    return this.data.policy;
  }

  getOwner(): string | null {
    return this.data.ownerPubkey;
  }

  hasClaimedInitialFunding(): boolean {
    return Boolean(this.data.claimedInitialFunding);
  }

  setClaimedInitialFunding(claimed: boolean): void {
    this.data.claimedInitialFunding = claimed;
    this.flush();
  }

  setOwner(pubkey: string | null): void {
    this.data.ownerPubkey = pubkey;
    this.flush();
  }

  getRequest(id: string): PaymentRequest | undefined {
    return this.data.requests.find((r) => r.id === id);
  }

  findByIdempotencyKey(key: string): PaymentRequest | undefined {
    const id = this.data.idempotency[key];
    return id ? this.getRequest(id) : undefined;
  }

  listRequests(): PaymentRequest[] {
    return [...this.data.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  putRequest(request: PaymentRequest): PaymentRequest {
    const index = this.data.requests.findIndex((r) => r.id === request.id);
    const next = { ...request, updatedAt: new Date().toISOString() };
    if (index >= 0) {
      this.data.requests[index] = next;
    } else {
      this.data.requests.push(next);
      if (request.idempotencyKey) {
        this.data.idempotency[request.idempotencyKey] = request.id;
      }
      if (this.data.requests.length > this.maxRequests) {
        const dropped = this.data.requests.splice(0, this.data.requests.length - this.maxRequests);
        for (const item of dropped) {
          if (item.idempotencyKey) delete this.data.idempotency[item.idempotencyKey];
        }
      }
    }
    this.flush();
    return next;
  }
}
