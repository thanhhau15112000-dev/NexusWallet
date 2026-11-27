import { describe, expect, it } from 'vitest';
import {
  Connection,
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import {
  computeTaskAcceptanceMessage,
  createAndFundTaskInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  deriveAssociatedTokenAddress,
  deriveEscrowPda,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  executeTaskPaymentInstruction,
  refundAndCloseInstruction,
  refundExpiredEscrowInstruction,
  revokeTaskInstruction,
  settleAcceptedOutputInstruction,
} from '@nexus/shared';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';

const INVALID_TOKEN_ACCOUNT = /0x1786/;
const TOKEN_ACCOUNTS_REQUIRED = /0x1785/;
const OWNER_ACCEPTANCE_REQUIRED = /0x1784/;

describe('Task Vault token budget on a real Solana validator', () => {
  const rpcUrl = process.env.TASK_VAULT_TEST_RPC_URL ?? 'http://127.0.0.1:8899';
  const connection = new Connection(rpcUrl, 'confirmed');
  const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: 'confirmed' });
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const tokenAmount = async (address: PublicKey) => (await getAccount(connection, address, 'confirmed')).amount;

  async function setup() {
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const worker = Keypair.generate();
    const stranger = Keypair.generate();
    for (const [key, sol] of [[owner, 3], [agent, 1], [worker, 1], [stranger, 1]] as const) {
      await connection.confirmTransaction(await connection.requestAirdrop(key.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
    }
    const mint = await createMint(connection, owner, owner.publicKey, null, 6);
    const ownerAta = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
    await mintTo(connection, owner, mint, ownerAta.address, owner, 5_000_000);
    return { owner, agent, worker, stranger, mint, ownerAta: ownerAta.address };
  }

  async function createTask(env: Awaited<ReturnType<typeof setup>>, taskId: string, expiry: number, budget = 1_000_000) {
    const [task] = deriveTaskCapabilityPda(env.owner.publicKey, taskId);
    const [vault] = deriveVaultPda(task);
    await send([
      createAssociatedTokenAccountIdempotentInstruction(env.owner.publicKey, vault, env.mint),
      createAndFundTaskInstruction({
        owner: env.owner.publicKey,
        agentSigner: env.agent.publicKey,
        taskId,
        budgetLamports: budget,
        perPaymentCapLamports: 600_000,
        allowedWorker: env.worker.publicKey,
        allowedServiceId: 'report-v1',
        expiry,
        mint: env.mint,
      }),
    ], [env.owner]);
    return { task, vault, vaultAta: deriveAssociatedTokenAddress(vault, env.mint) };
  }

  function pay(env: Awaited<ReturnType<typeof setup>>, task: PublicKey, paymentId: string, amount: number) {
    return send([executeTaskPaymentInstruction({
      taskCapability: task,
      agentSigner: env.agent.publicKey,
      worker: env.worker.publicKey,
      paymentId,
      amountLamports: amount,
      serviceId: 'report-v1',
      requestHash: digest(`request:${paymentId}`),
    })], [env.agent]);
  }

  it('funds, escrows, settles and refunds a token budget', async (ctx) => {
    try {
      await connection.getVersion();
    } catch {
      console.log('Skipping on-chain test: local Solana validator (127.0.0.1:8899) is not running.');
      ctx.skip();
      return;
    }
    const env = await setup();
    const taskId = `spl-${Date.now().toString(36)}`;
    const { task, vaultAta } = await createTask(env, taskId, Math.floor(Date.now() / 1000) + 3600);

    expect(await tokenAmount(vaultAta)).toBe(1_000_000n);
    expect(await tokenAmount(env.ownerAta)).toBe(4_000_000n);
    const capability = await connection.getAccountInfo(task);
    expect(capability!.data.length).toBe(239);
    expect(new PublicKey(capability!.data.subarray(207, 239)).equals(env.mint)).toBe(true);

    // The escrow records the amount; the tokens stay in the vault until settlement.
    const paymentId = 'spl-pay-1';
    const [escrow] = deriveEscrowPda(task, paymentId);
    await pay(env, task, paymentId, 400_000);
    expect(await tokenAmount(vaultAta)).toBe(1_000_000n);
    const escrowRent = await connection.getMinimumBalanceForRentExemption(178);
    expect((await connection.getAccountInfo(escrow))!.lamports).toBe(escrowRent);

    const resultHash = digest('result:spl-pay-1');
    const acceptance = (mint?: PublicKey) => {
      const message = Buffer.from(computeTaskAcceptanceMessage({
        taskCapability: task, escrow, requestHash: digest(`request:${paymentId}`), resultHash, amountLamports: 400_000, mint,
      }));
      return Ed25519Program.createInstructionWithPublicKey({
        publicKey: env.owner.publicKey.toBytes(), message, signature: nacl.sign.detached(message, env.owner.secretKey),
      });
    };
    const settle = settleAcceptedOutputInstruction({
      taskCapability: task, escrow, paymentId, worker: env.worker.publicKey, agentSigner: env.agent.publicKey, resultHash, mint: env.mint,
    });
    const workerAtaIx = createAssociatedTokenAccountIdempotentInstruction(env.worker.publicKey, env.worker.publicKey, env.mint);

    // The SOL wording of the acceptance does not authorize a token payout.
    await expect(send([workerAtaIx, acceptance(), settle], [env.worker])).rejects.toThrow(OWNER_ACCEPTANCE_REQUIRED);
    // Without the token accounts a token escrow cannot be settled.
    const settleWithoutTokens = settleAcceptedOutputInstruction({
      taskCapability: task, escrow, paymentId, worker: env.worker.publicKey, agentSigner: env.agent.publicKey, resultHash,
    });
    await expect(send([acceptance(env.mint), settleWithoutTokens], [env.worker])).rejects.toThrow(TOKEN_ACCOUNTS_REQUIRED);
    // The payout cannot be redirected to another token account.
    const strangerAta = await getOrCreateAssociatedTokenAccount(connection, env.stranger, env.mint, env.stranger.publicKey);
    const redirected = new TransactionInstruction({
      ...settle,
      keys: settle.keys.map((key, index) => (index === 9 ? { ...key, pubkey: strangerAta.address } : key)),
    });
    await expect(send([workerAtaIx, acceptance(env.mint), redirected], [env.worker])).rejects.toThrow(INVALID_TOKEN_ACCOUNT);

    const agentBefore = await connection.getBalance(env.agent.publicKey);
    await send([workerAtaIx, acceptance(env.mint), settle], [env.worker]);
    expect(await tokenAmount(deriveAssociatedTokenAddress(env.worker.publicKey, env.mint))).toBe(400_000n);
    expect(await tokenAmount(vaultAta)).toBe(600_000n);
    expect(await connection.getAccountInfo(escrow)).toBeNull();
    expect(await connection.getBalance(env.agent.publicKey)).toBe(agentBefore + escrowRent);

    // After a revoke anyone may close the task, but the remainder only goes to the owner's ATA.
    await send([revokeTaskInstruction({ taskCapability: task, owner: env.owner.publicKey })], [env.owner]);
    const refund = refundAndCloseInstruction({
      taskCapability: task, owner: env.owner.publicKey, caller: env.stranger.publicKey, mint: env.mint,
    });
    const stolen = new TransactionInstruction({
      ...refund,
      keys: refund.keys.map((key, index) => (index === 5 ? { ...key, pubkey: strangerAta.address } : key)),
    });
    await expect(send([stolen], [env.stranger])).rejects.toThrow(INVALID_TOKEN_ACCOUNT);

    await send([refund], [env.stranger]);
    expect(await tokenAmount(env.ownerAta)).toBe(4_600_000n);
    expect(await tokenAmount(strangerAta.address)).toBe(0n);
    for (const closed of [task, deriveVaultPda(task)[0], vaultAta]) {
      expect(await connection.getAccountInfo(closed)).toBeNull();
    }
  }, 120_000);

  it('returns an expired token escrow to the owner through the vault', async (ctx) => {
    try {
      await connection.getVersion();
    } catch {
      ctx.skip();
      return;
    }
    const env = await setup();
    const { task, vaultAta } = await createTask(env, `spl-exp-${Date.now().toString(36)}`, Math.floor(Date.now() / 1000) + 10);
    const paymentId = 'spl-exp-pay';
    const [escrow] = deriveEscrowPda(task, paymentId);
    await pay(env, task, paymentId, 500_000);

    // Wait until the cluster clock passes the expiry.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const blockTime = await connection.getBlockTime(await connection.getSlot('confirmed'));
      const info = await connection.getAccountInfo(task);
      const expiry = Number(info!.data.readBigInt64LE(128));
      if (blockTime !== null && blockTime > expiry) break;
      if (Date.now() > deadline) throw new Error('validator clock did not pass task expiry');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const agentBefore = await connection.getBalance(env.agent.publicKey);
    const escrowLamports = (await connection.getAccountInfo(escrow))!.lamports;
    await send([refundExpiredEscrowInstruction({
      taskCapability: task, escrow, owner: env.owner.publicKey, agentSigner: env.agent.publicKey, caller: env.stranger.publicKey,
    })], [env.stranger]);
    expect(await connection.getAccountInfo(escrow)).toBeNull();
    expect(await connection.getBalance(env.agent.publicKey)).toBe(agentBefore + escrowLamports);
    expect(await tokenAmount(vaultAta)).toBe(1_000_000n);

    await send([refundAndCloseInstruction({
      taskCapability: task, owner: env.owner.publicKey, caller: env.stranger.publicKey, mint: env.mint,
    })], [env.stranger]);
    expect(await tokenAmount(env.ownerAta)).toBe(5_000_000n);
    expect(await connection.getAccountInfo(vaultAta)).toBeNull();
  }, 120_000);
});
