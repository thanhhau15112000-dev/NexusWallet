import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ed25519Program, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  ESCROW_ACCOUNT_SIZE,
  TASK_VAULT_PROGRAM_PUBKEY,
  computeCanonicalSeed,
  computeOutputHash,
  deriveEscrowPda,
  deriveTaskCapabilityPda,
  settleAcceptedOutputInstruction,
  sha256Sync,
} from '@nexus/shared';
import { handleRequest, type Env } from '../src/index.js';

const worker = Keypair.generate();
const agent = Keypair.generate();
const owner = Keypair.generate();
const ENV: Env = {
  MERCHANT_WALLET: '6VPd7LHbx96D2QiSsAo5JrEdRQUdW1PGk3bUNYhVECAz',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  SOLANA_RPC_URL: 'https://rpc.test',
  WORKER_SECRET_KEY: bs58.encode(worker.secretKey),
};
const JOB = {
  owner: owner.publicKey.toBase58(),
  taskId: 'task-1',
  paymentId: 'payment-0',
  serviceId: 'research-report',
  requestHash: 'request-1',
};
const [taskPda] = deriveTaskCapabilityPda(owner.publicKey, JOB.taskId);
const [escrowPda] = deriveEscrowPda(taskPda, JOB.paymentId);

function escrowData(opts: { worker?: PublicKey; status?: number; serviceId?: string } = {}): Uint8Array {
  const data = new Uint8Array(ESCROW_ACCOUNT_SIZE);
  data.set(sha256Sync(new TextEncoder().encode('account:Escrow')).subarray(0, 8), 0);
  data.set(taskPda.toBytes(), 8);
  data.set((opts.worker ?? worker.publicKey).toBytes(), 40);
  data.set(computeCanonicalSeed(opts.serviceId ?? JOB.serviceId), 72);
  data.set(computeCanonicalSeed(JOB.paymentId), 104);
  data.set(computeCanonicalSeed(JOB.requestHash), 136);
  new DataView(data.buffer).setBigUint64(168, 1_000_000n, true);
  data[176] = opts.status ?? 0;
  return data;
}

/** RPC stub answering getAccountInfo with the given escrow data (null = no account). */
function rpcReturns(data: Uint8Array | null) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      context: { slot: 1 },
      value: data && {
        owner: TASK_VAULT_PROGRAM_PUBKEY.toBase58(),
        data: [btoa(String.fromCharCode(...data)), 'base64'],
      },
    },
  })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const post = (path: string, body: unknown, env: Env = ENV) =>
  handleRequest(new Request(`https://merchant.test${path}`, { method: 'POST', body: JSON.stringify(body) }), env);

function settlementTransaction(opts: { feePayer?: Keypair; worker?: PublicKey; extra?: boolean } = {}) {
  const feePayer = opts.feePayer ?? agent;
  const message = new TextEncoder().encode('NEXUS_TASK_ACCEPTANCE_V1');
  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  if (opts.extra) {
    transaction.add(SystemProgram.transfer({ fromPubkey: worker.publicKey, toPubkey: agent.publicKey, lamports: 1 }));
  }
  transaction.add(
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: owner.publicKey.toBytes(),
      message,
      signature: nacl.sign.detached(message, owner.secretKey),
    }),
    settleAcceptedOutputInstruction({
      taskCapability: taskPda,
      escrow: escrowPda,
      paymentId: JOB.paymentId,
      worker: opts.worker ?? worker.publicKey,
      agentSigner: agent.publicKey,
      resultHash: '11'.repeat(32),
    }),
  );
  transaction.partialSign(feePayer);
  return transaction;
}

