import {
  ActionPlanSchema,
  IntentEnvelopeSchema,
  type ActionPlan,
  type IntentEnvelope,
  type ModelContext,
  type StageMeta,
} from '@nexus/shared';
import type { AppConfig } from '../config.js';
import { mockPlan, mockUnderstand } from './mock.js';
import { INTENT_SYSTEM, PLAN_SYSTEM, intentUserPrompt, planUserPrompt } from './prompts.js';
import { callGemini, callGroq } from './providers.js';

export type Staged<T> = { value: T; meta: StageMeta };

export type ModelPipeline = {
  understand: (prompt: string, ctx: ModelContext) => Promise<Staged<IntentEnvelope>>;
  plan: (intent: IntentEnvelope, ctx: ModelContext) => Promise<Staged<ActionPlan>>;
  describe: () => { stage1: string; stage2: string; mode: string };
};

/**
 * Two-stage pipeline with a deterministic fallback.
 *
 * A provider is used when its key is set and MODEL_MODE is not `mock`. Any
 * failure - network, bad JSON, or output that does not match the schema - falls
 * back to the deterministic parser and is reported in the request's model trace,
 * so malformed model output can never reach the policy engine.
 */
export function createModelPipeline(config: AppConfig): ModelPipeline {
  const useGemini = config.MODEL_MODE === 'auto' && config.GEMINI_API_KEY.length > 0;
  const useGroq = config.MODEL_MODE === 'auto' && config.GROQ_API_KEY.length > 0;

  async function staged<T>(
    name: string,
    model: string,
    enabled: boolean,
    run: () => Promise<T>,
    fallback: () => T,
  ): Promise<Staged<T>> {
    const startedAt = Date.now();
    const mock = (error?: string): Staged<T> => ({
      value: fallback(),
      meta: {
        name: 'mock',
        model: 'deterministic',
        fallback: true,
        ms: Date.now() - startedAt,
        ...(error ? { error } : {}),
      },
    });

    if (!enabled) return mock();
    try {
      const value = await run();
      return { value, meta: { name, model, fallback: false, ms: Date.now() - startedAt } };
    } catch (err) {
      return mock((err instanceof Error ? err.message : String(err)).slice(0, 240));
    }
  }

  return {
    understand: (prompt, ctx) =>
      staged(
        'gemini',
        config.GEMINI_MODEL,
        useGemini,
        async () =>
          IntentEnvelopeSchema.parse(
            await callGemini({
              apiKey: config.GEMINI_API_KEY,
              model: config.GEMINI_MODEL,
              thinkingBudget: config.GEMINI_THINKING_BUDGET,
              system: INTENT_SYSTEM,
              user: intentUserPrompt(prompt, ctx),
            }),
          ),
        () => mockUnderstand(prompt, ctx),
      ),

    plan: (intent, ctx) =>
      staged(
        'groq',
        config.GROQ_MODEL,
        useGroq,
        async () =>
          ActionPlanSchema.parse(
            await callGroq({
              apiKey: config.GROQ_API_KEY,
              model: config.GROQ_MODEL,
              system: PLAN_SYSTEM,
              user: planUserPrompt(intent, ctx),
            }),
          ),
        () => mockPlan(intent, ctx),
      ),

    describe: () => ({
      stage1: useGemini ? `gemini:${config.GEMINI_MODEL}` : 'mock:deterministic',
      stage2: useGroq ? `groq:${config.GROQ_MODEL}` : 'mock:deterministic',
      mode: config.MODEL_MODE,
    }),
  };
}
