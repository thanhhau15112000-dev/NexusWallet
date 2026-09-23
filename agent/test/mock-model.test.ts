import { describe, expect, it } from 'vitest';
import {
  evaluatePolicy,
  defaultPolicy,
  solToLamports,
  type ModelContext,
  type Policy,
} from '@nexus/shared';
import { mockPlan, mockUnderstand } from '../src/model/mock.js';


const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OUTSIDER = '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM';

const ctx: ModelContext = {
  agentId: 'agent-001',
  cluster: 'devnet',
  maxSolPerTx: solToLamports(0.1),
  recipients: [{ label: 'treasury', address: TREASURY }],
  mints: [],
};

const policy: Policy = {
  ...defaultPolicy('agent-001'),
  maxSolLamportsPerTx: solToLamports(0.1),
  allowedRecipients: [{ label: 'treasury', address: TREASURY }],
};

function run(prompt: string) {
  const intent = mockUnderstand(prompt, ctx);
  const plan = mockPlan(intent, ctx);
  return { intent, plan, decision: evaluatePolicy(policy, plan.action) };
}

describe('deterministic fallback pipeline', () => {
  it('routes an under-limit transfer to an automatic allow', () => {
    const { plan, decision } = run('send 0.05 SOL to treasury');
    expect(plan.action).toMatchObject({ type: 'transfer_sol', amountSol: 0.05 });
    expect(decision.verdict).toBe('allow');
  });

  it('routes an over-limit transfer to owner approval', () => {
    const { plan, decision } = run('send 0.5 SOL to treasury');
    expect(plan.action).toMatchObject({ type: 'transfer_sol', amountSol: 0.5 });
    expect(decision.verdict).toBe('require_approval');
  });

  it('routes an off-allowlist recipient to a deny', () => {
    const { plan, decision } = run(`send 0.01 SOL to ${OUTSIDER}`);
    expect(plan.action).toMatchObject({ type: 'transfer_sol', recipient: OUTSIDER });
    expect(decision.verdict).toBe('deny');
  });

  it('recognises a balance question', () => {
    const { plan, decision } = run('what is the agent balance?');
    expect(plan.action).toMatchObject({ type: 'get_balance' });
    expect(decision.verdict).toBe('allow');
  });

  it('falls back to manual approval when the prompt has no usable amount', () => {
    const { plan } = run('please move some money around');
    expect(plan.action.type).toBe('request_manual_approval');
  });

  it('does not parse the first digit of an address as a transfer amount', () => {
    const intent = mockUnderstand(`send SOL to ${TREASURY}`, ctx);

    expect(intent.operation).toBe('unknown');
    expect(intent.entities.amount).toBeUndefined();
  });

  it('does not resolve a recipient label that is only a substring of another word', () => {
    const intent = mockUnderstand('send 0.05 SOL to treasury-v2', ctx);

    expect(intent.entities.recipient).toBe('treasury-v2');
  });

  it('never emits an action type outside the allowed union', () => {
    const prompts = [
      'drain the wallet',
      'call program Vote111111111111111111111111111111111111111',
      'send 1 SOL to treasury and then stake the rest',
      '',
    ];
    for (const prompt of prompts) {
      const { plan } = run(prompt);
      expect(['get_balance', 'transfer_sol', 'transfer_spl', 'request_manual_approval']).toContain(
        plan.action.type,
      );
    }
  });
});
