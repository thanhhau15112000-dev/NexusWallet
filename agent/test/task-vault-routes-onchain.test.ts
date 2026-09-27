import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction, Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  TASK_VAULT_PROGRAM_PUBKEY,
  closeReceiptInstruction,
  createAndFundTaskInstruction,
  deriveEscrowPda,
  deriveReceiptPda,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  refundAndCloseInstruction,
  revokeTaskInstruction,
} from '@nexus/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeCanonicalSeed } from '@nexus/shared';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const RPC_URL = 'http://127.0.0.1:8899';
const SERVICE_ID = 'task-vault-local-e2e';

describe('Task Vault API with the local Solana program', () => {
  it('runs funded multi-payment settlement, receipt close, refund, and revoke on the validator', async (ctx) => {
    const connection = new Connection(RPC_URL, 'confirmed');
    try {
      await connection.getVersion();
    } catch {
      ctx.skip();
      return;
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-task-vault-onchain-routes-'));
    const config = {
      ...loadConfig(),
      AGENT_DATA_DIR: dataDir,
      dataDir,
      usersDir: join(dataDir, 'users'),
      masterFunderPath: join(dataDir, 'master-funder.json'),
      legacyKeystorePath: join(dataDir, 'agent-keystore.json'),
      statePath: join(dataDir, 'state.json'),
      auditPath: join(dataDir, 'audit.jsonl'),
      keystorePath: join(dataDir, 'agent-keystore.json'),
      saltPath: join(dataDir, 'audit-salt'),
    };
    const appContext = createContext(config);
    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    const userContext = appContext.getUserContext!(ownerPubkey);
    userContext.connection = connection;

    const app = Fastify();
    await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
    await registerRoutes(app, appContext);

    const airdrop = async (pubkey: PublicKey, sol: number) => {
      const signature = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature, 'confirmed');
    };

    try {
      const worker = Keypair.fromSeed(computeCanonicalSeed('NEXUS_DEFAULT_MOCK_WORKER_V1'));
      await Promise.all([
        airdrop(owner.publicKey, 3),
        airdrop(userContext.signer.publicKey, 1),
        airdrop(worker.publicKey, 1),
      ]);

      const challengeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/challenge',
        payload: { pubkey: ownerPubkey },
      });
      const challenge = JSON.parse(challengeRes.body);
      const loginSignature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey),
      );
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { challengeId: challenge.challengeId, pubkey: ownerPubkey, signature: loginSignature },
      });
      const sessionCookie = loginRes.cookies.find((item) => item.name === SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      const cookieHeader = `${sessionCookie!.name}=${sessionCookie!.value}`;

      const createTask = async (taskId: string, budgetLamports: number, capLamports: number) => {
        const expiry = Math.floor(Date.now() / 1000) + 3600;
        const createIx = createAndFundTaskInstruction({
          owner: owner.publicKey,
          agentSigner: userContext.signer.publicKey,
          taskId,
          budgetLamports,
          perPaymentCapLamports: capLamports,
          allowedWorker: worker.publicKey,
          allowedServiceId: SERVICE_ID,
          expiry,
        });
        const signature = await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [owner], {
          commitment: 'confirmed',
        });
        const response = await app.inject({
          method: 'POST',
          url: '/api/tasks',
          headers: { cookie: cookieHeader },
          payload: {
            taskId,
            budgetLamports,
            perPaymentCapLamports: capLamports,
            expiry,
            allowedWorker: worker.publicKey.toBase58(),
            allowedServiceId: SERVICE_ID,
            txSignature: signature,
            isSimulated: false,
          },
        });
        expect(response.statusCode).toBe(200);
        expect(JSON.parse(response.body).task.isSimulated).toBe(false);
        return { expiry, signature };
      };

      const taskId = `onchain-api-${Date.now().toString(36)}`;
      await createTask(taskId, 700_000_000, 300_000_000);
      const [taskPda] = deriveTaskCapabilityPda(owner.publicKey, taskId);

      const createPayment = async (paymentId: string, amountLamports: number) => app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId,
          worker: worker.publicKey.toBase58(),
          serviceId: SERVICE_ID,
          amountLamports,
          requestHash: `request-${paymentId}`,
        },
      });

      const payment1 = await createPayment('pay-local-1', 300_000_000);
      expect(payment1.statusCode).toBe(200);
      expect(JSON.parse(payment1.body).payment.isSimulated).toBe(false);
      expect(JSON.parse(payment1.body).payment.txSignature).toBeTruthy();
      const payment2 = await createPayment('pay-local-2', 300_000_000);
      expect(payment2.statusCode).toBe(200);

      const overBudget = await createPayment('pay-local-over-budget', 200_000_000);
      expect(overBudget.statusCode).toBe(400);
      expect(JSON.parse(overBudget.body).error).toBe('payment_rejected');

      const settlePayment = async (paymentId: string) => {
        const serviceResponse = await app.inject({
          method: 'POST',
          url: '/api/tasks/mock-service/run',
          headers: { cookie: cookieHeader },
          payload: { taskId, paymentId, serviceId: SERVICE_ID, payload: { paymentId } },
        });
        const serviceResult = JSON.parse(serviceResponse.body);
        return app.inject({
          method: 'POST',
          url: `/api/tasks/${taskId}/payments/${paymentId}/settle`,
          headers: { cookie: cookieHeader },
          payload: {
            resultHash: serviceResult.resultHash,
            workerPubkey: serviceResult.workerPubkey,
            workerSignature: serviceResult.workerSignature,
          },
        });
      };

      const settle1 = await settlePayment('pay-local-1');
      expect(settle1.statusCode).toBe(200);
      expect(JSON.parse(settle1.body).receipt.isSimulated).toBe(false);
      const afterFirstSettle = await app.inject({
        method: 'GET',
        url: `/api/tasks/${taskId}`,
        headers: { cookie: cookieHeader },
      });
      expect(JSON.parse(afterFirstSettle.body).task.status).toBe('active');

      const settle2 = await settlePayment('pay-local-2');
      expect(settle2.statusCode).toBe(200);
      expect(JSON.parse(settle2.body).receipt.txSignature).toBeTruthy();

      // Receipts are replay guards, so they can only be closed after the task stops accepting payments.
      const taskRevokeSignature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(revokeTaskInstruction({ taskCapability: taskPda, owner: owner.publicKey })),
        [owner],
        { commitment: 'confirmed' },
      );
      const taskRevokeResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/revoke`,
        headers: { cookie: cookieHeader },
        payload: { txSignature: taskRevokeSignature },
      });
      expect(taskRevokeResponse.statusCode).toBe(200);

      const [receiptPda] = deriveReceiptPda(taskPda, 'pay-local-1');
      const closeReceiptIx = closeReceiptInstruction({
        taskCapability: taskPda,
        receipt: receiptPda,
        authority: owner.publicKey,
        rentRecipient: worker.publicKey,
      });
      const closeReceiptSignature = await sendAndConfirmTransaction(connection, new Transaction().add(closeReceiptIx), [owner], {
        commitment: 'confirmed',
      });
      expect(await connection.getAccountInfo(receiptPda)).toBeNull();
      const closeReceiptResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/receipts/pay-local-1/close`,
        headers: { cookie: cookieHeader },
        payload: { txSignature: closeReceiptSignature },
      });
      expect(closeReceiptResponse.statusCode).toBe(200);
      expect(JSON.parse(closeReceiptResponse.body).receipt.isClosed).toBe(true);

      const refundIx = refundAndCloseInstruction({
        taskCapability: taskPda,
        owner: owner.publicKey,
        caller: owner.publicKey,
      });
      const refundSignature = await sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [owner], {
        commitment: 'confirmed',
      });
      const refundResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/refund`,
        headers: { cookie: cookieHeader },
        payload: { txSignature: refundSignature },
      });
      expect(refundResponse.statusCode).toBe(200);
      expect(JSON.parse(refundResponse.body).refundedLamports).toBe(100_000_000);
      expect(JSON.parse(refundResponse.body).task.isClosed).toBe(true);

      const revokeTaskId = `onchain-revoke-${Date.now().toString(36)}`;
      await createTask(revokeTaskId, 100_000_000, 100_000_000);
      const [revokePda] = deriveTaskCapabilityPda(owner.publicKey, revokeTaskId);
      const revokeIx = revokeTaskInstruction({ taskCapability: revokePda, owner: owner.publicKey });
      const revokeSignature = await sendAndConfirmTransaction(connection, new Transaction().add(revokeIx), [owner], {
        commitment: 'confirmed',
      });
      const revokeResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${revokeTaskId}/revoke`,
        headers: { cookie: cookieHeader },
        payload: { txSignature: revokeSignature },
      });
      expect(revokeResponse.statusCode).toBe(200);
      expect(JSON.parse(revokeResponse.body).task.status).toBe('revoked');

      const paymentAfterRevoke = await app.inject({
        method: 'POST',
        url: `/api/tasks/${revokeTaskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: {
          paymentId: 'pay-after-revoke',
          worker: worker.publicKey.toBase58(),
          serviceId: SERVICE_ID,
          amountLamports: 1,
          requestHash: 'request-after-revoke',
        },
      });
      expect(paymentAfterRevoke.statusCode).toBe(400);
      expect(JSON.parse(paymentAfterRevoke.body).error).toBe('payment_rejected');

      const revokeRefundIx = refundAndCloseInstruction({
        taskCapability: revokePda,
        owner: owner.publicKey,
        caller: owner.publicKey,
      });
      const revokeRefundSignature = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(revokeRefundIx),
        [owner],
        { commitment: 'confirmed' },
      );
      const revokeRefund = await app.inject({
        method: 'POST',
        url: `/api/tasks/${revokeTaskId}/refund`,
        headers: { cookie: cookieHeader },
        payload: { txSignature: revokeRefundSignature },
      });
      expect(revokeRefund.statusCode).toBe(200);

      expect(TASK_VAULT_PROGRAM_PUBKEY.toBase58()).toBe('3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK');
      const [vaultPda] = deriveVaultPda(taskPda);
      expect(await connection.getAccountInfo(vaultPda)).toBeNull();
      expect(await connection.getAccountInfo(taskPda)).toBeNull();
      expect(await connection.getAccountInfo(deriveEscrowPda(taskPda, 'pay-local-1')[0])).toBeNull();
    } finally {
      await app.close();
    }
  }, 60000);
});
