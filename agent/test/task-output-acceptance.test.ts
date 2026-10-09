import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { computeOutputHash } from '@nexus/shared';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { acceptanceSignature, submitOutput } from './task-output-helpers.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-output-acceptance-'));
  const config = { ...loadConfig(), dataDir: dir, usersDir: join(dir, 'users'), masterFunderPath: join(dir, 'master-funder.json'),
    legacyKeystorePath: join(dir, 'agent-keystore.json'), keystorePath: join(dir, 'agent-keystore.json'),
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
});