const encode = (transaction: Transaction) =>
  btoa(String.fromCharCode(...transaction.serialize({ requireAllSignatures: false })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('merchant as Task Vault worker', () => {
  it('publishes its worker key, and says when it has none', async () => {
    const res = await handleRequest(new Request('https://merchant.test/worker'), ENV);
    expect(await res.json()).toEqual({ pubkey: worker.publicKey.toBase58(), wallet: ENV.MERCHANT_WALLET, network: 'solana:devnet' });
    const unset = await handleRequest(new Request('https://merchant.test/worker'), { ...ENV, WORKER_SECRET_KEY: undefined });
    expect(unset.status).toBe(503);
  });

  it('delivers a signed output bound to the held escrow', async () => {
    rpcReturns(escrowData());
    const res = await post('/worker/jobs', JOB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workerPubkey: string; workerSignature: string; resultHash: string; resultPayload: Record<string, unknown> };
    expect(body.workerPubkey).toBe(worker.publicKey.toBase58());
    expect(body.resultHash).toBe(computeOutputHash(body.resultPayload));
    expect(body.resultPayload).toMatchObject({ status: 'completed', serviceId: JOB.serviceId, requestHash: JOB.requestHash });
    const message = new TextEncoder().encode(`NEXUS_RECEIPT_V1:${JOB.taskId}:${JOB.paymentId}:${body.resultHash}`);
    expect(nacl.sign.detached.verify(message, bs58.decode(body.workerSignature), worker.publicKey.toBytes())).toBe(true);
  });

  it('delivers a failed output on purpose for the invalid demo scenario', async () => {
    rpcReturns(escrowData());
    const body = (await (await post('/worker/jobs', { ...JOB, scenario: 'invalid_schema' })).json()) as { resultPayload: Record<string, unknown> };
    expect(body.resultPayload).toMatchObject({ status: 'failed', error: 'worker_output_incomplete' });
  });

  it.each([
    ['no escrow on-chain', null, {}, 404, 'escrow_not_found'],
    ['an escrow for another worker', escrowData({ worker: Keypair.generate().publicKey }), {}, 403, 'escrow_not_for_this_worker'],
    ['an escrow already settled', escrowData({ status: 1 }), {}, 409, 'escrow_not_held'],
    ['a different service', escrowData(), { serviceId: 'other-service' }, 409, 'service_mismatch'],
    ['a different request', escrowData(), { requestHash: 'request-2' }, 409, 'request_mismatch'],
  ])('refuses a job for %s', async (_label, data, override, status, error) => {
    rpcReturns(data);
    const res = await post('/worker/jobs', { ...JOB, ...override });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('rejects a malformed job without reading the chain', async () => {
    const fetchMock = rpcReturns(escrowData());
    expect((await post('/worker/jobs', { ...JOB, taskId: '' })).status).toBe(400);
    expect((await post('/worker/jobs', { ...JOB, scenario: 'wrong_service' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('co-signs a settlement that pays it for a held escrow', async () => {
    rpcReturns(escrowData());
    const transaction = settlementTransaction();
    const res = await post('/worker/settlements', { transaction: encode(transaction) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workerPubkey: string; signature: string };
    transaction.addSignature(worker.publicKey, Buffer.from(bs58.decode(body.signature)));
    expect(transaction.verifySignatures()).toBe(true);
  });

  it.each([
    ['the worker pays the fee', () => settlementTransaction({ feePayer: worker }), escrowData(), 400, 'worker_cannot_pay_fee'],
    ['it carries another instruction', () => settlementTransaction({ extra: true }), escrowData(), 400, 'not_a_settlement'],
    ['it settles for another worker', () => settlementTransaction({ worker: Keypair.generate().publicKey }), escrowData(), 403, 'settlement_not_for_this_worker'],
    ['the escrow is no longer held', () => settlementTransaction(), escrowData({ status: 2 }), 409, 'escrow_not_held'],
  ])('refuses to co-sign when %s', async (_label, build, data, status, error) => {
    rpcReturns(data);
    const res = await post('/worker/settlements', { transaction: encode(build()) });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });

  it('refuses bytes that are not a transaction', async () => {
    expect((await post('/worker/settlements', { transaction: btoa('not a transaction') })).status).toBe(400);
    expect((await post('/worker/settlements', {})).status).toBe(400);
  });
});
