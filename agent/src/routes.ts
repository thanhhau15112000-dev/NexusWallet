import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AllowlistEntrySchema, PubkeySchema, solToLamports, type Policy } from '@nexus/shared';
import { explorerAddressUrl, getLamportBalance, isValidAddress, requestAirdrop } from './chain.js';
import { ApprovalError, approveRequest } from './approvals.js';
import type { AppContext } from './context.js';
import { runCommand } from './pipeline.js';

const CommandBody = z.object({
  prompt: z.string().trim().min(1).max(600),
  idempotencyKey: z.string().trim().max(120).optional(),
});

const OwnerBody = z.object({ pubkey: PubkeySchema });

const PolicyBody = z.object({
  maxSolPerTx: z.number().nonnegative().max(1000),
  allowedRecipients: z.array(AllowlistEntrySchema).max(32),
  allowedMints: z.array(AllowlistEntrySchema).max(16),
  maxTokenAmountByMint: z.record(z.string(), z.number().nonnegative()).default({}),
});

const ApproveBody = z.object({
  signature: z.string().trim().min(32).max(200),
  signerPubkey: PubkeySchema,
});

const AirdropBody = z.object({ sol: z.number().positive().max(5).default(1) });

function publicPolicy(policy: Policy) {
  return { ...policy, maxSolPerTx: policy.maxSolLamportsPerTx / 1_000_000_000 };
}

export async function registerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    agentId: ctx.config.AGENT_ID,
    cluster: ctx.config.SOLANA_CLUSTER,
    models: ctx.model.describe(),
  }));

  app.get('/api/state', async () => {
    let lamports: number | null = null;
    let rpcError: string | null = null;
    try {
      lamports = await getLamportBalance(ctx.connection, ctx.agentPubkey);
    } catch (err) {
      rpcError = err instanceof Error ? err.message : String(err);
    }

    return {
      cluster: ctx.config.SOLANA_CLUSTER,
      rpcUrl: ctx.config.SOLANA_RPC_URL,
      models: ctx.model.describe(),
      owner: ctx.store.getOwner(),
      ownerPinned: ctx.ownerPinned,
      agent: {
        agentId: ctx.config.AGENT_ID,
        pubkey: ctx.agentPubkey,
        lamports,
        rpcError,
        explorerUrl: explorerAddressUrl(ctx.agentPubkey, ctx.config.SOLANA_CLUSTER),
      },
      policy: publicPolicy(ctx.store.getPolicy()),
    };
  });

  app.post('/api/owner', async (req, reply) => {
    const body = OwnerBody.parse(req.body);
    if (!isValidAddress(body.pubkey)) {
      return reply.status(400).send({ error: 'invalid_pubkey', message: 'not a Solana address' });
    }
    const current = ctx.store.getOwner();
    if (ctx.ownerPinned && current !== body.pubkey) {
      return reply
        .status(409)
        .send({ error: 'owner_pinned', message: 'OWNER_PUBKEY pins this agent to another wallet' });
    }
    if (current !== body.pubkey) {
      ctx.store.setOwner(body.pubkey);
      ctx.audit.record('owner.bound', null, { previous: current, owner: body.pubkey });
    }
    return { owner: body.pubkey };
  });

  app.put('/api/policy', async (req) => {
    const body = PolicyBody.parse(req.body);
    const policy = ctx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(body.maxSolPerTx),
      allowedRecipients: body.allowedRecipients,
      allowedMints: body.allowedMints,
      maxTokenAmountByMint: body.maxTokenAmountByMint,
    });
    ctx.audit.record('policy.updated', null, { policy });
    return { policy: publicPolicy(policy) };
  });

  app.post('/api/agent/airdrop', async (req, reply) => {
    const body = AirdropBody.parse(req.body ?? {});
    try {
      const signature = await requestAirdrop({
        connection: ctx.connection,
        address: ctx.agentPubkey,
        lamports: solToLamports(body.sol),
      });
      ctx.audit.record('agent.airdrop', null, { sol: body.sol, signature });
      const lamports = await getLamportBalance(ctx.connection, ctx.agentPubkey);
      return { signature, lamports };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({
        error: 'airdrop_failed',
        message: `${message} | the devnet faucet rate-limits aggressively, fund the agent from https://faucet.solana.com instead`,
      });
    }
  });

  app.post('/api/commands', async (req) => {
    const body = CommandBody.parse(req.body);
    const request = await runCommand(ctx, {
      prompt: body.prompt,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return { request };
  });

  app.get('/api/requests', async () => ({ requests: ctx.store.listRequests() }));

  app.get('/api/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const request = ctx.store.getRequest(id);
    if (!request) return reply.status(404).send({ error: 'not_found' });
    return { request };
  });

  app.post('/api/requests/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ApproveBody.parse(req.body);
    try {
      const request = await approveRequest(ctx, {
        requestId: id,
        signature: body.signature,
        signerPubkey: body.signerPubkey,
      });
      return { request };
    } catch (err) {
      if (err instanceof ApprovalError) {
        const status = err.code === 'not_found' ? 404 : 403;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.get('/api/audit', async (req) => {
    const raw = Number((req.query as { limit?: string }).limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    return { entries: ctx.audit.list(limit) };
  });
}
