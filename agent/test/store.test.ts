import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPolicy, evaluatePolicy, spentLamportsInWindow, type PaymentRequest } from '@nexus/shared';
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

  it('loads a request written before error remediation and details were added', () => {
    const store = new Store(statePath, 'agent-001', 50);
    store.putRequest(makeRequest({
      id: 'req_legacy_error',
      status: 'denied',
      approval: null,
      error: { code: 'RECIPIENT_NOT_IN_ALLOWLIST', message: 'recipient is not on the allowlist' },
    }));

    const reloaded = new Store(statePath, 'agent-001', 50).getRequest('req_legacy_error');
    expect(reloaded?.status).toBe('denied');
    expect(reloaded?.error).toEqual({
      code: 'RECIPIENT_NOT_IN_ALLOWLIST',
      message: 'recipient is not on the allowlist',
    });
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
    const denied = { status: 'denied' as const, approval: null };

    store.putRequest(makeRequest({ id: 'req_1', idempotencyKey: 'idem_1', ...denied }));
    store.putRequest(makeRequest({ id: 'req_2', idempotencyKey: 'idem_2', ...denied }));
    expect(store.listRequests()).toHaveLength(2);

    store.putRequest(makeRequest({ id: 'req_3', idempotencyKey: 'idem_3', ...denied }));
    expect(store.listRequests()).toHaveLength(2);

    expect(store.getRequest('req_1')).toBeUndefined();
    expect(store.findByIdempotencyKey('idem_1')).toBeUndefined();
    expect(store.getRequest('req_3')).toBeDefined();
    expect(store.findByIdempotencyKey('idem_3')?.id).toBe('req_3');
  });

  describe('pruning keeps what the 24-hour SOL limit and retries depend on', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

    function solSpend(id: string, lamports: number, createdAt = new Date().toISOString()): PaymentRequest {
      return makeRequest({
        id,
        createdAt,
        status: 'confirmed',
        idempotencyKey: `idem_${id}`,
        approval: null,
        decision: {
          verdict: 'allow',
          policyVersion: 1,
          reasons: [],
          resolved: { type: 'transfer_sol', recipient: WALLET, recipientLabel: 'my-wallet', lamports },
        },
      });
    }

    function balanceCheck(id: string): PaymentRequest {
      return makeRequest({ id, status: 'confirmed', approval: null, balanceLamports: 1, prompt: 'check balance' });
    }

    it('keeps counted SOL spends after 200 balance requests, so the daily limit still applies', () => {
      const store = new Store(statePath, 'agent-001', 200);
      for (let i = 0; i < 10; i += 1) store.putRequest(solSpend(`spend_${i}`, 100_000_000));
      for (let i = 0; i < 200; i += 1) store.putRequest(balanceCheck(`balance_${i}`));

      const spent = spentLamportsInWindow(store.listRequests());
      expect(spent).toBe(1_000_000_000);
      const policy = {
        ...defaultPolicy('agent-001'),
        maxSolLamportsPerDay: 200_000_000,
        allowedRecipients: [{ label: 'my-wallet', address: WALLET }],
      };
      const decision = evaluatePolicy(policy, { type: 'transfer_sol', recipient: 'my-wallet', amountSol: 0.05 }, { spentLamports24h: spent });
      expect(decision.verdict).toBe('require_approval');
      expect(decision.code).toBe('DAILY_LIMIT_EXCEEDED');
    });

    it('keeps the idempotency key of a counted spend, so a retry returns the original request', () => {
      const store = new Store(statePath, 'agent-001', 200);
      store.putRequest(solSpend('spend_1', 50_000_000));
      for (let i = 0; i < 200; i += 1) store.putRequest(balanceCheck(`balance_${i}`));

      expect(store.findByIdempotencyKey('idem_spend_1')?.id).toBe('spend_1');
    });

    it('lets a counted spend go once it is older than the 24-hour window', () => {
      const store = new Store(statePath, 'agent-001', 2);
      store.putRequest(solSpend('old_spend', 50_000_000, new Date(Date.now() - DAY_MS - 60_000).toISOString()));
      store.putRequest(balanceCheck('balance_1'));
      store.putRequest(balanceCheck('balance_2'));

      expect(store.getRequest('old_spend')).toBeUndefined();
      expect(store.findByIdempotencyKey('idem_old_spend')).toBeUndefined();
    });

    it('keeps a pending approval until it reaches a final status', () => {
      const store = new Store(statePath, 'agent-001', 1);
      store.putRequest(makeRequest({ id: 'pending_1' }));
      store.putRequest(balanceCheck('balance_1'));
      store.putRequest(balanceCheck('balance_2'));
      expect(store.getRequest('pending_1')).toBeDefined();

      store.putRequest({ ...store.getRequest('pending_1')!, status: 'expired' });
      store.putRequest(balanceCheck('balance_3'));
      expect(store.getRequest('pending_1')).toBeUndefined();
    });

    function splTransfer(
      id: string,
      overrides: Partial<PaymentRequest> = {},
      createdAt = new Date().toISOString(),
    ): PaymentRequest {
      return makeRequest({
        id,
        createdAt,
        status: 'confirmed',
        idempotencyKey: `idem_${id}`,
        approval: null,
        decision: {
          verdict: 'allow',
          policyVersion: 1,
          reasons: [],
          resolved: {
            type: 'transfer_spl',
            recipient: WALLET,
            recipientLabel: 'my-wallet',
            mint: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
            mintLabel: 'usdc',
            amount: 5,
          },
        },
        ...overrides,
      });
    }

    const executionFailed = {
      status: 'failed' as const,
      error: { code: 'execution_failed', message: 'RPC timeout after send' },
    };

    it('keeps SPL transfers that moved or may have moved funds, so a retry returns the original request', () => {
      const store = new Store(statePath, 'agent-001', 200);
      store.putRequest(splTransfer('spl_confirmed'));
      store.putRequest(splTransfer('spl_failed', executionFailed));
      for (let i = 0; i < 200; i += 1) store.putRequest(balanceCheck(`balance_${i}`));

      expect(store.findByIdempotencyKey('idem_spl_confirmed')?.id).toBe('spl_confirmed');
      expect(store.findByIdempotencyKey('idem_spl_failed')?.id).toBe('spl_failed');
    });

    it('lets an SPL transfer go once it is older than the 24-hour window', () => {
      const store = new Store(statePath, 'agent-001', 2);
      store.putRequest(splTransfer('old_spl', {}, new Date(Date.now() - DAY_MS - 60_000).toISOString()));
      store.putRequest(balanceCheck('balance_1'));
      store.putRequest(balanceCheck('balance_2'));

      expect(store.getRequest('old_spl')).toBeUndefined();
      expect(store.findByIdempotencyKey('idem_old_spl')).toBeUndefined();
    });

    it('counts only SOL toward the 24-hour limit, not SPL transfers', () => {
      const store = new Store(statePath, 'agent-001', 200);
      store.putRequest(solSpend('spend_1', 50_000_000));
      store.putRequest(splTransfer('spl_1'));
      store.putRequest(splTransfer('spl_2', executionFailed));

      expect(spentLamportsInWindow(store.listRequests())).toBe(50_000_000);
    });

    it('still drops denied and balance requests with their keys', () => {
      const store = new Store(statePath, 'agent-001', 3);
      store.putRequest(solSpend('spend_1', 50_000_000));
      store.putRequest(makeRequest({ id: 'denied_1', status: 'denied', approval: null, idempotencyKey: 'idem_denied_1' }));
      store.putRequest(balanceCheck('balance_1'));
      store.putRequest(balanceCheck('balance_2'));
      store.putRequest(balanceCheck('balance_3'));

      expect(store.listRequests()).toHaveLength(3);
      expect(store.getRequest('spend_1')).toBeDefined();
      expect(store.getRequest('denied_1')).toBeUndefined();
      expect(store.findByIdempotencyKey('idem_denied_1')).toBeUndefined();
    });
  });

  it('scopes task payment and receipt ids per task and re-keys legacy state files', () => {
    const worker = '11111111111111111111111111111112';
    const payment = (taskId: string) => ({
      taskId,
      paymentId: 'pay-1',
      worker,
      serviceId: 'svc',
      amountLamports: 10,
      requestHash: 'h',
      status: 'held' as const,
    });
    const store1 = new Store(statePath, 'agent-001', 50);
    store1.setPayment(payment('task-a'));
    store1.setPayment(payment('task-b'));
    expect(store1.getPayment('task-a', 'pay-1')?.taskId).toBe('task-a');
    expect(store1.getPayment('task-b', 'pay-1')?.taskId).toBe('task-b');
    expect(() => store1.setPayment(payment('task-a'))).toThrow(/already exists/);

    // Older state files keyed payments by paymentId alone.
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    raw.payments = { 'pay-1': payment('task-legacy') };
    writeFileSync(statePath, JSON.stringify(raw));
    const store2 = new Store(statePath, 'agent-001', 50);
    expect(store2.getPayment('task-legacy', 'pay-1')?.taskId).toBe('task-legacy');
    expect(store2.getPayment('task-a', 'pay-1')).toBeUndefined();
  });
});
