import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MAX_DELIVERY_ATTEMPTS, computeOutputHash } from '@nexus/shared';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { acceptanceSignature, submitOutput } from './task-output-helpers.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-output-acceptance-'));
  const config = { ...loadConfig(), dataDir: dir, usersDir: join(dir, 'users'),
    keystorePath: join(dir, 'agent-keystore.json'),
    statePath: join(dir, 'state.json'), auditPath: join(dir, 'audit.jsonl'), saltPath: join(dir, 'audit-salt') };
  const ctx = createContext(config);
  const app = Fastify();
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await registerRoutes(app, ctx);
  const owner = nacl.sign.keyPair();
  const pubkey = bs58.encode(owner.publicKey);
  const challenge = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
  const signed = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey));
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { challengeId: challenge.challengeId, pubkey, signature: signed } });
  const session = login.cookies.find((item) => item.name === SESSION_COOKIE_NAME)!;
  const headers = { cookie: `${session.name}=${session.value}` };
  const worker = nacl.sign.keyPair();
  const taskId = 'acceptance-task';
  expect((await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { taskId, budgetLamports: 100, perPaymentCapLamports: 50, expiry: Math.floor(Date.now() / 1000) + 3600, isSimulated: true } })).statusCode).toBe(200);
  for (const paymentId of ['pay-1', 'pay-2']) {
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments`, headers, payload: { paymentId, worker: bs58.encode(worker.publicKey), serviceId: 'service', amountLamports: 50, requestHash: 'requested-output' } })).statusCode).toBe(200);
  }
  const userCtx = ctx.getUserContext!(pubkey);
  return { app, config, userCtx, headers, owner, worker, taskId, pubkey };
}

describe('Output review before settlement', () => {
  it('requires a submitted output and owner acceptance bound to that output, escrow, request and amount', async () => {
    const { app, userCtx, headers, owner, worker, taskId, pubkey } = await setup();
    try {
      const resultPayload = { status: 'completed', output: 'reviewable result' };
      const resultHash = computeOutputHash(resultPayload);
      expect(resultHash).toBe(createHash('sha256').update(`NEXUS_TASK_OUTPUT_V1:${JSON.stringify(resultPayload)}`).digest('hex'));
      const workerPubkey = bs58.encode(worker.publicKey);
      const workerSignature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-1:${resultHash}`), worker.secretKey));
      const settle = (payload: Record<string, unknown>, paymentId = 'pay-1') => app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/${paymentId}/settle`, headers, payload });
      const noOutput = await settle({ resultHash, workerPubkey, workerSignature });
      expect(noOutput.statusCode).toBe(409);
      expect(noOutput.json().error).toBe('output_not_submitted');
      const accepted = await submitOutput(app, headers.cookie, taskId, 'pay-1', worker.secretKey, owner.secretKey, resultPayload);
      const before = structuredClone(userCtx.store.getPayment(taskId, 'pay-1'));
      expect(before?.status).toBe('held');
      expect(userCtx.store.getReceipts(taskId)).toEqual([]);
      const task = userCtx.store.getTask(taskId)!;
      const payment = userCtx.store.getPayment(taskId, 'pay-1')!;
      const alteredOutput = { status: 'completed', output: 'different result' };
      const otherHash = computeOutputHash(alteredOutput);
      const cases = [
        [{ ...accepted, ownerSignature: undefined }, 403, 'owner_acceptance_required'],
        [{ ...accepted, ownerSignature: 'invalid-base58!' }, 401, 'invalid_owner_acceptance'],
        [{ ...accepted, ownerSignature: acceptanceSignature(task, payment, resultHash, nacl.sign.keyPair().secretKey) }, 401, 'invalid_owner_acceptance'],
        [{ ...accepted, ownerSignature: acceptanceSignature(task, { ...payment, amountLamports: 51 }, resultHash, owner.secretKey) }, 401, 'invalid_owner_acceptance'],
        [{ ...accepted, ownerSignature: acceptanceSignature(task, { ...payment, requestHash: 'other-request' }, resultHash, owner.secretKey) }, 401, 'invalid_owner_acceptance'],
        [{ ...accepted, resultHash: otherHash, workerSignature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-1:${otherHash}`), worker.secretKey)) }, 409, 'output_hash_mismatch'],
      ] as const;
      for (const [payload, status, error] of cases) {
        const response = await settle(payload);
        expect(response.statusCode).toBe(status);
        expect(response.json().error).toBe(error);
        expect(userCtx.store.getPayment(taskId, 'pay-1')).toEqual(before);
        expect(userCtx.store.getReceipts(taskId)).toEqual([]);
      }
      const second = await submitOutput(app, headers.cookie, taskId, 'pay-2', worker.secretKey, owner.secretKey, resultPayload);
      const replayAcrossEscrow = await settle({ ...second, ownerSignature: accepted.ownerSignature }, 'pay-2');
      expect(replayAcrossEscrow.statusCode).toBe(401);
      expect(userCtx.store.getPayment(taskId, 'pay-2')?.status).toBe('held');
      const paid = await settle(accepted);
      expect(paid.statusCode).toBe(200);
      expect(paid.json().receipt.acceptedBy).toBe(pubkey);
      expect(paid.json().receipt.ownerSignature).toBe(accepted.ownerSignature);
      expect(paid.json().payment.delivery.resultPayload).toEqual(resultPayload);
      expect(userCtx.store.getTask(taskId)?.status).toBe('active');
      expect((await settle(accepted)).json().error).toBe('already_settled');
    } finally { await app.close(); }
  });

  it('persists the submitted version, permits identical retries and rejects replacement, expiry, freeze and corrupt output', async () => {
    const { app, config, userCtx, headers, owner, worker, taskId, pubkey } = await setup();
    try {
      const payload = { output: 'first version' };
      const accepted = await submitOutput(app, headers.cookie, taskId, 'pay-1', worker.secretKey, owner.secretKey, payload);
      const deliveryRequest = { ...accepted, resultPayload: payload };
      const submit = (input: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-1/output`, headers, payload: input });
      expect((await submit(deliveryRequest)).json().reused).toBe(true);
      const changed = { output: 'replacement' };
      const hash = computeOutputHash(changed);
      const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-1:${hash}`), worker.secretKey));
      expect((await submit({ ...deliveryRequest, resultPayload: changed, resultHash: hash, workerSignature: signature })).json().error).toBe('output_already_submitted');
      expect((await submit({ ...deliveryRequest, resultPayload: changed })).json().error).toBe('output_hash_mismatch');
      expect((await submit({ ...deliveryRequest, resultPayload: {} })).statusCode).toBe(400);
      const reloaded = createContext(config).getUserContext!(pubkey).store.getPayment(taskId, 'pay-1');
      expect(reloaded?.delivery?.resultPayload).toEqual(payload);
      expect(reloaded?.status).toBe('held');
      const settle = () => app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-1/settle`, headers, payload: accepted });
      const original = userCtx.store.getPayment(taskId, 'pay-1')!;
      userCtx.store.setPayment({ ...original, delivery: { ...original.delivery!, resultPayload: changed } }, { allowOverwrite: true });
      expect((await settle()).json().error).toBe('output_hash_mismatch');
      userCtx.store.setPayment(original, { allowOverwrite: true });
      const task = userCtx.store.getTask(taskId)!;
      userCtx.store.setTask({ ...task, expiry: Math.floor(Date.now() / 1000) - 1 }, { allowOverwrite: true });
      expect((await settle()).json().error).toBe('settle_rejected');
      expect((await submit(deliveryRequest)).json().error).toBe('settle_rejected');
      userCtx.store.setTask(task, { allowOverwrite: true });
      await app.inject({ method: 'POST', url: '/api/agent/freeze', headers });
      expect((await settle()).json().error).toBe('AGENT_FROZEN');
      expect((await submit(deliveryRequest)).json().error).toBe('AGENT_FROZEN');
      expect(userCtx.store.getPayment(taskId, 'pay-1')).toEqual(original);
      expect(userCtx.store.getReceipts(taskId)).toEqual([]);
    } finally { await app.close(); }
  });

  it('supports mock valid/invalid scenarios, blocks settling invalid output, and enforces reject & revision loop', async () => {
    const { app, userCtx, headers, owner, worker, taskId } = await setup();
    try {
      // 1. Mock service scenarios produce valid worker signatures but distinct verification verdicts
      for (const scenario of ['valid', 'invalid_schema', 'wrong_service'] as const) {
        const mockRes = await app.inject({
          method: 'POST',
          url: '/api/tasks/mock-service/run',
          headers,
          payload: { taskId, paymentId: 'pay-1', serviceId: 'service', scenario },
        });
        expect(mockRes.statusCode).toBe(200);
        const body = mockRes.json();
        expect(body.scenario).toBe(scenario);
        expect(body.workerSignature).toBeTruthy();
      }

      // 2. Rejecting before any submission fails
      const rejectEmpty = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-1/reject`,
        headers,
        payload: { reason: 'no output yet' },
      });
      expect(rejectEmpty.statusCode).toBe(409);
      expect(rejectEmpty.json().error).toBe('output_not_submitted');

      // 3. Submit invalid output (signed validly by worker) -> verification fails -> settle blocked even with ownerSignature
      const invalidPayload = {
        status: 'failed',
        serviceId: 'service',
        evaluatedAt: 'invalid-date',
        outputSummary: '',
        error: 'worker_failed',
      };
      const invalidAttempt = await submitOutput(app, headers.cookie, taskId, 'pay-1', worker.secretKey, owner.secretKey, invalidPayload);
      const afterInvalid = userCtx.store.getPayment(taskId, 'pay-1')!;
      expect(afterInvalid.delivery?.attempt).toBe(1);
      expect(afterInvalid.delivery?.verification?.verdict).toBe('fail');

      const blockedSettle = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-1/settle`,
        headers,
        payload: invalidAttempt,
      });
      expect(blockedSettle.statusCode).toBe(409);
      expect(blockedSettle.json().error).toBe('output_verification_failed');
      expect(blockedSettle.json().verification.verdict).toBe('fail');

      // 4. Owner rejects invalid output -> moves to rejectedDeliveries and opens attempt 2
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-1/reject`,
        headers,
        payload: { reason: 'Failed deterministic checks' },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json().attemptsRemaining).toBe(MAX_DELIVERY_ATTEMPTS - 1);
      const afterReject = userCtx.store.getPayment(taskId, 'pay-1')!;
      expect(afterReject.delivery).toBeUndefined();
      expect(afterReject.rejectedDeliveries).toHaveLength(1);
      expect(afterReject.rejectedDeliveries![0]!.rejectReason).toBe('Failed deterministic checks');

      // 5. Resubmitting the exact rejected hash is blocked
      const replayRejected = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-1/output`,
        headers,
        payload: {
          resultHash: invalidAttempt.resultHash,
          resultPayload: invalidPayload,
          workerPubkey: invalidAttempt.workerPubkey,
          workerSignature: invalidAttempt.workerSignature,
        },
      });
      expect(replayRejected.statusCode).toBe(409);
      expect(replayRejected.json().error).toBe('output_already_rejected');

      // 6. Worker submits revised valid output (attempt 2) -> passes verification -> settles cleanly
      const validPayload = {
        status: 'completed',
        serviceId: 'service',
        evaluatedAt: new Date().toISOString(),
        outputSummary: 'Revised valid output after rejection',
      };
      const validAttempt = await submitOutput(app, headers.cookie, taskId, 'pay-1', worker.secretKey, owner.secretKey, validPayload);
      expect(userCtx.store.getPayment(taskId, 'pay-1')?.delivery?.attempt).toBe(2);
      expect(userCtx.store.getPayment(taskId, 'pay-1')?.delivery?.verification?.verdict).toBe('pass');
      const settleOk = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-1/settle`,
        headers,
        payload: validAttempt,
      });
      expect(settleOk.statusCode).toBe(200);
      expect(settleOk.json().payment.status).toBe('settled');

      // 7. Exhausting MAX_DELIVERY_ATTEMPTS (3 rejections) on pay-2 blocks further submissions
      for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
        await submitOutput(app, headers.cookie, taskId, 'pay-2', worker.secretKey, owner.secretKey, {
          status: 'failed',
          outputSummary: `bad-${i}`,
        });
        const r = await app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/payments/pay-2/reject`,
          headers,
          payload: { reason: `reject-${i}` },
        });
        expect(r.statusCode).toBe(200);
      }
      const fourthHash = computeOutputHash({ status: 'completed', outputSummary: 'Fourth attempt after cap' });
      const fourthSig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(`NEXUS_RECEIPT_V1:${taskId}:pay-2:${fourthHash}`), worker.secretKey));
      const overLimit = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-2/output`,
        headers,
        payload: {
          resultHash: fourthHash,
          resultPayload: { status: 'completed', outputSummary: 'Fourth attempt after cap' },
          workerPubkey: bs58.encode(worker.publicKey),
          workerSignature: fourthSig,
        },
      });
      expect(overLimit.statusCode).toBe(409);
      expect(overLimit.json().error).toBe('max_delivery_attempts_reached');

      // 8. Reject guards: frozen and expired
      const guardTaskId = 'reject-guards';
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers,
        payload: { taskId: guardTaskId, budgetLamports: 100, perPaymentCapLamports: 50, expiry: Math.floor(Date.now() / 1000) + 3600, isSimulated: true },
      });
      await app.inject({
        method: 'POST',
        url: `/api/tasks/${guardTaskId}/payments`,
        headers,
        payload: { paymentId: 'pay-g', worker: bs58.encode(worker.publicKey), serviceId: 'service', amountLamports: 50, requestHash: 'req-g' },
      });
      await submitOutput(app, headers.cookie, guardTaskId, 'pay-g', worker.secretKey, owner.secretKey, { output: 'guard test' });

      await app.inject({ method: 'POST', url: '/api/agent/freeze', headers });
      const frozenReject = await app.inject({ method: 'POST', url: `/api/tasks/${guardTaskId}/payments/pay-g/reject`, headers, payload: {} });
      expect(frozenReject.statusCode).toBe(409);
      expect(frozenReject.json().error).toBe('AGENT_FROZEN');
      await app.inject({ method: 'POST', url: '/api/agent/unfreeze', headers });

      const guardTask = userCtx.store.getTask(guardTaskId)!;
      userCtx.store.setTask({ ...guardTask, expiry: Math.floor(Date.now() / 1000) - 1 }, { allowOverwrite: true });
      const expiredReject = await app.inject({ method: 'POST', url: `/api/tasks/${guardTaskId}/payments/pay-g/reject`, headers, payload: {} });
      expect(expiredReject.statusCode).toBe(400);
      expect(expiredReject.json().error).toBe('settle_rejected');
    } finally { await app.close(); }
  });
});
