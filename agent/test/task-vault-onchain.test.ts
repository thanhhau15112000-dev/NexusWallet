import { describe, expect, it } from 'vitest';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  TASK_VAULT_PROGRAM_PUBKEY,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  deriveEscrowPda,
  deriveReceiptPda,
  createAndFundTaskInstruction,
  executeTaskPaymentInstruction,
  settleWithReceiptInstruction,
  closeReceiptInstruction,
  refundAndCloseInstruction,
  toHex,
} from '@nexus/shared';
import { createHash } from 'node:crypto';

describe('Phase 1 & On-chain Proof: Real Solana Program Execution', () => {
  const rpcUrl = 'http://127.0.0.1:8899';
  const connection = new Connection(rpcUrl, 'confirmed');

  it('executes full task vault lifecycle on real Solana validator', async (ctx) => {
    try {
      await connection.getVersion();
    } catch {
      console.log('Skipping on-chain test: local Solana validator (127.0.0.1:8899) is not running.');
      ctx.skip();
      return;
    }

    // 1. Setup accounts
    const owner = Keypair.generate();
    const agent = Keypair.generate();
    const worker = Keypair.generate();

    // Airdrop funds to owner and agent
    const airdropSig1 = await connection.requestAirdrop(owner.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig1, 'confirmed');

    const airdropSig2 = await connection.requestAirdrop(agent.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig2, 'confirmed');

    const airdropSig3 = await connection.requestAirdrop(worker.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(airdropSig3, 'confirmed');

    const ownerBalanceBefore = await connection.getBalance(owner.publicKey);
    expect(ownerBalanceBefore).toBe(5 * LAMPORTS_PER_SOL);

    const now = Math.floor(Date.now() / 1000);
    const taskId = `onchain-${Date.now().toString(36)}`;
    const budgetLamports = 1 * LAMPORTS_PER_SOL; // 1 SOL
    const paymentCapLamports = 500_000_000; // 0.5 SOL
    const expiry = now + 3600;
    const serviceId = 'weather-oracle-v1';

    const [taskCapPda] = deriveTaskCapabilityPda(owner.publicKey, taskId);
    const [vaultPda] = deriveVaultPda(taskCapPda);

    // 2. Owner executes create_and_fund_task on-chain
    const createIx = createAndFundTaskInstruction({
      owner: owner.publicKey,
      agentSigner: agent.publicKey,
      taskId,
      budgetLamports,
      perPaymentCapLamports: paymentCapLamports,
      allowedWorker: worker.publicKey,
      allowedServiceId: serviceId,
      expiry,
    });

    const createTx = new Transaction().add(createIx);
    const createSig = await sendAndConfirmTransaction(connection, createTx, [owner], {
      commitment: 'confirmed',
    });
    expect(createSig).toBeDefined();

    // Verify on-chain state after creation
    const vaultBalanceAfterCreate = await connection.getBalance(vaultPda);
    expect(vaultBalanceAfterCreate).toBeGreaterThanOrEqual(budgetLamports);

    const taskCapAccount = await connection.getAccountInfo(taskCapPda);
    expect(taskCapAccount).not.toBeNull();
    expect(taskCapAccount!.owner.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());

    // 3. Agent executes execute_task_payment on-chain to lock escrow
    const paymentId = 'pay-onchain-001';
    const paymentAmount = 300_000_000; // 0.3 SOL
    const requestHash = createHash('sha256').update('get_temperature:HN').digest();

    const [escrowPda] = deriveEscrowPda(taskCapPda, paymentId);

    const unauthorizedWorkerIx = executeTaskPaymentInstruction({
      taskCapability: taskCapPda,
      agentSigner: agent.publicKey,
      worker: Keypair.generate().publicKey,
      paymentId,
      amountLamports: paymentAmount,
      serviceId,
      requestHash,
    });
    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(unauthorizedWorkerIx), [agent], {
        commitment: 'confirmed',
      }),
    ).rejects.toThrow();

    const unauthorizedServiceIx = executeTaskPaymentInstruction({
      taskCapability: taskCapPda,
      agentSigner: agent.publicKey,
      worker: worker.publicKey,
      paymentId,
      amountLamports: paymentAmount,
      serviceId: 'different-service',
      requestHash,
    });
    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(unauthorizedServiceIx), [agent], {
        commitment: 'confirmed',
      }),
    ).rejects.toThrow();

    const payIx = executeTaskPaymentInstruction({
      taskCapability: taskCapPda,
      agentSigner: agent.publicKey,
      worker: worker.publicKey,
      paymentId,
      amountLamports: paymentAmount,
      serviceId,
      requestHash,
    });

    const payTx = new Transaction().add(payIx);
    const paySig = await sendAndConfirmTransaction(connection, payTx, [agent], {
      commitment: 'confirmed',
    });
    expect(paySig).toBeDefined();

    // Verify escrow account exists and holds the funds
    const escrowAccount = await connection.getAccountInfo(escrowPda);
    expect(escrowAccount).not.toBeNull();
    expect(escrowAccount!.owner.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
    expect(escrowAccount!.lamports).toBeGreaterThanOrEqual(paymentAmount);

    // 4. Invariant Check (Finding 2): Attempt to refund & close while escrow is held -> MUST FAIL
    const prematureRefundIx = refundAndCloseInstruction({
      taskCapability: taskCapPda,
      owner: owner.publicKey,
      caller: owner.publicKey,
    });
    const prematureRefundTx = new Transaction().add(prematureRefundIx);
    await expect(
      sendAndConfirmTransaction(connection, prematureRefundTx, [owner], {
        commitment: 'confirmed',
      }),
    ).rejects.toThrow();

    // 5. Worker settles with receipt on-chain
    const resultHash = createHash('sha256').update('temp:28C:humidity:70%').digest();
    const workerBalanceBefore = await connection.getBalance(worker.publicKey);
    const agentBalanceBeforeSettle = await connection.getBalance(agent.publicKey);

    const settleIx = settleWithReceiptInstruction({
      taskCapability: taskCapPda,
      escrow: escrowPda,
      paymentId,
      worker: worker.publicKey,
      agentSigner: agent.publicKey,
      resultHash,
    });

    const settleTx = new Transaction().add(settleIx);
    const settleSig = await sendAndConfirmTransaction(connection, settleTx, [worker], {
      commitment: 'confirmed',
    });
    expect(settleSig).toBeDefined();

    // Verify agent received rent refund from closed escrow
    const agentBalanceAfterSettle = await connection.getBalance(agent.publicKey);
    expect(agentBalanceAfterSettle).toBeGreaterThan(agentBalanceBeforeSettle);

    // Verify worker received the payment (paymentAmount minus receipt PDA account rent and fee)
    const workerBalanceAfter = await connection.getBalance(worker.publicKey);
    expect(workerBalanceAfter).toBeGreaterThan(workerBalanceBefore + paymentAmount - 5_000_000);

    // Verify receipt PDA was initialized
    const [receiptPda] = deriveReceiptPda(taskCapPda, paymentId);
    const receiptAccount = await connection.getAccountInfo(receiptPda);
    expect(receiptAccount).not.toBeNull();
    expect(receiptAccount!.owner.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());

    const workerBalanceBeforeClose = await connection.getBalance(worker.publicKey);
    const redirectedRentIx = closeReceiptInstruction({
      taskCapability: taskCapPda,
      receipt: receiptPda,
      authority: worker.publicKey,
      rentRecipient: owner.publicKey,
    });
    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(redirectedRentIx), [worker], {
        commitment: 'confirmed',
      }),
    ).rejects.toThrow();
    expect(await connection.getAccountInfo(receiptPda)).not.toBeNull();

    const closeReceiptIx = closeReceiptInstruction({
      taskCapability: taskCapPda,
      receipt: receiptPda,
      authority: worker.publicKey,
      rentRecipient: worker.publicKey,
    });
    const closeReceiptTx = new Transaction().add(closeReceiptIx);
    const closeReceiptSig = await sendAndConfirmTransaction(connection, closeReceiptTx, [worker], {
      commitment: 'confirmed',
    });
    expect(closeReceiptSig).toBeDefined();
    expect(await connection.getAccountInfo(receiptPda)).toBeNull();
    expect(await connection.getBalance(worker.publicKey)).toBeGreaterThan(workerBalanceBeforeClose);

    // Verify escrow account was closed (lamports == 0 and data zeroed)
    const closedEscrowAccount = await connection.getAccountInfo(escrowPda);
    expect(closedEscrowAccount === null || closedEscrowAccount.lamports === 0).toBe(true);

    // 6. Owner executes refund_and_close on-chain
    const refundIx = refundAndCloseInstruction({
      taskCapability: taskCapPda,
      owner: owner.publicKey,
      caller: owner.publicKey,
    });

    const refundTx = new Transaction().add(refundIx);
    const refundSig = await sendAndConfirmTransaction(connection, refundTx, [owner], {
      commitment: 'confirmed',
    });
    expect(refundSig).toBeDefined();

    // Verify vault and task capability accounts were closed and refunded
    const closedVaultAccount = await connection.getAccountInfo(vaultPda);
    expect(closedVaultAccount === null || closedVaultAccount.lamports === 0).toBe(true);

    const closedTaskCapAccount = await connection.getAccountInfo(taskCapPda);
    expect(closedTaskCapAccount === null || closedTaskCapAccount.lamports === 0).toBe(true);
  }, 30000);
});
