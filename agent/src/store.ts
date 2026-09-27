import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  defaultPolicy,
  PolicySchema,
  TaskCapabilityRecordSchema,
  TaskPaymentRecordSchema,
  TaskReceiptRecordSchema,
  type PaymentRequest,
  type Policy,
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
} from '@nexus/shared';
import { z } from 'zod';

const PendingInitialFundingSchema = z.object({
  signature: z.string().min(1),
  serializedTransaction: z.string().min(1),
  blockhash: z.string().min(1),
  lastValidBlockHeight: z.number().int().nonnegative(),
  recipientPubkey: z.string().min(32).max(44),
  amountLamports: z.number().int().positive(),
});

export type PendingInitialFunding = z.infer<typeof PendingInitialFundingSchema>;

export type StoreData = {
  policy: Policy;
  ownerPubkey: string | null;
  requests: PaymentRequest[];
  /** idempotency key -> request id, so a retried command never sends twice. */
  idempotency: Record<string, string>;
  claimedInitialFunding?: boolean;
  pendingInitialFunding?: PendingInitialFunding;
  tasks?: Record<string, TaskCapabilityRecord>;
  payments?: Record<string, TaskPaymentRecord>;
  receipts?: Record<string, TaskReceiptRecord>;
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
      const claimedInitialFunding = Boolean(raw.claimedInitialFunding);
      return {
        policy: PolicySchema.parse(raw.policy),
        ownerPubkey: raw.ownerPubkey ?? this.initialOwner ?? null,
        requests: Array.isArray(raw.requests) ? raw.requests : [],
        idempotency: raw.idempotency ?? {},
        claimedInitialFunding,
        pendingInitialFunding: claimedInitialFunding || raw.pendingInitialFunding === undefined
          ? undefined
          : PendingInitialFundingSchema.parse(raw.pendingInitialFunding),
        tasks: raw.tasks ?? {},
        payments: raw.payments ?? {},
        receipts: raw.receipts ?? {},
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
        tasks: {},
        payments: {},
        receipts: {},
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

  getPendingInitialFunding(): PendingInitialFunding | undefined {
    return this.data.pendingInitialFunding;
  }

  setPendingInitialFunding(pending: PendingInitialFunding): void {
    if (this.hasClaimedInitialFunding()) {
      throw new Error('initial funding has already been claimed');
    }
    this.data.pendingInitialFunding = PendingInitialFundingSchema.parse(pending);
    this.flush();
  }

  clearPendingInitialFunding(): void {
    delete this.data.pendingInitialFunding;
    this.flush();
  }

  setClaimedInitialFunding(claimed: boolean): void {
    this.data.claimedInitialFunding = claimed;
    if (claimed) delete this.data.pendingInitialFunding;
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

  getTasks(): TaskCapabilityRecord[] {
    return Object.values(this.data.tasks ?? {});
  }

  getTask(taskId: string): TaskCapabilityRecord | undefined {
    return this.data.tasks?.[taskId];
  }

  setTask(task: TaskCapabilityRecord, options?: { allowOverwrite?: boolean }): void {
    if (!this.data.tasks) this.data.tasks = {};
    if (this.data.tasks[task.taskId] && !options?.allowOverwrite) {
      throw new Error(`Task with id '${task.taskId}' already exists`);
    }
    this.data.tasks[task.taskId] = TaskCapabilityRecordSchema.parse(task);
    this.flush();
  }

  getPayments(taskId?: string): TaskPaymentRecord[] {
    const all = Object.values(this.data.payments ?? {});
    return taskId ? all.filter((p) => p.taskId === taskId) : all;
  }

  getPayment(paymentId: string): TaskPaymentRecord | undefined {
    return this.data.payments?.[paymentId];
  }

  setPayment(payment: TaskPaymentRecord, options?: { allowOverwrite?: boolean }): void {
    if (!this.data.payments) this.data.payments = {};
    if (this.data.payments[payment.paymentId] && !options?.allowOverwrite) {
      throw new Error(`Payment with id '${payment.paymentId}' already exists`);
    }
    this.data.payments[payment.paymentId] = TaskPaymentRecordSchema.parse(payment);
    this.flush();
  }

  getReceipts(taskId?: string): TaskReceiptRecord[] {
    const all = Object.values(this.data.receipts ?? {});
    return taskId ? all.filter((r) => r.taskId === taskId) : all;
  }

  getReceipt(paymentId: string): TaskReceiptRecord | undefined {
    return this.data.receipts?.[paymentId];
  }

  setReceipt(receipt: TaskReceiptRecord, options?: { allowOverwrite?: boolean }): void {
    if (!this.data.receipts) this.data.receipts = {};
    if (this.data.receipts[receipt.paymentId] && !options?.allowOverwrite) {
      throw new Error(`Receipt for payment '${receipt.paymentId}' already exists`);
    }
    this.data.receipts[receipt.paymentId] = TaskReceiptRecordSchema.parse(receipt);
    this.flush();
  }
}
