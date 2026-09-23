import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultPolicy,
  solToLamports,
  type ActionPlan,
  type IntentEnvelope,
  type ModelContext,
  type StageMeta,
} from '@nexus/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute, runCommand } from '../src/pipeline.js';
import { Store } from '../src/store.js';
import type { AppContext } from '../src/context.js';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const tempDirs: string[] = [];
const trace: StageMeta = { name: 'mock', model: 'deterministic', fallback: true, ms: 0 };

function makeContext(overrides: {
  understand?: () => Promise<{ value: IntentEnvelope; meta: StageMeta }>;
  plan?: () => Promise<{ value: ActionPlan; meta: StageMeta }>;
} = {}): AppContext {
  const tempDir = mkdtempSync(join(tmpdir(), 'nexus-pipeline-test-'));
  tempDirs.push(tempDir);
  const store = new Store(join(tempDir, 'state.json'), 'agent-001', 50);
  store.setPolicy({
    ...defaultPolicy('agent-001'),
    maxSolLamportsPerTx: solToLamports(0.1),
    allowedRecipients: [{ label: 'treasury', address: TREASURY }],
    allowedMints: [],
    maxTokenAmountByMint: {},
  });

  const intent: IntentEnvelope = {
    goal: 'send SOL',
    operation: 'transfer_sol',
    entities: { recipient: 'treasury', amount: 0.01, asset: 'SOL' },
    riskNotes: [],
    confidence: 0.9,
    requiresHuman: false,
  };
  const plan: ActionPlan = {
    action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.01 },
    rationale: 'test transfer',
    confidence: 0.9,
  };

  return {
    config: {
      AGENT_ID: 'agent-001',
      SOLANA_CLUSTER: 'devnet',
      APPROVAL_TTL_SECONDS: 300,
    } as AppContext['config'],
    store,
    audit: { record: vi.fn() } as never,
    model: {
      understand: overrides.understand ?? vi.fn().mockResolvedValue({ value: intent, meta: trace }),
      plan: overrides.plan ?? vi.fn().mockResolvedValue({ value: plan, meta: trace }),
      describe: () => ({ stage1: 'mock:deterministic', stage2: 'mock:deterministic', mode: 'mock' }),
    },
    connection: { getBalance: vi.fn().mockResolvedValue(0) } as never,
    signer: {} as never,
    agentPubkey: TREASURY,
    ownerPinned: false,
  };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('runCommand lifecycle guards', () => {
  it('reuses one in-flight result for concurrent idempotent retries', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const understand = vi.fn(async () => {
      await gate;
      return {
        value: {
          goal: 'read balance',
          operation: 'get_balance' as const,
          entities: {},
          riskNotes: [],
          confidence: 1,
          requiresHuman: false,
        },
        meta: trace,
      };
    });
    const plan = vi.fn(async () => ({
      value: { action: { type: 'get_balance' as const }, rationale: 'read', confidence: 1 },
      meta: trace,
    }));
    const ctx = makeContext({ understand, plan });

    const first = runCommand(ctx, { prompt: 'what is the balance?', idempotencyKey: 'same-key' });
    const second = runCommand(ctx, { prompt: 'what is the balance?', idempotencyKey: 'same-key' });

    expect(understand).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    release();
    const [one, two] = await Promise.all([first, second]);

    expect(one.id).toBe(two.id);
    expect(one.status).toBe('confirmed');
    expect(two.status).toBe('confirmed');
    expect(ctx.store.listRequests()).toHaveLength(1);
  });

  it('denies a planner amount that differs from the classified intent', async () => {
    const ctx = makeContext({
      plan: vi.fn().mockResolvedValue({
        value: {
          action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.09 },
          rationale: 'planner changed the amount',
          confidence: 0.9,
        },
        meta: trace,
      }),
    });

    const request = await runCommand(ctx, { prompt: 'send 0.01 SOL to treasury' });

    expect(request.status).toBe('denied');
    expect(request.decision?.reasons).toContain('model plan does not match the classified intent');
  });

  it('denies a planner recipient change even when both recipients are allowlisted', async () => {
    const backupAddress = '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM';
    const ctx = makeContext({
      plan: vi.fn().mockResolvedValue({
        value: {
          action: { type: 'transfer_sol', recipient: 'backup', amountSol: 0.01 },
          rationale: 'planner changed the recipient',
          confidence: 0.9,
        },
        meta: trace,
      }),
    });
    ctx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(0.1),
      allowedRecipients: [
        { label: 'treasury', address: TREASURY },
        { label: 'backup', address: backupAddress },
      ],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    const request = await runCommand(ctx, { prompt: 'send 0.01 SOL to treasury' });

    expect(request.status).toBe('denied');
    expect(request.decision?.reasons).toContain('model plan does not match the classified intent');
  });

  it('matches an SPL mint label to the same allowlisted mint address', async () => {
    const mintAddress = 'So11111111111111111111111111111111111111112';
    const ctx = makeContext({
      understand: vi.fn().mockResolvedValue({
        value: {
          goal: 'send token',
          operation: 'transfer_spl',
          entities: { recipient: 'treasury', amount: 1.25, asset: 'test-token' },
          riskNotes: [],
          confidence: 0.9,
          requiresHuman: false,
        },
        meta: trace,
      }),
      plan: vi.fn().mockResolvedValue({
        value: {
          action: { type: 'transfer_spl', recipient: 'treasury', mint: mintAddress, amount: 1.25 },
          rationale: 'test token transfer',
          confidence: 0.9,
        },
        meta: trace,
      }),
    });
    ctx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(0.1),
      allowedRecipients: [{ label: 'treasury', address: TREASURY }],
      allowedMints: [{ label: 'test-token', address: mintAddress }],
      maxTokenAmountByMint: { [mintAddress]: 1 },
    });

    const request = await runCommand(ctx, { prompt: 'send 1.25 test-token to treasury' });

    expect(request.status).toBe('pending_approval');
    expect(request.decision?.verdict).toBe('require_approval');
    expect(request.decision?.resolved).toMatchObject({ type: 'transfer_spl', mint: mintAddress });
  });

  it('preserves a model-requested human gate for an otherwise allowed transfer', async () => {
    const ctx = makeContext({
      understand: vi.fn().mockResolvedValue({
        value: {
          goal: 'send with review',
          operation: 'transfer_sol',
          entities: { recipient: 'treasury', amount: 0.01, asset: 'SOL' },
          riskNotes: [],
          confidence: 0.8,
          requiresHuman: true,
        },
        meta: trace,
      }),
    });

    const request = await runCommand(ctx, { prompt: 'send 0.01 SOL to treasury' });

    expect(request.status).toBe('pending_approval');
    expect(request.decision?.verdict).toBe('require_approval');
    expect(request.decision?.reasons).toContain('model requested human approval');
  });

  it('denies a planner transfer when the classifier marked the request unknown', async () => {
    const ctx = makeContext({
      understand: vi.fn().mockResolvedValue({
        value: {
          goal: 'ambiguous request',
          operation: 'unknown',
          entities: {},
          riskNotes: ['missing amount'],
          confidence: 0.1,
          requiresHuman: true,
        },
        meta: trace,
      }),
    });

    const request = await runCommand(ctx, { prompt: 'do something with the wallet' });

    expect(request.status).toBe('denied');
    expect(request.decision?.reasons).toContain('model plan does not match the classified intent');
  });

  it('evaluates the policy version that exists after model planning', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = makeContext({
      understand: vi.fn(async () => {
        await gate;
        return {
          value: {
            goal: 'send SOL',
            operation: 'transfer_sol' as const,
            entities: { recipient: 'treasury', amount: 0.05, asset: 'SOL' },
            riskNotes: [],
            confidence: 0.9,
            requiresHuman: false,
          },
          meta: trace,
        };
      }),
      plan: vi.fn().mockResolvedValue({
        value: {
          action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
          rationale: 'test transfer',
          confidence: 0.9,
        },
        meta: trace,
      }),
    });
    const pending = runCommand(ctx, { prompt: 'send 0.05 SOL to treasury', idempotencyKey: 'policy-race' });
    await Promise.resolve();
    ctx.store.setPolicy({
      maxSolLamportsPerTx: 0,
      allowedRecipients: [{ label: 'treasury', address: TREASURY }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });
    release();

    const request = await pending;

    expect(request.status).toBe('pending_approval');
    expect(request.decision?.policyVersion).toBe(ctx.store.getPolicy().version);
    expect(request.decision?.verdict).toBe('require_approval');
  });

  it('blocks an auto-approved transfer when the policy changes before execution', async () => {
    const ctx = makeContext({
      understand: vi.fn().mockResolvedValue({
        value: {
          goal: 'send with review',
          operation: 'transfer_sol',
          entities: { recipient: 'treasury', amount: 0.01, asset: 'SOL' },
          riskNotes: [],
          confidence: 0.8,
          requiresHuman: true,
        },
        meta: trace,
      }),
    });
    const request = await runCommand(ctx, { prompt: 'send 0.01 SOL to treasury' });
    ctx.store.setPolicy({
      maxSolLamportsPerTx: 0,
      allowedRecipients: [{ label: 'treasury', address: TREASURY }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    const blocked = await execute(ctx, { ...request, status: 'auto_approved' });

    expect(blocked.status).toBe('denied');
    expect(blocked.error).toMatchObject({ code: 'policy_changed' });
  });
});
