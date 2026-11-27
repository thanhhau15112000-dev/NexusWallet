import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { AGENT_ERROR_REMEDIATION, type Policy } from '@nexus/shared';
import { getSession } from '../auth-hook.js';
import type { AppContext } from '../context.js';
import { mcpOwnerFor } from '../mcp-token.js';

export const SafeSegmentSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^(?!\.{1,2}$)[^/\\]+$/, 'must be a single URL-safe path segment');

export const MERCHANT_UNREACHABLE = {
  error: 'merchant_worker_unreachable',
  message: 'the demo merchant worker does not answer',
};

export function resolveUserContext(ctx: AppContext, req: FastifyRequest): AppContext {
  const session = getSession(ctx, req);
  if (session?.owner && ctx.getUserContext) {
    return ctx.getUserContext(session.owner);
  }
  // MCP clients (remote /mcp or the local stdio bundle): a tenant token, accepted only for its read/propose routes.
  const mcpOwner = mcpOwnerFor(ctx.config, req);
  if (mcpOwner && ctx.getUserContext) {
    return ctx.getUserContext(mcpOwner);
  }
  const boundOwner = ctx.store.getOwner();
  if (boundOwner && ctx.getUserContext) {
    return ctx.getUserContext(boundOwner);
  }
  return ctx;
}

export function publicPolicy(policy: Policy) {
  return {
    ...policy,
    maxSolPerTx: policy.maxSolLamportsPerTx / 1_000_000_000,
    maxSolPerDay: policy.maxSolLamportsPerDay === null ? null : policy.maxSolLamportsPerDay / 1_000_000_000,
  };
}

export function frozenReply(
  userCtx: AppContext,
  reply: FastifyReply,
  auditMeta: Record<string, unknown> = {},
) {
  userCtx.audit.record('tx.blocked', null, { reason: 'agent_frozen', ...auditMeta });
  return reply.status(409).send({
    error: 'AGENT_FROZEN',
    code: 'AGENT_FROZEN',
    message: 'agent is frozen by owner',
    remediation: AGENT_ERROR_REMEDIATION.AGENT_FROZEN,
  });
}

export function getMockWorkerKeypair(ctx: AppContext): Keypair {
  if (!ctx.mockWorker) throw new Error('mock worker keystore is not loaded');
  return ctx.mockWorker;
}

/**
 * Which signer can act as `worker` on-chain: the server's mock worker or the demo merchant.
 * `unreachable` means the merchant is configured but not answering, so it cannot be told apart.
 */
export async function onchainWorkerKind(
  ctx: AppContext,
  worker: string,
): Promise<'mock' | 'merchant' | 'unreachable' | null> {
  if (ctx.mockWorker?.publicKey.toBase58() === worker) return 'mock';
  if (!ctx.merchantWorker) return null;
  const merchantPubkey = await ctx.merchantWorker.pubkey();
  if (merchantPubkey === null) return 'unreachable';
  return merchantPubkey === worker ? 'merchant' : null;
}
