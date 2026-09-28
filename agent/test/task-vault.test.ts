import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  TASK_VAULT_DOMAIN_SEPARATOR,
  TASK_VAULT_PROGRAM_ID,
  TASK_VAULT_PROGRAM_PUBKEY,
  TaskCapabilityRecordSchema,
  TaskPaymentRecordSchema,
  TaskReceiptRecordSchema,
  computeTaskHash,
  computeReceiptHash,
  computeCanonicalSeed,
  validateTaskTransition,
  deriveTaskCapabilityPda,
  deriveVaultPda,
  deriveEscrowPda,
  deriveReceiptPda,
  createAndFundTaskInstruction,
  executeTaskPaymentInstruction,
  settleWithReceiptInstruction,
  closeReceiptInstruction,
  revokeTaskInstruction,
  refundAndCloseInstruction,
  refundExpiredEscrowInstruction,
  to32ByteArray,
} from '@nexus/shared';
import { Store } from '../src/store.js';
import { AuditLog } from '../src/audit.js';

describe('Phase 0: Task Capability Vault - Domain & State Machine', () => {
  const dummyOwner = '11111111111111111111111111111111';
  const dummyAgent = '22222222222222222222222222222222';
  const dummyWorker = '33333333333333333333333333333333';

  it('validates TaskCapabilityRecordSchema', () => {
    const valid = TaskCapabilityRecordSchema.safeParse({
      owner: dummyOwner,
      agentSigner: dummyAgent,
      taskId: 'task-abc-123',
      budgetLamports: 1_000_000_000,
      spentLamports: 0,
      perPaymentCapLamports: 500_000_000,
      expiry: 1800000000,
      status: 'active',
    });
    expect(valid.success).toBe(true);

    const invalid = TaskCapabilityRecordSchema.safeParse({
      owner: 'invalid-address',
      agentSigner: dummyAgent,
      taskId: 'task-1',
      budgetLamports: -1,
      expiry: 0,
    });
    expect(invalid.success).toBe(false);
  });

  it('validates TaskPaymentRecordSchema and TaskReceiptRecordSchema', () => {
    const payment = TaskPaymentRecordSchema.safeParse({
      taskId: 'task-abc-123',
      paymentId: 'pay-001',
      worker: dummyWorker,
      serviceId: 'srv-weather',
      amountLamports: 200_000_000,
      requestHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      status: 'held',
    });
    expect(payment.success).toBe(true);

    const receipt = TaskReceiptRecordSchema.safeParse({
      taskId: 'task-abc-123',
      paymentId: 'pay-001',
      worker: dummyWorker,
      serviceId: 'srv-weather',
      requestHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      resultHash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      amountLamports: 200_000_000,
      settledAt: 1750000000,
    });
    expect(receipt.success).toBe(true);
  });

  describe('State Transition Table', () => {
    const baseTask = {
      status: 'active' as const,
      expiry: 1000,
      budgetLamports: 1_000_000_000,
      spentLamports: 200_000_000,
      perPaymentCapLamports: 400_000_000,
    };

    it('allows execute_payment within budget and cap', () => {
      const res = validateTaskTransition(
        baseTask,
        { type: 'execute_payment', amountLamports: 300_000_000 },
        500,
      );
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('active');
    });

    it('rejects execute_payment exceeding per_payment_cap', () => {
      const res = validateTaskTransition(
        baseTask,
        { type: 'execute_payment', amountLamports: 500_000_000 },
        500,
      );
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/per-payment cap/i);
    });

    it('rejects execute_payment exceeding remaining budget', () => {
      const taskNearLimit = { ...baseTask, spentLamports: 900_000_000 };
      const res = validateTaskTransition(
        taskNearLimit,
        { type: 'execute_payment', amountLamports: 200_000_000 },
        500,
      );
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/remaining budget/i);
    });

    it('rejects execute_payment after expiry', () => {
      const res = validateTaskTransition(
        baseTask,
        { type: 'execute_payment', amountLamports: 100_000_000 },
        1001,
      );
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/expired/i);
    });

    it('settles payment and stays active if budget remains', () => {
      const res = validateTaskTransition(
        baseTask,
        { type: 'settle_payment', paymentId: 'pay-1' },
        500,
      );
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('active');
    });

    it('settles payment and transitions to completed if budget is fully spent and no pending remain', () => {
      const taskFullySpent = { ...baseTask, spentLamports: 1_000_000_000 };
      const res = validateTaskTransition(
        taskFullySpent,
        { type: 'settle_payment', paymentId: 'pay-1', remainingPendingEscrows: 0 },
        500,
      );
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('completed');
    });

    it('settles payment and stays active if budget is fully spent but pending escrows remain', () => {
      const taskFullySpent = { ...baseTask, spentLamports: 1_000_000_000 };
      const res = validateTaskTransition(
        taskFullySpent,
        { type: 'settle_payment', paymentId: 'pay-1', remainingPendingEscrows: 1 },
        500,
      );
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('active');
    });

    it('validates allowedWorker and allowedServiceId when specified', () => {
      const scopedTask = {
        ...baseTask,
        allowedWorker: dummyWorker,
        allowedServiceId: 'srv-specific',
      };

      const matchRes = validateTaskTransition(
        scopedTask,
        {
          type: 'execute_payment',
          amountLamports: 100_000_000,
          worker: dummyWorker,
          serviceId: 'srv-specific',
        },
        500,
      );
      expect(matchRes.valid).toBe(true);

      const badWorkerRes = validateTaskTransition(
        scopedTask,
        {
          type: 'execute_payment',
          amountLamports: 100_000_000,
          worker: dummyAgent,
          serviceId: 'srv-specific',
        },
        500,
      );
      expect(badWorkerRes.valid).toBe(false);
      expect(badWorkerRes.error).toMatch(/worker .* is not allowed/i);

      const badServiceRes = validateTaskTransition(
        scopedTask,
        {
          type: 'execute_payment',
          amountLamports: 100_000_000,
          worker: dummyWorker,
          serviceId: 'srv-different',
        },
        500,
      );
      expect(badServiceRes.valid).toBe(false);
      expect(badServiceRes.error).toMatch(/service .* is not allowed/i);
    });

    it('transitions to revoked on revoke action', () => {
      const res = validateTaskTransition(baseTask, { type: 'revoke' }, 500);
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('revoked');
    });

    it('transitions to expired when time exceeds expiry', () => {
      const res = validateTaskTransition(baseTask, { type: 'expire' }, 1001);
      expect(res.valid).toBe(true);
      expect(res.nextStatus).toBe('expired');
    });

    it('rejects expire transition if time is still before expiry', () => {
      const res = validateTaskTransition(baseTask, { type: 'expire' }, 999);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/not arrived/i);
    });

    it('allows refund_and_close from active, revoked, expired, and completed', () => {
      for (const st of ['active', 'revoked', 'expired', 'completed'] as const) {
        const res = validateTaskTransition(
          { ...baseTask, status: st },
          { type: 'refund_and_close' },
          1200,
        );
        expect(res.valid).toBe(true);
        expect(res.nextStatus).toBe('closed');
      }
    });
  });

  describe('Test Vectors & Deterministic Hashing', () => {
    it('produces bit-for-bit identical hash to Node crypto sha256 for task hash', () => {
      const taskInput = {
        owner: dummyOwner,
        taskId: 'task-test-vector-001',
        budgetLamports: 1_000_000_000,
        perPaymentCapLamports: 250_000_000,
        expiry: 1750000000,
      };

      const computed = computeTaskHash(taskInput);

      // Compare directly against Node.js crypto.createHash
      const canonicalString = `${TASK_VAULT_DOMAIN_SEPARATOR}:task:${taskInput.owner}:${taskInput.taskId}:${taskInput.budgetLamports}:${taskInput.perPaymentCapLamports}:${taskInput.expiry}`;
      const nodeExpected = createHash('sha256').update(canonicalString).digest('hex');

      expect(computed).toBe(nodeExpected);
      expect(computed).toHaveLength(64);
    });

    it('produces bit-for-bit identical hash to Node crypto sha256 for receipt hash', () => {
      const receiptInput = {
        taskId: 'task-test-vector-001',
        paymentId: 'pay-test-vector-001',
        worker: dummyWorker,
        serviceId: 'service-eval-node',
        requestHash: 'aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd',
        resultHash: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
        amountLamports: 250_000_000,
      };

      const computed = computeReceiptHash(receiptInput);

      const canonicalString = `${TASK_VAULT_DOMAIN_SEPARATOR}:receipt:${receiptInput.taskId}:${receiptInput.paymentId}:${receiptInput.worker}:${receiptInput.serviceId}:${receiptInput.requestHash}:${receiptInput.resultHash}:${receiptInput.amountLamports}`;
      const nodeExpected = createHash('sha256').update(canonicalString).digest('hex');

      expect(computed).toBe(nodeExpected);
      expect(computed).toHaveLength(64);
    });

    it('binds domain separator so cross-domain replay fails', () => {
      const input = {
        owner: dummyOwner,
        taskId: 'task-001',
        budgetLamports: 1000,
        perPaymentCapLamports: 500,
        expiry: 2000,
      };

      const defaultHash = computeTaskHash(input);
      const forgedDomainHash = computeTaskHash({
        ...input,
        domainSeparator: 'FORGED_OTHER_VAULT_V1',
      });

      expect(defaultHash).not.toBe(forgedDomainHash);
    });
  });

  describe('Client PDA Derivations and Instruction Builders', () => {
    const owner = Keypair.generate().publicKey;
    const agent = Keypair.generate().publicKey;
    const worker = Keypair.generate().publicKey;
    const taskId = 'task-test-pda-001';
    const paymentId = 'pay-test-pda-001';

    it('derives capability, vault, escrow and receipt PDAs deterministically', () => {
      const [capPda, capBump] = deriveTaskCapabilityPda(owner, taskId);
      expect(capPda).toBeInstanceOf(PublicKey);
      expect(capBump).toBeGreaterThanOrEqual(0);

      const [vaultPda, vaultBump] = deriveVaultPda(capPda);
      expect(vaultPda).toBeInstanceOf(PublicKey);
      expect(vaultBump).toBeGreaterThanOrEqual(0);

      const [escrowPda, escrowBump] = deriveEscrowPda(capPda, paymentId);
      expect(escrowPda).toBeInstanceOf(PublicKey);
      expect(escrowBump).toBeGreaterThanOrEqual(0);

      const [receiptPda, receiptBump] = deriveReceiptPda(capPda, paymentId);
      expect(receiptPda).toBeInstanceOf(PublicKey);
      expect(receiptBump).toBeGreaterThanOrEqual(0);

      // Verify that differing task IDs yield different PDAs
      const [otherCapPda] = deriveTaskCapabilityPda(owner, 'different-task-id');
      expect(otherCapPda.toBase58()).not.toBe(capPda.toBase58());
    });

    it('builds valid create_and_fund_task instruction', () => {
      const ix = createAndFundTaskInstruction({
        owner,
        agentSigner: agent,
        taskId,
        budgetLamports: 1_000_000_000,
        perPaymentCapLamports: 250_000_000,
        allowedWorker: worker,
        allowedServiceId: 'service-allowlisted',
        expirySeconds: 1750000000,
      });

      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(4);
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(owner.toBase58());
      expect(ix.keys[2]!.isSigner).toBe(true);
      expect(ix.data.length).toBe(8 + 32 + 8 + 8 + 8 + 32 + 32 + 32);
      expect(ix.data.subarray(96, 128)).toEqual(worker.toBuffer());
      expect(ix.data.subarray(128, 160)).toEqual(Buffer.from(to32ByteArray('service-allowlisted')));
    });

    it('builds a create_and_fund_task instruction without a global Buffer', () => {
      vi.stubGlobal('Buffer', undefined);
      try {
        const ix = createAndFundTaskInstruction({
          owner,
          agentSigner: agent,
          taskId,
          budgetLamports: 10_000_000,
          perPaymentCapLamports: 10_000_000,
          allowedWorker: worker,
          expirySeconds: 1750000000,
        });

        expect(ix.data.length).toBe(160);
        expect(ix.keys[2]!.pubkey.toBase58()).toBe(owner.toBase58());
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('builds valid execute_task_payment instruction', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const ix = executeTaskPaymentInstruction({
        taskCapability: capPda,
        owner,
        agentSigner: agent,
        worker,
        paymentId,
        amountLamports: 200_000_000,
        serviceId: 'service-eval',
        requestHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      });

      const [receiptPda] = deriveReceiptPda(capPda, paymentId);
      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(7);
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(receiptPda.toBase58());
      expect(ix.keys[3]!.isWritable).toBe(false);
      expect(ix.keys[5]!.pubkey.toBase58()).toBe(agent.toBase58());
      expect(ix.keys[5]!.isSigner).toBe(true);
      expect(ix.data.length).toBe(8 + 32 + 8 + 32 + 32);
    });

    it('builds valid settle_with_receipt instruction', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const [escrowPda] = deriveEscrowPda(capPda, paymentId);
      const ix = settleWithReceiptInstruction({
        taskCapability: capPda,
        escrow: escrowPda,
        paymentId,
        worker,
        agentSigner: agent,
        resultHash: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      });

      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(6);
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(worker.toBase58());
      expect(ix.keys[3]!.isSigner).toBe(true);
      expect(ix.keys[4]!.pubkey.toBase58()).toBe(agent.toBase58());
      expect(ix.keys[4]!.isWritable).toBe(true);
      expect(ix.data.length).toBe(8 + 32);
    });

    it('builds valid revoke_task instruction', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const ix = revokeTaskInstruction({
        taskCapability: capPda,
        owner,
      });

      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(2);
      expect(ix.keys[1]!.pubkey.toBase58()).toBe(owner.toBase58());
      expect(ix.keys[1]!.isSigner).toBe(true);
      expect(ix.data.length).toBe(8);
    });

    it('builds valid refund_and_close instruction', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const caller = Keypair.generate().publicKey;
      const ix = refundAndCloseInstruction({
        taskCapability: capPda,
        owner,
        caller,
      });

      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(4);
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(owner.toBase58());
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(caller.toBase58());
      expect(ix.keys[3]!.isSigner).toBe(true);
      expect(ix.data.length).toBe(8);
    });

    it('builds valid refund_expired_escrow instruction', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const [escrowPda] = deriveEscrowPda(capPda, paymentId);
      const caller = Keypair.generate().publicKey;
      const ix = refundExpiredEscrowInstruction({
        taskCapability: capPda,
        escrow: escrowPda,
        owner,
        agentSigner: agent,
        caller,
      });

      expect(ix.programId.toBase58()).toBe(TASK_VAULT_PROGRAM_PUBKEY.toBase58());
      expect(ix.keys).toHaveLength(5);
      expect(ix.keys[1]!.pubkey.toBase58()).toBe(escrowPda.toBase58());
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(owner.toBase58());
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(agent.toBase58());
      expect(ix.keys[4]!.pubkey.toBase58()).toBe(caller.toBase58());
      expect(ix.keys[4]!.isSigner).toBe(true);
      expect(ix.data.length).toBe(8);
    });

    it('builds close_receipt accounts in Anchor context order and sends rent to authority', () => {
      const [capPda] = deriveTaskCapabilityPda(owner, taskId);
      const [receiptPda] = deriveReceiptPda(capPda, paymentId);
      const ix = closeReceiptInstruction({
        taskCapability: capPda,
        receipt: receiptPda,
        authority: worker,
        rentRecipient: worker,
      });

      expect(ix.keys[0]!.pubkey.toBase58()).toBe(capPda.toBase58());
      expect(ix.keys[1]!.pubkey.toBase58()).toBe(receiptPda.toBase58());
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(worker.toBase58());
      expect(ix.keys[2]!.isSigner).toBe(true);
      expect(ix.keys[3]!.pubkey.toBase58()).toBe(worker.toBase58());
      expect(ix.keys[3]!.isWritable).toBe(true);
    });
  });

  describe('Canonical Seed & Collision Resistance (Finding 4)', () => {
    it('produces distinct 32-byte seeds for IDs sharing >32 byte prefixes', () => {
      const prefix = 'nexus-task-with-very-long-prefix-that-exceeds-32-bytes-';
      const id1 = `${prefix}alpha`;
      const id2 = `${prefix}beta`;

      const seed1 = computeCanonicalSeed(id1);
      const seed2 = computeCanonicalSeed(id2);

      expect(seed1).toHaveLength(32);
      expect(seed2).toHaveLength(32);
      expect(seed1).not.toEqual(seed2);
    });

    it('derives distinct PDAs for IDs with identical prefixes >32 chars', () => {
      const owner = Keypair.generate().publicKey;
      const prefix = 'a'.repeat(40);
      const [pda1] = deriveTaskCapabilityPda(owner, `${prefix}-1`);
      const [pda2] = deriveTaskCapabilityPda(owner, `${prefix}-2`);
      expect(pda1.toBase58()).not.toBe(pda2.toBase58());
    });
  });

  describe('Store Duplicate Protection (Finding 4)', () => {
    it('rejects duplicate task insert when allowOverwrite is false', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nexus-store-dup-test-'));
      const store = new Store(join(dir, 'state.json'), 'test-agent', 100);
      const task = {
        owner: '11111111111111111111111111111111',
        agentSigner: '22222222222222222222222222222222',
        taskId: 'unique-task-001',
        budgetLamports: 1000,
        spentLamports: 0,
        perPaymentCapLamports: 500,
        expiry: 9999999999,
        status: 'active' as const,
      };
      store.setTask(task);
      expect(() => store.setTask(task)).toThrowError(/already exists/i);
      expect(() => store.setTask(task, { allowOverwrite: true })).not.toThrow();
    });

    it('rejects duplicate payment insert when allowOverwrite is false', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nexus-store-dup-test-'));
      const store = new Store(join(dir, 'state.json'), 'test-agent', 100);
      const payment = {
        taskId: 'task-1',
        paymentId: 'pay-dup-001',
        worker: '11111111111111111111111111111111',
        serviceId: 'srv-1',
        amountLamports: 100,
        requestHash: 'req-hash',
        status: 'held' as const,
      };
      store.setPayment(payment);
      expect(() => store.setPayment(payment)).toThrowError(/already exists/i);
      expect(() => store.setPayment(payment, { allowOverwrite: true })).not.toThrow();
    });
  });

  describe('Audit Log Tamper Evidence & Cryptographic Verification (Finding 5)', () => {
    it('verifies integrity of untampered audit log and detects deletions, reordering, and tampering', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nexus-audit-test-'));
      const auditPath = join(dir, 'audit.jsonl');
      const saltPath = join(dir, 'salt');
      const audit = new AuditLog(auditPath, saltPath, 'test-audit-passphrase');

      audit.record('event_1', null, { data: 'one' });
      audit.record('event_2', null, { data: 'two' });
      audit.record('event_3', null, { data: 'three' });

      // Clean log passes
      expect(audit.verifyIntegrity().valid).toBe(true);

      // Tampering payload/event breaks hash check
      const raw = readFileSync(auditPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const tamperedEntry = JSON.parse(lines[1]!);
      tamperedEntry.event = 'event_2_tampered';
      const tamperedLines = [lines[0]!, JSON.stringify(tamperedEntry), lines[2]!];
      writeFileSync(auditPath, `${tamperedLines.join('\n')}\n`);
      const tamperedRes = audit.verifyIntegrity();
      expect(tamperedRes.valid).toBe(false);

      // Deleting middle line breaks hash chain
      const deletedLines = [lines[0]!, lines[2]!];
      writeFileSync(auditPath, `${deletedLines.join('\n')}\n`);
      const deletedRes = audit.verifyIntegrity();
      expect(deletedRes.valid).toBe(false);
      expect(deletedRes.reason).toBe('broken_hash_chain');

      // Reordering lines breaks hash chain
      const reorderedLines = [lines[1]!, lines[0]!, lines[2]!];
      writeFileSync(auditPath, `${reorderedLines.join('\n')}\n`);
      const reorderRes = audit.verifyIntegrity();
      expect(reorderRes.valid).toBe(false);
      expect(reorderRes.reason).toBe('broken_hash_chain');
    });
  });
});
