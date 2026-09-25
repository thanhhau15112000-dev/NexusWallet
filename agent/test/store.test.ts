import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentRequest } from '@nexus/shared';
import { Store } from '../src/store.js';

describe('Store', () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nexus-store-test-'));
    statePath = join(tempDir, 'state.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
    const now = new Date().toISOString();
    return {
      id: `req_${Math.random().toString(36).slice(2, 10)}`,
      agentId: 'agent-001',
      createdAt: now,
      updatedAt: now,
      status: 'pending_approval',
      prompt: 'Send 0.5 SOL to treasury',
      idempotencyKey: null,
      intent: null,
      plan: null,
      decision: null,
      modelTrace: null,
      approval: {
        payload: {
          requestId: 'req_123',
          agentId: 'agent-001',
          policyVersion: 1,
          actionType: 'transfer_sol',
          recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
          amount: 500_000_000,
          mint: 'native',
          nonce: 'nonce12345678',
          expiresAt: '2030-01-01T00:00:00.000Z',
        },
        message: 'nexusPay approval',
        signature: null,
        signerPubkey: null,
        signedAt: null,
        consumedAt: null,
      },
      execution: null,
      balanceLamports: null,
      error: null,
      ...overrides,
    };
  }

  it('persists policy, owner, and pending requests across restarts', () => {
    const store1 = new Store(statePath, 'agent-001', 50);
    store1.setOwner('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    store1.setPolicy({
      maxSolLamportsPerTx: 200_000_000,
      allowedRecipients: [{ label: 'treasury', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    const req = makeRequest({ id: 'req_pending_1', idempotencyKey: 'idem_key_1' });
    store1.putRequest(req);

    // Simulate agent restart: instantiate new Store from the same statePath
    const store2 = new Store(statePath, 'agent-001', 50);

    expect(store2.getOwner()).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
    expect(store2.getPolicy().version).toBe(2);
    expect(store2.getPolicy().maxSolLamportsPerTx).toBe(200_000_000);

    const reloadedReq = store2.getRequest('req_pending_1');
    expect(reloadedReq).toBeDefined();
    expect(reloadedReq?.status).toBe('pending_approval');
    expect(reloadedReq?.approval?.payload.amount).toBe(500_000_000);

    const byIdem = store2.findByIdempotencyKey('idem_key_1');
    expect(byIdem?.id).toBe('req_pending_1');
  });

  it('persists pending seed transfer and clears it only when marked claimed', () => {
    const store1 = new Store(statePath, 'agent-001', 50);
    const pending = {
      signature: 'seed-signature',
      serializedTransaction: 'c2lnbmVkLXRyYW5zYWN0aW9u',
      blockhash: 'blockhash',
      lastValidBlockHeight: 123,
      recipientPubkey: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      amountLamports: 100_000_000,
    };

    store1.setPendingInitialFunding(pending);
    const storeAfterRestart = new Store(statePath, 'agent-001', 50);
    expect(storeAfterRestart.getPendingInitialFunding()).toEqual(pending);

    storeAfterRestart.setClaimedInitialFunding(true);
    const storeAfterConfirmation = new Store(statePath, 'agent-001', 50);
    expect(storeAfterConfirmation.hasClaimedInitialFunding()).toBe(true);
    expect(storeAfterConfirmation.getPendingInitialFunding()).toBeUndefined();
  });

  it('prevents duplicate requests via idempotency key', () => {
    const store = new Store(statePath, 'agent-001', 50);

    expect(store.findByIdempotencyKey('key_abc')).toBeUndefined();

    const req1 = makeRequest({ id: 'req_idem_1', idempotencyKey: 'key_abc' });
    store.putRequest(req1);

    const found = store.findByIdempotencyKey('key_abc');
    expect(found?.id).toBe('req_idem_1');
  });

  it('throws on corrupt state file instead of wiping data', () => {
    writeFileSync(statePath, '{ corrupt json invalid ...');

    expect(() => new Store(statePath, 'agent-001', 50)).toThrow(/not valid JSON/);
  });

  it('prunes oldest requests and removes their idempotency keys when exceeding limit', () => {
    const store = new Store(statePath, 'agent-001', 2);

    store.putRequest(makeRequest({ id: 'req_1', idempotencyKey: 'idem_1' }));
    store.putRequest(makeRequest({ id: 'req_2', idempotencyKey: 'idem_2' }));
    expect(store.listRequests()).toHaveLength(2);

    store.putRequest(makeRequest({ id: 'req_3', idempotencyKey: 'idem_3' }));
    expect(store.listRequests()).toHaveLength(2);

    expect(store.getRequest('req_1')).toBeUndefined();
    expect(store.findByIdempotencyKey('idem_1')).toBeUndefined();
    expect(store.getRequest('req_3')).toBeDefined();
    expect(store.findByIdempotencyKey('idem_3')?.id).toBe('req_3');
  });
});
