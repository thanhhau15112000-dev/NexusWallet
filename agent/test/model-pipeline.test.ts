import { afterEach, describe, expect, it, vi } from 'vitest';
import { solToLamports, type ModelContext } from '@nexus/shared';
import { loadConfig } from '../src/config.js';
import { createModelPipeline } from '../src/model/index.js';

const TREASURY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

const ctx: ModelContext = {
  agentId: 'agent-001',
  cluster: 'devnet',
  maxSolPerTx: solToLamports(0.1),
  recipients: [{ label: 'treasury', address: TREASURY }],
  mints: [],
};

function groqReply(json: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }), {
    status: 200,
  });
}

describe('model pipeline (Groq for both stages)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the intent stage and the plan stage to Groq and reports both', async () => {
    const intent = {
      goal: 'Send 0.05 SOL to treasury',
      operation: 'transfer_sol',
      entities: { recipient: 'treasury', amount: 0.05, asset: 'SOL' },
      riskNotes: [],
      confidence: 0.9,
      requiresHuman: false,
    };
    const plan = {
      action: { type: 'transfer_sol', recipient: 'treasury', amountSol: 0.05 },
      rationale: 'user asked for a SOL transfer',
      confidence: 0.9,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(groqReply(intent)).mockResolvedValueOnce(groqReply(plan));
    vi.stubGlobal('fetch', fetchMock);

    const pipeline = createModelPipeline({ ...loadConfig(), MODEL_MODE: 'auto', GROQ_API_KEY: 'test-key' });
    expect(pipeline.describe().stage1).toMatch(/^groq:/);
    expect(pipeline.describe().stage2).toMatch(/^groq:/);

    const understood = await pipeline.understand('send 0.05 SOL to treasury', ctx);
    const planned = await pipeline.plan(understood.value, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe('https://api.groq.com/openai/v1/chat/completions');
    }
    expect(understood.meta).toMatchObject({ name: 'groq', fallback: false });
    expect(planned.meta).toMatchObject({ name: 'groq', fallback: false });
    expect(planned.value.action.type).toBe('transfer_sol');
  });

  it('falls back to the deterministic parser and records the error when Groq fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })));

    const pipeline = createModelPipeline({ ...loadConfig(), MODEL_MODE: 'auto', GROQ_API_KEY: 'test-key' });
    const understood = await pipeline.understand('send 0.05 SOL to treasury', ctx);

    expect(understood.meta.fallback).toBe(true);
    expect(understood.meta.error).toContain('429');
    expect(understood.value.operation).toBe('transfer_sol');
  });

  it('uses the deterministic parser for both stages without a Groq key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const pipeline = createModelPipeline({ ...loadConfig(), MODEL_MODE: 'auto', GROQ_API_KEY: '' });
    expect(pipeline.describe()).toMatchObject({ stage1: 'mock:deterministic', stage2: 'mock:deterministic' });

    const understood = await pipeline.understand('send 0.05 SOL to treasury', ctx);
    expect(understood.meta.fallback).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
