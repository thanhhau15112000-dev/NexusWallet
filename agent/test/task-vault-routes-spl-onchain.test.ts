import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  createAndFundTaskInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  deriveAssociatedTokenAddress,
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
import { submitOutput } from './task-output-helpers.js';

const RPC_URL = process.env.TASK_VAULT_TEST_RPC_URL ?? 'http://127.0.0.1:8899';
const SERVICE_ID = 'task-vault-spl-e2e';

describe('Task Vault API with a token budget on the local Solana program', () => {
  it('settles a token escrow through the API to a worker that holds neither SOL nor a token account', async (ctx) => {
    const connection = new Connection(RPC_URL, 'confirmed');
    try {
      await connection.getVersion();
    } catch {
      ctx.skip();
      return;
    }

    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-task-vault-spl-routes-'));
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

    try {
      const worker = appContext.mockWorker!;
      for (const [pubkey, sol] of [[owner.publicKey, 3], [userContext.signer.publicKey, 1]] as const) {
        await connection.confirmTransaction(await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL), 'confirmed');
      }
      const mint = await createMint(connection, owner, owner.publicKey, null, 6);
      const ownerAta = (await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey)).address;
      await mintTo(connection, owner, mint, ownerAta, owner, 5_000_000);

      const challenge = JSON.parse((await app.inject({
        method: 'POST', url: '/api/auth/challenge', payload: { pubkey: ownerPubkey },
      })).body);
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          challengeId: challenge.challengeId,
          pubkey: ownerPubkey,
          signature: bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), owner.secretKey)),
        },
      });
      const sessionCookie = loginRes.cookies.find((item) => item.name === SESSION_COOKIE_NAME)!;
      const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}`;

      const taskId = `spl-api-${Date.now().toString(36)}`;
      const budget = 2_000_000;
      const amount = 700_000;
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const [taskPda] = deriveTaskCapabilityPda(owner.publicKey, taskId);
      const [vault] = deriveVaultPda(taskPda);
      const createSignature = await sendAndConfirmTransaction(connection, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(owner.publicKey, vault, mint),
        createAndFundTaskInstruction({
          owner: owner.publicKey,
          agentSigner: userContext.signer.publicKey,
          taskId,
          budgetLamports: budget,
          perPaymentCapLamports: budget,
          allowedWorker: worker.publicKey,
          allowedServiceId: SERVICE_ID,
          expiry,
          mint,
        }),
      ), [owner], { commitment: 'confirmed' });
      const created = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: cookieHeader },
        payload: {
          taskId,
          budgetLamports: budget,
          perPaymentCapLamports: budget,
          expiry,
          allowedWorker: worker.publicKey.toBase58(),
          allowedServiceId: SERVICE_ID,
          mint: mint.toBase58(),
          txSignature: createSignature,
          isSimulated: false,
        },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().task.mintDecimals).toBe(6);

      // A paymentId at the maximum length: the settlement must still fit in one transaction.
      const paymentId = 'p'.repeat(64);
      const payment = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments`,
        headers: { cookie: cookieHeader },
        payload: { paymentId, worker: worker.publicKey.toBase58(), serviceId: SERVICE_ID, amountLamports: amount, requestHash: `request-${taskId}` },
      });
      expect(payment.statusCode).toBe(200);

      expect(await connection.getBalance(worker.publicKey, 'confirmed')).toBe(0);
      const workerAta = deriveAssociatedTokenAddress(worker.publicKey, mint);
      expect(await connection.getAccountInfo(workerAta, 'confirmed')).toBeNull();

      const accepted = await submitOutput(app, cookieHeader, taskId, paymentId, worker.secretKey, owner.secretKey, { report: 'done' });
      const settled = await app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/payments/${paymentId}/settle`,
        headers: { cookie: cookieHeader },
        payload: accepted,
      });
      expect(settled.statusCode, settled.body).toBe(200);
      expect(settled.json().receipt.txSignature).toBeTruthy();
      expect((await getAccount(connection, workerAta, 'confirmed')).amount).toBe(BigInt(amount));
      expect((await getAccount(connection, deriveAssociatedTokenAddress(vault, mint), 'confirmed')).amount).toBe(BigInt(budget - amount));

      const revokeSignature = await sendAndConfirmTransaction(connection, new Transaction().add(
        revokeTaskInstruction({ taskCapability: taskPda, owner: owner.publicKey }),
      ), [owner], { commitment: 'confirmed' });
      expect((await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/revoke`, headers: { cookie: cookieHeader }, payload: { txSignature: revokeSignature },
      })).statusCode).toBe(200);
      const refundSignature = await sendAndConfirmTransaction(connection, new Transaction().add(
        refundAndCloseInstruction({ taskCapability: taskPda, owner: owner.publicKey, caller: owner.publicKey, mint }),
      ), [owner], { commitment: 'confirmed' });
      const refunded = await app.inject({
        method: 'POST', url: `/api/tasks/${taskId}/refund`, headers: { cookie: cookieHeader }, payload: { txSignature: refundSignature },
      });
      expect(refunded.statusCode).toBe(200);
      expect(refunded.json().refundedLamports).toBe(budget - amount);
      expect((await getAccount(connection, ownerAta, 'confirmed')).amount).toBe(BigInt(5_000_000 - amount));
    } finally {
      await app.close();
    }
  }, 120_000);
});
