import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_DAILY_WINDOW_MS,
  defaultNotificationSettings,
  defaultPolicy,
  mayHaveMovedFunds,
  NotificationSettingsSchema,
  PolicySchema,
  TaskCapabilityRecordSchema,
  TaskPaymentRecordSchema,
  TaskReceiptRecordSchema,
  type NotificationSettings,
  type PaymentRequest,
  type Policy,
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
  type TelegramNotificationSettings,
} from '@nexus/shared';
import { z } from 'zod';

export type StoreData = {
  policy: Policy;
  ownerPubkey: string | null;
  requests: PaymentRequest[];
  /** idempotency key -> request id, so a retried command never sends twice. */
  idempotency: Record<string, string>;
  tasks?: Record<string, TaskCapabilityRecord>;
  payments?: Record<string, TaskPaymentRecord>;
  receipts?: Record<string, TaskReceiptRecord>;
  frozen?: { at: string } | null;
  notifications?: NotificationSettings;
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
      const frozen =
        raw.frozen && typeof raw.frozen === 'object' && typeof raw.frozen.at === 'string'
          ? { at: raw.frozen.at }
          : null;
      return {
        policy: PolicySchema.parse(raw.policy),
        ownerPubkey: raw.ownerPubkey ?? this.initialOwner ?? null,
        requests: Array.isArray(raw.requests) ? raw.requests : [],
        idempotency: raw.idempotency ?? {},
        tasks: raw.tasks ?? {},
        // Older state files keyed these by paymentId alone; re-key per task on load.
        payments: rekeyByTask(raw.payments ?? {}),
        receipts: rekeyByTask(raw.receipts ?? {}),
        frozen,
        notifications: raw.notifications
          ? NotificationSettingsSchema.parse(raw.notifications)
          : defaultNotificationSettings(),
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
        tasks: {},
        payments: {},
        receipts: {},
        frozen: null,
        notifications: defaultNotificationSettings(),
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
  setPolicy(
    next: Omit<Policy, 'version' | 'updatedAt' | 'agentId' | 'maxSolLamportsPerDay'> & {
      maxSolLamportsPerDay?: number | null;
    },
  ): Policy {
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

  isFrozen(): boolean {
    return Boolean(this.data.frozen);
  }

  getFrozen(): { at: string } | null {
    return this.data.frozen ?? null;
  }

  setFrozen(frozen: boolean, at?: string): { changed: boolean; frozen: { at: string } | null } {
    if (frozen) {
      if (this.data.frozen) {
        return { changed: false, frozen: this.data.frozen };
      }
      this.data.frozen = { at: at ?? new Date().toISOString() };
      this.flush();
      return { changed: true, frozen: this.data.frozen };
    }
    if (!this.data.frozen) {
      return { changed: false, frozen: null };
    }
    this.data.frozen = null;
    this.flush();
    return { changed: true, frozen: null };
  }

  setOwner(pubkey: string | null): void {
    this.data.ownerPubkey = pubkey;
    this.flush();
  }

  getNotificationSettings(): NotificationSettings {
    const base = this.data.notifications ?? defaultNotificationSettings();
    return {
      telegram: {
        ...base.telegram,
        events: { ...base.telegram.events },
      },
    };
  }

  setTelegramSettings(patch: {
    enabled?: boolean;
    events?: { pendingApproval?: boolean };
  }): TelegramNotificationSettings {
    const current = this.getNotificationSettings();
    const next = NotificationSettingsSchema.parse({
      ...current,
      telegram: {
        ...current.telegram,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        events: {
          ...current.telegram.events,
          ...(patch.events?.pendingApproval !== undefined
            ? { pendingApproval: patch.events.pendingApproval }
            : {}),
        },
      },
    });
    this.data.notifications = next;
    this.flush();
    return this.getNotificationSettings().telegram;
  }

  linkTelegram(input: {
    chatId: string;
    username: string | null;
    linkedAt?: string;
  }): TelegramNotificationSettings {
    const current = this.getNotificationSettings();
    const next = NotificationSettingsSchema.parse({
      ...current,
      telegram: {
        ...current.telegram,
        enabled: true,
        chatId: input.chatId,
        username: input.username,
        linkedAt: input.linkedAt ?? new Date().toISOString(),
        lastError: null,
      },
    });
    this.data.notifications = next;
    this.flush();
    return this.getNotificationSettings().telegram;
  }

  unlinkTelegram(): TelegramNotificationSettings {
    const current = this.getNotificationSettings();
    const next = NotificationSettingsSchema.parse({
      ...current,
      telegram: {
        ...current.telegram,
        chatId: null,
        username: null,
        linkedAt: null,
        lastError: null,
      },
    });
    this.data.notifications = next;
    this.flush();
    return this.getNotificationSettings().telegram;
  }

  setTelegramError(error: string | null): void {
    const current = this.getNotificationSettings();
    if (current.telegram.lastError === error) return;
    this.data.notifications = {
      ...current,
      telegram: {
        ...current.telegram,
        lastError: error,
      },
    };
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
      this.prune();
    }
    this.flush();
    return next;
  }

  /**
   * Keeps the request list near `maxRequests`, oldest first, but never drops a request that the
   * 24-hour SOL limit or a retry still depends on: SOL and SPL transfers that moved, or may have
   * moved, funds inside the window, and requests that have not reached a final status. When only
   * those remain the list may exceed the cap.
   */
  private prune(now = Date.now()): void {
    let excess = this.data.requests.length - this.maxRequests;
    if (excess <= 0) return;
    const cutoff = now - DEFAULT_DAILY_WINDOW_MS;
    const kept: PaymentRequest[] = [];
    for (const request of this.data.requests) {
      if (excess > 0 && !isLoadBearing(request, cutoff)) {
        if (request.idempotencyKey) delete this.data.idempotency[request.idempotencyKey];
        excess -= 1;
        continue;
      }
      kept.push(request);
    }
    this.data.requests = kept;
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

  getPayment(taskId: string, paymentId: string): TaskPaymentRecord | undefined {
    return this.data.payments?.[taskRecordKey(taskId, paymentId)];
  }

  setPayment(payment: TaskPaymentRecord, options?: { allowOverwrite?: boolean }): void {
    if (!this.data.payments) this.data.payments = {};
    const key = taskRecordKey(payment.taskId, payment.paymentId);
    if (this.data.payments[key] && !options?.allowOverwrite) {
      throw new Error(`Payment with id '${payment.paymentId}' already exists`);
    }
    this.data.payments[key] = TaskPaymentRecordSchema.parse(payment);
    this.flush();
  }

  getReceipts(taskId?: string): TaskReceiptRecord[] {
    const all = Object.values(this.data.receipts ?? {});
    return taskId ? all.filter((r) => r.taskId === taskId) : all;
  }

  getReceipt(taskId: string, paymentId: string): TaskReceiptRecord | undefined {
    return this.data.receipts?.[taskRecordKey(taskId, paymentId)];
  }

  setReceipt(receipt: TaskReceiptRecord, options?: { allowOverwrite?: boolean }): void {
    if (!this.data.receipts) this.data.receipts = {};
    const key = taskRecordKey(receipt.taskId, receipt.paymentId);
    if (this.data.receipts[key] && !options?.allowOverwrite) {
      throw new Error(`Receipt for payment '${receipt.paymentId}' already exists`);
    }
    this.data.receipts[key] = TaskReceiptRecordSchema.parse(receipt);
    this.flush();
  }
}

const IN_FLIGHT_STATUSES = new Set(['planned', 'pending_approval', 'approved', 'auto_approved']);

function isLoadBearing(request: PaymentRequest, cutoff: number): boolean {
  if (IN_FLIGHT_STATUSES.has(request.status)) return true;
  return mayHaveMovedFunds(request) && new Date(request.createdAt).getTime() >= cutoff;
}

// Payment ids are scoped per task on-chain (escrow/receipt PDA seeds), so records are too.
function taskRecordKey(taskId: string, paymentId: string): string {
  return JSON.stringify([taskId, paymentId]);
}

function rekeyByTask<T extends { taskId: string; paymentId: string }>(records: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.values(records).map((record) => [taskRecordKey(record.taskId, record.paymentId), record]));
}
