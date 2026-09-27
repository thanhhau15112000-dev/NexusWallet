import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction, Connection } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  TASK_VAULT_PROGRAM_PUBKEY,
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
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';
import { registerRoutes } from '../src/routes.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const RPC_URL = 'http://127.0.0.1:8899';
const SERVICE_ID = 'task-vault-persistence-e2e';

describe('Task Vault Persistence and Browser Refresh Lifecycle', () => {
  it('preserves multi-payment state, receipts, and terminal states across server restarts and browser reloads', async (ctx) => {
    const connection = new Connection(RPC_URL, 'confirmed');
    try {
      await connection.getVersion();
    } catch {
      ctx.skip();
      return;
    }

    // Isolate persistent directory
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-task-vault-persistence-'));
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

    const owner = Keypair.generate();
    const ownerPubkey = owner.publicKey.toBase58();
    // The mock worker key is generated per data dir and must survive restarts.
    const worker = createContext(config).mockWorker!;

    // Airdrop funds for on-chain testing
    const airdrop = async (pubkey: PublicKey, sol: number) => {
      const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    };
    // The worker is deliberately left unfunded: settlement must be paid for by the agent.
    await airdrop(owner.publicKey, 4);

    // Helper to spin up Fastify instance with persistence
    const startServer = async () => {
      const appContext = createContext(config);
      const userContext = appContext.getUserContext!(ownerPubkey);
      userContext.connection = connection;
      await airdrop(userContext.signer.publicKey, 1);

      const server = Fastify();
      await server.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
      await registerRoutes(server, appContext);
      return { server, appContext, userContext };
    };

    // Helper to authenticate session
    const authenticate = async (server: FastifyInstance) => {
      const challengeRes = await server.inject({
        method: 'POST',
        url: '/api/auth/challenge',
        payload: { pubkey: ownerPubkey },
      });
      const challenge = JSON.parse(challengeRes.body);
      const loginSignature = bs58.encode(
        nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey),
      );
      const loginRes = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { challengeId: challenge.challengeId, pubkey: ownerPubkey, signature: loginSignature },
      });
      const sessionCookie = loginRes.cookies.find((item) => item.name === SESSION_COOKIE_NAME);
      return `${sessionCookie!.name}=${sessionCookie!.value}`;
    };

    // 1. START INITIAL SERVER SESSION
    let { server: app1, userContext: userContext1 } = await startServer();
    let cookieHeader1 = await authenticate(app1);

    const taskId = `task-persistence-${Date.now().toString(36)}`;
    const budgetLamports = 500_000_000; // 0.5 SOL
    const capLamports = 200_000_000;    // 0.2 SOL
    const expiry = Math.floor(Date.now() / 1000) + 3600;

    // Create and fund task on chain and register with API
    const createIx = createAndFundTaskInstruction({
      owner: owner.publicKey,
      agentSigner: userContext1.signer.publicKey,
      taskId,
      budgetLamports,
      perPaymentCapLamports: capLamports,
      allowedWorker: worker.publicKey,
      allowedServiceId: SERVICE_ID,
      expiry,
    });
    const createSig = await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [owner], {
      commitment: 'confirmed',
    });

    const createRes = await app1.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: cookieHeader1 },
      payload: {
        taskId,
        budgetLamports,
        perPaymentCapLamports: capLamports,
        expiry,
        allowedWorker: worker.publicKey.toBase58(),
        allowedServiceId: SERVICE_ID,
        txSignature: createSig,
        isSimulated: false,
      },
    });
    expect(createRes.statusCode).toBe(200);

    // Execute Payment 1 (150,000,000 lamports = 0.15 SOL)
    const payRes1 = await app1.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments`,
      headers: { cookie: cookieHeader1 },
      payload: {
        paymentId: 'pay-001',
        worker: worker.publicKey.toBase58(),
        serviceId: SERVICE_ID,
        amountLamports: 150_000_000,
        requestHash: 'req-hash-001',
      },
    });
    expect(payRes1.statusCode).toBe(200);

    // Settle Payment 1
    const runRes1 = await app1.inject({
      method: 'POST',
      url: '/api/tasks/mock-service/run',
      headers: { cookie: cookieHeader1 },
      payload: { taskId, paymentId: 'pay-001', serviceId: SERVICE_ID, payload: { p: 1 } },
    });
    const result1 = JSON.parse(runRes1.body);
    const settleRes1 = await app1.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments/pay-001/settle`,
      headers: { cookie: cookieHeader1 },
      payload: {
        resultHash: result1.resultHash,
        workerPubkey: result1.workerPubkey,
        workerSignature: result1.workerSignature,
      },
    });
    expect(settleRes1.statusCode).toBe(200);

    // Execute Payment 2 (100,000,000 lamports = 0.10 SOL) in same task
    const payRes2 = await app1.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments`,
      headers: { cookie: cookieHeader1 },
      payload: {
        paymentId: 'pay-002',
        worker: worker.publicKey.toBase58(),
        serviceId: SERVICE_ID,
        amountLamports: 100_000_000,
        requestHash: 'req-hash-002',
      },
    });
    expect(payRes2.statusCode).toBe(200);

    // Inspect pre-restart state
    const preRestartDetailRes = await app1.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookieHeader1 },
    });
    const preRestartDetail = JSON.parse(preRestartDetailRes.body);
    expect(preRestartDetail.task.spentLamports).toBe(250_000_000);
    expect(preRestartDetail.task.budgetLamports - preRestartDetail.task.spentLamports).toBe(250_000_000);
    expect(preRestartDetail.payments).toHaveLength(2);
    expect(preRestartDetail.receipts).toHaveLength(1);

    // 2. SIMULATE AGENT SERVER RESTART / CRASH RECOVERY
    // Stop server instance 1
    await app1.close();

    // Start server instance 2 pointing to identical persistent data directory
    const { server: app2, userContext: userContext2 } = await startServer();
    const cookieHeader2 = await authenticate(app2);

    // 3. SIMULATE BROWSER PAGE RELOAD / REFRESH (Dashboard reload queries)
    // 3a. Query task list (like TaskVaultPanel.loadTasks)
    const listReloadRes = await app2.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { cookie: cookieHeader2 },
    });
    expect(listReloadRes.statusCode).toBe(200);
    const loadedTasks = JSON.parse(listReloadRes.body).tasks;
    const restoredTask = loadedTasks.find((t: any) => t.taskId === taskId);
    expect(restoredTask).toBeDefined();
    expect(restoredTask.status).toBe('active');
    expect(restoredTask.budgetLamports).toBe(budgetLamports);
    expect(restoredTask.spentLamports).toBe(250_000_000);
    expect(restoredTask.budgetLamports - restoredTask.spentLamports).toBe(250_000_000);

    // 3b. Query task detail (like TaskVaultPanel.selectTask)
    const detailReloadRes = await app2.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookieHeader2 },
    });
    expect(detailReloadRes.statusCode).toBe(200);
    const detailReload = JSON.parse(detailReloadRes.body);

    // Verify all multi-payment and receipt state survived reload perfectly
    expect(detailReload.task.taskId).toBe(taskId);
    expect(detailReload.payments).toHaveLength(2);
    expect(detailReload.payments[0].paymentId).toBe('pay-001');
    expect(detailReload.payments[0].status).toBe('settled');
    expect(detailReload.payments[1].paymentId).toBe('pay-002');
    expect(detailReload.payments[1].status).toBe('held');
    expect(detailReload.receipts).toHaveLength(1);
    expect(detailReload.receipts[0].paymentId).toBe('pay-001');

    // 4. CONTINUE WORKFLOW POST-RESTART: Settle Payment 2
    const runRes2 = await app2.inject({
      method: 'POST',
      url: '/api/tasks/mock-service/run',
      headers: { cookie: cookieHeader2 },
      payload: { taskId, paymentId: 'pay-002', serviceId: SERVICE_ID, payload: { p: 2 } },
    });
    const result2 = JSON.parse(runRes2.body);
    const settleRes2 = await app2.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/payments/pay-002/settle`,
      headers: { cookie: cookieHeader2 },
      payload: {
        resultHash: result2.resultHash,
        workerPubkey: result2.workerPubkey,
        workerSignature: result2.workerSignature,
      },
    });
    expect(settleRes2.statusCode).toBe(200);

    // 5. POST-RESTART REFUND & CLOSE
    const [taskPda] = deriveTaskCapabilityPda(owner.publicKey, taskId);
    const refundIx = refundAndCloseInstruction({
      taskCapability: taskPda,
      owner: owner.publicKey,
      caller: owner.publicKey,
    });
    const refundSig = await sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [owner], {
      commitment: 'confirmed',
    });
    const refundRes = await app2.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/refund`,
      headers: { cookie: cookieHeader2 },
      payload: { txSignature: refundSig },
    });
    expect(refundRes.statusCode).toBe(200);
    expect(JSON.parse(refundRes.body).refundedLamports).toBe(250_000_000);
    expect(JSON.parse(refundRes.body).task.isClosed).toBe(true);

    // 6. SECOND BROWSER REFRESH AFTER TASK CLOSE
    const afterCloseReloadRes = await app2.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: cookieHeader2 },
    });
    expect(afterCloseReloadRes.statusCode).toBe(200);
    const afterCloseDetail = JSON.parse(afterCloseReloadRes.body);
    expect(afterCloseDetail.task.isClosed).toBe(true);
    expect(afterCloseDetail.payments).toHaveLength(2);
    expect(afterCloseDetail.receipts).toHaveLength(2);

    await app2.close();
  }, 60000);
});
