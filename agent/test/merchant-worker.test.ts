import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { computeOutputHash, type TaskPaymentRecord } from '@nexus/shared';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { createMerchantWorker, MerchantWorkerError, type MerchantJob } from '../src/merchant-worker.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';
import { acceptanceSignature } from './task-output-helpers.js';

const URL_BASE = 'https://merchant.test';
const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A merchant stub that signs like demo-merchant: receipts for jobs, and co-signatures for settlements. */
function merchantStub(merchant: Keypair) {
  const jobs: MerchantJob[] = [];
  const settlements: Transaction[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(URL_BASE.length);
    if (path === '/worker') return Response.json({ pubkey: merchant.publicKey.toBase58() });
    const body = JSON.parse(String(init?.body));
    if (path === '/worker/jobs') {
      jobs.push(body);
      const resultPayload = { status: 'completed', serviceId: body.serviceId, requestHash: body.requestHash, outputSummary: 'merchant report ready' };
      const resultHash = computeOutputHash(resultPayload);
      const message = new TextEncoder().encode(`NEXUS_RECEIPT_V1:${body.taskId}:${body.paymentId}:${resultHash}`);
      return Response.json({
        workerPubkey: merchant.publicKey.toBase58(),
        workerSignature: bs58.encode(nacl.sign.detached(message, merchant.secretKey)),
        resultHash,
        resultPayload,
      });
    }
    if (path === '/worker/settlements') {
      const transaction = Transaction.from(Buffer.from(body.transaction, 'base64'));
      settlements.push(transaction);
      transaction.partialSign(merchant);
      const signature = transaction.signatures.find((entry) => entry.publicKey.equals(merchant.publicKey))!.signature!;
      return Response.json({ workerPubkey: merchant.publicKey.toBase58(), signature: bs58.encode(signature) });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, jobs, settlements, calls: fetchImpl };
}

describe('createMerchantWorker', () => {
  it('caches the worker key, and retries a failed lookup only after a short wait', async () => {
    const merchant = Keypair.generate();
    let now = 0;
    let up = false;
    const fetchImpl = vi.fn(async () => (up ? Response.json({ pubkey: merchant.publicKey.toBase58() }) : Promise.reject(new Error('down'))));
    const worker = createMerchantWorker(URL_BASE, fetchImpl as unknown as typeof fetch, () => now);

    expect(await worker.pubkey()).toBeNull();
    up = true;
    expect(await worker.pubkey()).toBeNull();
    now += 30_000;
    expect(await worker.pubkey()).toBe(merchant.publicKey.toBase58());
    now += 60_000;
    expect(await worker.pubkey()).toBe(merchant.publicKey.toBase58());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses an output signed by a key other than the one it published', async () => {
    const published = Keypair.generate();
    const stub = merchantStub(Keypair.generate());
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith('/worker') ? Response.json({ pubkey: published.publicKey.toBase58() }) : stub.fetchImpl(url, init));
    const worker = createMerchantWorker(URL_BASE, fetchImpl as unknown as typeof fetch);
    await expect(worker.runJob({ owner: 'o', taskId: 't', paymentId: 'p', serviceId: 's', requestHash: 'r', scenario: 'valid' }))
      .rejects.toEqual(new MerchantWorkerError('worker_key_changed'));
  });

  it('adds the merchant co-signature to a settlement and checks it', async () => {
    const merchant = Keypair.generate();
    const agent = Keypair.generate();
    const worker = createMerchantWorker(URL_BASE, merchantStub(merchant).fetchImpl);
    const transaction = new Transaction({ feePayer: agent.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
      .add(SystemProgram.transfer({ fromPubkey: merchant.publicKey, toPubkey: agent.publicKey, lamports: 1 }));
    transaction.partialSign(agent);
    await worker.coSignSettlement(transaction);
    expect(transaction.verifySignatures()).toBe(true);
  });

  it('reports a merchant error code', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'escrow_not_held' }, { status: 409 }));
    const worker = createMerchantWorker(URL_BASE, fetchImpl as unknown as typeof fetch);
    await expect(worker.runJob({ owner: 'o', taskId: 't', paymentId: 'p', serviceId: 's', requestHash: 'r', scenario: 'valid' }))
      .rejects.toEqual(new MerchantWorkerError('escrow_not_held'));
  });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-merchant-worker-'));
  dirs.push(dir);
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
  const userCtx = ctx.getUserContext!(pubkey);

  const merchant = Keypair.generate();
  const stub = merchantStub(merchant);
  userCtx.merchantWorker = createMerchantWorker(URL_BASE, stub.fetchImpl);

  // Tasks are created simulated, then marked on-chain in the store: the chain is stubbed below.
  const taskId = 'merchant-task';
  expect((await app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { taskId, budgetLamports: 1_000_000, perPaymentCapLamports: 500_000, expiry: Math.floor(Date.now() / 1000) + 3600, isSimulated: true } })).statusCode).toBe(200);
  for (const paymentId of ['pay-chain', 'pay-sim']) {
    expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments`, headers, payload: { paymentId, worker: merchant.publicKey.toBase58(), serviceId: 'research-report', amountLamports: 400_000, requestHash: 'requested-report' } })).statusCode).toBe(200);
  }
  const markOnChain = () => {
    userCtx.store.setTask({ ...userCtx.store.getTask(taskId)!, isSimulated: false }, { allowOverwrite: true });
    const payment = userCtx.store.getPayment(taskId, 'pay-chain')!;
    userCtx.store.setPayment({ ...payment, isSimulated: false }, { allowOverwrite: true });
  };
  return { app, userCtx, headers, owner, merchant, stub, taskId, markOnChain };
}

describe('demo merchant as the worker of a task', () => {
  it('lists the merchant worker in the state', async () => {
    const { app, headers, merchant } = await setup();
    try {
      const state = (await app.inject({ method: 'GET', url: '/api/state', headers })).json();
      expect(state.merchantWorker).toEqual({ pubkey: merchant.publicKey.toBase58() });
    } finally { await app.close(); }
  });

  it('has the merchant deliver the output for an on-chain escrow, and refuses a simulated one', async () => {
    const { app, headers, taskId, stub, markOnChain } = await setup();
    try {
      markOnChain();
      const run = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-chain/worker-run`, headers, payload: { scenario: 'valid' } });
      expect(run.statusCode).toBe(200);
      expect(stub.jobs).toEqual([expect.objectContaining({ taskId, paymentId: 'pay-chain', serviceId: 'research-report', requestHash: 'requested-report', scenario: 'valid' })]);
      const output = run.json();
      const submitted = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-chain/output`, headers, payload: output });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().payment.delivery.verification.verdict).toBe('pass');

      const simulated = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-sim/worker-run`, headers, payload: {} });
      expect(simulated.statusCode).toBe(409);
      expect(simulated.json().error).toBe('merchant_worker_onchain_only');
    } finally { await app.close(); }
  });

  it('settles on-chain with the merchant co-signing, and never holds the merchant key', async () => {
    const { app, headers, owner, merchant, userCtx, taskId, stub, markOnChain } = await setup();
    try {
      markOnChain();
      const output = (await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-chain/worker-run`, headers, payload: {} })).json();
      expect((await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-chain/output`, headers, payload: output })).statusCode).toBe(200);

      const sent: Transaction[] = [];
      vi.spyOn(userCtx.connection, 'getMinimumBalanceForRentExemption').mockResolvedValue(1_000);
      vi.spyOn(userCtx.connection, 'getBalance').mockResolvedValue(1_000_000);
      vi.spyOn(userCtx.connection, 'getLatestBlockhash').mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 });
      vi.spyOn(userCtx.connection, 'sendRawTransaction').mockImplementation(async (raw) => {
        sent.push(Transaction.from(raw as Buffer));
        return 'settle-signature';
      });
      vi.spyOn(userCtx.connection, 'confirmTransaction').mockResolvedValue({ context: { slot: 1 }, value: { err: null } });

      const task = userCtx.store.getTask(taskId)!;
      const payment = userCtx.store.getPayment(taskId, 'pay-chain') as TaskPaymentRecord;
      const settled = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/pay-chain/settle`,
        headers,
        payload: {
          resultHash: output.resultHash,
          workerPubkey: output.workerPubkey,
          workerSignature: output.workerSignature,
          ownerSignature: acceptanceSignature(task, payment, output.resultHash, owner.secretKey),
        },
      });
      expect(settled.statusCode).toBe(200);
      expect(settled.json().payment).toMatchObject({ status: 'settled', txSignature: 'settle-signature' });
      expect(stub.settlements).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.verifySignatures()).toBe(true);
      expect(sent[0]!.feePayer!.equals(new PublicKey(userCtx.agentPubkey))).toBe(true);
      expect(sent[0]!.signatures.map((entry) => entry.publicKey.toBase58())).toContain(merchant.publicKey.toBase58());
    } finally { await app.close(); }
  });

  it('says the merchant does not answer, instead of calling its address unsupported', async () => {
    const { app, headers, userCtx, taskId, markOnChain } = await setup();
    try {
      markOnChain();
      userCtx.merchantWorker = createMerchantWorker(URL_BASE, (async () => { throw new Error('down'); }) as unknown as typeof fetch);
      const state = (await app.inject({ method: 'GET', url: '/api/state', headers })).json();
      expect(state.merchantWorker).toBeNull();
      const run = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/payments/pay-chain/worker-run`, headers, payload: {} });
      expect(run.statusCode).toBe(503);
      expect(run.json().error).toBe('merchant_worker_unreachable');
    } finally { await app.close(); }
  });
});
