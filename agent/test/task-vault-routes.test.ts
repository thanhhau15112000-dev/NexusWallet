import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'nexus-task-vault-routes-test-'));
}

describe('Phase 2: Task Capability Vault API & Multi-step Workflow', () => {
  async function setupApp() {
    const dir = makeTempDir();
    const config = {
      ...loadConfig(),
      AGENT_DATA_DIR: dir,
      dataDir: dir,
      usersDir: join(dir, 'users'),
      masterFunderPath: join(dir, 'master-funder.json'),
      legacyKeystorePath: join(dir, 'agent-keystore.json'),
      statePath: join(dir, 'state.json'),
      auditPath: join(dir, 'audit.jsonl'),
      keystorePath: join(dir, 'agent-keystore.json'),
      saltPath: join(dir, 'audit-salt'),
    };

    const masterCtx = createContext(config);
    const app = Fastify();
    await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
    await registerRoutes(app, masterCtx);

    // Create authenticated owner session
    const ownerKey = nacl.sign.keyPair();
    const ownerPubkey = bs58.encode(ownerKey.publicKey);

    const challengeRes = await app.inject({
      method: 'POST',
      url: '/api/auth/challenge',
      payload: { pubkey: ownerPubkey },
    });
    const challenge = JSON.parse(challengeRes.body);

    const sig = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challenge.message), ownerKey.secretKey),
    );
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        challengeId: challenge.challengeId,
        pubkey: ownerPubkey,
        signature: sig,
      },
    });
    const sessionCookie = loginRes.cookies.find((c: { name: string }) => c.name === SESSION_COOKIE_NAME);
    const cookieHeader = `${sessionCookie!.name}=${sessionCookie!.value}`;

    return { app, masterCtx, ownerPubkey, cookieHeader };
  }

  it('executes full task lifecycle: fund -> two payments -> overbudget rejected -> settle -> refund', async () => {
    const { app, masterCtx, ownerPubkey, cookieHeader } = await setupApp();

    try {
      const now = Math.floor(Date.now() / 1000);
      const taskId = 'task-demo-lifecycle-001';

      // 1. Owner creates and funds task with 1.0 SOL (1_000_000_000 lamports), cap 0.4 SOL
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId,
          budgetLamports: 1_000_000_000,
          perPaymentCapLamports: 400_000_000,
          expiry: now + 3600,
        },
      });
      expect(createRes.statusCode).toBe(200);
      const { task } = JSON.parse(createRes.body);
      expect(task.taskId).toBe(taskId);
      expect(task.owner).toBe(ownerPubkey);
      expect(task.status).toBe('active');
      expect(task.pda).toBeDefined();
      expect(task.vaultPda).toBeDefined();

      const workerKey = nacl.sign.keyPair();
      const workerPubkey = bs58.encode(workerKey.publicKey);

      // 2. Payment 1: 0.3 SOL for service A
      const pay1Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-001',
          worker: workerPubkey,
          serviceId: 'service-text-summary',
          amountLamports: 300_000_000,
          requestHash: 'hash-req-001',
        },
      });
      expect(pay1Res.statusCode).toBe(200);
      const pay1Data = JSON.parse(pay1Res.body);
      expect(pay1Data.payment.status).toBe('held');
      expect(pay1Data.task.spentLamports).toBe(300_000_000);

      // Reject duplicate payment ID
      const dupPayRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-001',
          worker: workerPubkey,
          serviceId: 'service-text-summary',
          amountLamports: 100_000_000,
          requestHash: 'hash-req-dup',
        },
      });
      expect(dupPayRes.statusCode).toBe(409);
      expect(JSON.parse(dupPayRes.body).error).toBe('payment_exists');

      // Attempt settle with forged worker signature -> 401
      const forgedSettleRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-001/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'hash-res-001',
          workerPubkey,
          workerSignature: bs58.encode(new Uint8Array(64).fill(9)),
        },
      });
      expect(forgedSettleRes.statusCode).toBe(401);
      expect(JSON.parse(forgedSettleRes.body).error).toBe('invalid_worker_signature');

      // Attempt settle with wrong worker pubkey -> 403
      const otherWorker = bs58.encode(nacl.sign.keyPair().publicKey);
      const wrongWorkerRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-001/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'hash-res-001',
          workerPubkey: otherWorker,
          workerSignature: bs58.encode(new Uint8Array(64).fill(1)),
        },
      });
      expect(wrongWorkerRes.statusCode).toBe(403);
      expect(JSON.parse(wrongWorkerRes.body).error).toBe('unauthorized_worker');

      // Settle Payment 1 with valid worker ed25519 signature
      const canonicalMsg1 = `NEXUS_RECEIPT_V1:${taskId}:pay-001:hash-res-001`;
      const workerSig1 = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(canonicalMsg1), workerKey.secretKey),
      );

      const settle1Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-001/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'hash-res-001',
          workerPubkey,
          workerSignature: workerSig1,
        },
      });
      expect(settle1Res.statusCode).toBe(200);
      const settle1Data = JSON.parse(settle1Res.body);
      expect(settle1Data.payment.status).toBe('settled');
      expect(settle1Data.receipt.resultHash).toBe('hash-res-001');

      // Replay settle -> 400 already_settled
      const replaySettleRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-001/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'hash-res-001',
          workerPubkey,
          workerSignature: workerSig1,
        },
      });
      expect(replaySettleRes.statusCode).toBe(400);
      expect(JSON.parse(replaySettleRes.body).error).toBe('already_settled');

      // 3. Payment 2: 0.3 SOL for service B
      const pay2Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-002',
          worker: workerPubkey,
          serviceId: 'service-image-gen',
          amountLamports: 300_000_000,
          requestHash: 'hash-req-002',
        },
      });
      expect(pay2Res.statusCode).toBe(200);
      const pay2Data = JSON.parse(pay2Res.body);
      expect(pay2Data.task.spentLamports).toBe(600_000_000);

      // Invariant Check (Finding 2): Reject refund and close while escrow pay-002 is still held!
      const prematureRefundRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/refund`,
        headers: { cookie: cookieHeader },
      });
      expect(prematureRefundRes.statusCode).toBe(409);
      expect(JSON.parse(prematureRefundRes.body).error).toBe('pending_escrows_exist');

      // Settle Payment 2
      const canonicalMsg2 = `NEXUS_RECEIPT_V1:${taskId}:pay-002:hash-res-002`;
      const workerSig2 = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(canonicalMsg2), workerKey.secretKey),
      );
      const settle2Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-002/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'hash-res-002',
          workerPubkey,
          workerSignature: workerSig2,
        },
      });
      expect(settle2Res.statusCode).toBe(200);

      // 4. Payment 3: attempts 0.5 SOL -> rejected because 0.5 > 0.4 per-payment cap
      const capExceededRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-003',
          worker: workerPubkey,
          serviceId: 'service-heavy-compute',
          amountLamports: 500_000_000,
          requestHash: 'hash-req-003',
        },
      });
      expect(capExceededRes.statusCode).toBe(400);
      expect(JSON.parse(capExceededRes.body).error).toBe('payment_rejected');

      // 5. Payment 4: attempts 0.45 SOL -> rejected because 600m + 450m = 1050m > 1000m budget
      const budgetExceededRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-004',
          worker: workerPubkey,
          serviceId: 'service-heavy-compute',
          amountLamports: 450_000_000,
          requestHash: 'hash-req-004',
        },
      });
      expect(budgetExceededRes.statusCode).toBe(400);

      // 6. Claim refund for remaining 0.4 SOL (all escrows now settled)
      const refundRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/refund`,
        headers: { cookie: cookieHeader },
      });
      expect(refundRes.statusCode).toBe(200);
      const refundData = JSON.parse(refundRes.body);
      expect(refundData.refundedLamports).toBe(400_000_000);
      expect(refundData.task.status).toBe('completed');

      // 7. Verify task list and detail endpoints
      const detailRes = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: { cookie: cookieHeader },
      });
      expect(detailRes.statusCode).toBe(200);
      const detail = JSON.parse(detailRes.body);
      expect(detail.task.taskId).toBe(taskId);
      expect(detail.payments).toHaveLength(2);
      expect(detail.receipts).toHaveLength(2);

      // 8. Verify audit log captured every event and cryptographic hash chain is valid
      const auditRes = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: cookieHeader },
      });
      expect(auditRes.statusCode).toBe(200);
      const auditEntries = JSON.parse(auditRes.body).entries;
      const events = auditEntries.map((e: { event: string }) => e.event);
      expect(events).toContain('task_capability_created');
      expect(events).toContain('task_payment_executed');
      expect(events).toContain('task_payment_settled');
      expect(events).toContain('task_refunded_and_closed');

      // Verify audit integrity
      const userAudit = masterCtx.getUserContext!(ownerPubkey).audit;
      const integrity = userAudit.verifyIntegrity();
      expect(integrity.valid).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('supports task revocation to prevent further execution', async () => {
    const { app, cookieHeader } = await setupApp();

    try {
      const now = Math.floor(Date.now() / 1000);
      const taskId = 'task-demo-revoke-001';

      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId,
          budgetLamports: 500_000_000,
          perPaymentCapLamports: 200_000_000,
          expiry: now + 3600,
        },
      });

      // Revoke task
      const revokeRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/revoke`,
        headers: { cookie: cookieHeader },
      });
      expect(revokeRes.statusCode).toBe(200);
      expect(JSON.parse(revokeRes.body).task.status).toBe('revoked');

      // Further payments are blocked
      const payRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-blocked',
          worker: '11111111111111111111111111111111',
          serviceId: 'service-blocked',
          amountLamports: 100_000_000,
          requestHash: 'hash-blocked',
        },
      });
      expect(payRes.statusCode).toBe(400);
      expect(JSON.parse(payRes.body).message).toMatch(/revoked/i);
    } finally {
      await app.close();
    }
  });

  it('enforces worker and service allowlist on task payments (rejects 403 on mismatch)', async () => {
    const { app, cookieHeader } = await setupApp();

    try {
      const now = Math.floor(Date.now() / 1000);
      const taskId = 'task-demo-allowlist-001';
      const allowedWorkerKey = nacl.sign.keyPair();
      const allowedWorkerPubkey = bs58.encode(allowedWorkerKey.publicKey);
      const allowedServiceId = 'allowed-service-nlp';

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId,
          budgetLamports: 500_000_000,
          perPaymentCapLamports: 250_000_000,
          expiry: now + 3600,
          allowedWorker: allowedWorkerPubkey,
          allowedServiceId,
        },
      });
      expect(createRes.statusCode).toBe(200);

      // 1. Attempt payment with unauthorized worker -> 403
      const unauthorizedWorkerKey = nacl.sign.keyPair();
      const unauthorizedWorkerPubkey = bs58.encode(unauthorizedWorkerKey.publicKey);
      const unauthWorkerRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-unauth-worker',
          worker: unauthorizedWorkerPubkey,
          serviceId: allowedServiceId,
          amountLamports: 100_000_000,
          requestHash: 'hash-req-unauth-worker',
        },
      });
      expect(unauthWorkerRes.statusCode).toBe(403);
      expect(JSON.parse(unauthWorkerRes.body).error).toBe('unauthorized_worker');

      // 2. Attempt payment with unauthorized serviceId -> 403
      const unauthServiceRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-unauth-service',
          worker: allowedWorkerPubkey,
          serviceId: 'unauthorized-service-xyz',
          amountLamports: 100_000_000,
          requestHash: 'hash-req-unauth-service',
        },
      });
      expect(unauthServiceRes.statusCode).toBe(403);
      expect(JSON.parse(unauthServiceRes.body).error).toBe('unauthorized_service');

      // 3. Authorized payment succeeds
      const authPayRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-auth-valid',
          worker: allowedWorkerPubkey,
          serviceId: allowedServiceId,
          amountLamports: 100_000_000,
          requestHash: 'hash-req-auth-valid',
        },
      });
      expect(authPayRes.statusCode).toBe(200);
      expect(JSON.parse(authPayRes.body).payment.status).toBe('held');
    } finally {
      await app.close();
    }
  });

  it('allows multi-payment settlement to fully spend budget without locking pending escrows prematurely', async () => {
    const { app, cookieHeader } = await setupApp();

    try {
      const now = Math.floor(Date.now() / 1000);
      const taskId = 'task-demo-multipay-001';
      const workerKey = nacl.sign.keyPair();
      const workerPubkey = bs58.encode(workerKey.publicKey);

      // Budget 600m, Cap 300m
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId,
          budgetLamports: 600_000_000,
          perPaymentCapLamports: 300_000_000,
          expiry: now + 3600,
        },
      });

      // Payment 1: 300m (held)
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-m1',
          worker: workerPubkey,
          serviceId: 'svc-m1',
          amountLamports: 300_000_000,
          requestHash: 'req-m1',
        },
      });

      // Payment 2: 300m (held) -> Spent lamports now 600m = budget
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-m2',
          worker: workerPubkey,
          serviceId: 'svc-m2',
          amountLamports: 300_000_000,
          requestHash: 'req-m2',
        },
      });

      // Settle Payment 1: Task must STAY 'active' because pay-m2 is still held (pending)
      const sig1 = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-m1:res-m1`), workerKey.secretKey),
      );
      const settle1Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-m1/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'res-m1',
          workerPubkey,
          workerSignature: sig1,
        },
      });
      expect(settle1Res.statusCode).toBe(200);
      const getTask1 = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: { cookie: cookieHeader },
      });
      expect(JSON.parse(getTask1.body).task.status).toBe('active'); // NOT completed prematurely!

      // Settle Payment 2: Now 0 pending escrows remaining and spent == budget -> transitions to completed
      const sig2 = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-m2:res-m2`), workerKey.secretKey),
      );
      const settle2Res = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-m2/settle`,
        headers: { cookie: cookieHeader },
        payload: {
          resultHash: 'res-m2',
          workerPubkey,
          workerSignature: sig2,
        },
      });
      expect(settle2Res.statusCode).toBe(200);
      const getTask2 = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: { cookie: cookieHeader },
      });
      expect(JSON.parse(getTask2.body).task.status).toBe('completed');
    } finally {
      await app.close();
    }
  });
});
