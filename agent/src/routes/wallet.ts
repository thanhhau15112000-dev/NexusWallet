import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AllowlistEntrySchema,
  lamportsToSol,
  solToLamports,
  spentLamportsInWindow,
} from '@nexus/shared';
import { expirePendingApprovals } from '../approvals.js';
import { getSession } from '../auth-hook.js';
import {
  FEE_BUFFER_LAMPORTS,
  explorerAddressUrl,
  getAgentHistory,
  getLamportBalance,
  getTokenBalances,
  type TokenBalance,
} from '../chain.js';
import type { AppContext } from '../context.js';
import { agentError } from '../pipeline.js';
import { publicPolicy, resolveUserContext } from './shared.js';

const PolicyBody = z.object({
  maxSolPerTx: z.number().nonnegative().max(1000),
  maxSolPerDay: z.number().nonnegative().max(100000).nullable().optional(),
  allowedRecipients: z.array(AllowlistEntrySchema).max(32),
  allowedMints: z.array(AllowlistEntrySchema).max(16),
  maxTokenAmountByMint: z.record(z.string(), z.number().nonnegative()).default({}),
});

const HISTORY_CACHE_TTL_MS = 8_000;
const HISTORY_CACHE_MAX = 256;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export function registerWalletRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/state', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    const session = getSession(ctx, req);
    let lamports: number | null = null;
    let rpcError: string | null = null;
    // A token read failure must not hide the SOL balance; null tells the client it is unknown.
    const tokensRead = getTokenBalances(userCtx.connection, userCtx.agentPubkey).catch(() => null);
    try {
      lamports = await getLamportBalance(userCtx.connection, userCtx.agentPubkey);
    } catch (err) {
      rpcError = err instanceof Error ? err.message : String(err);
    }
    const tokens: TokenBalance[] | null = await tokensRead;

    const isAdmin = Boolean(session?.isAdmin);

    const currentPolicy = userCtx.store.getPolicy();
    const spentLamports = spentLamportsInWindow(userCtx.store.listRequests());
    const remainingLamports =
      currentPolicy.maxSolLamportsPerDay === null
        ? null
        : Math.max(0, currentPolicy.maxSolLamportsPerDay - spentLamports);

    const usage = {
      spentSol24h: lamportsToSol(spentLamports),
      remainingSol24h: remainingLamports === null ? null : lamportsToSol(remainingLamports),
    };

    return {
      cluster: userCtx.config.SOLANA_CLUSTER,
      rpcUrl: userCtx.config.SOLANA_RPC_URL,
      models: userCtx.model.describe(),
      owner: userCtx.store.getOwner(),
      ownerPinned: false,
      isAdmin,
      mockWorker: userCtx.mockWorker ? { pubkey: userCtx.mockWorker.publicKey.toBase58() } : null,
      merchantWorker: (await userCtx.merchantWorker?.info()) ?? null,
      agent: {
        agentId: userCtx.config.AGENT_ID,
        pubkey: userCtx.agentPubkey,
        lamports,
        tokens,
        rpcError,
        explorerUrl: explorerAddressUrl(userCtx.agentPubkey, userCtx.config.SOLANA_CLUSTER),
        // Upper bound the pre-flight balance check reserves on top of a SOL transfer amount.
        feeReserveLamports: FEE_BUFFER_LAMPORTS,
        frozen: userCtx.store.isFrozen(),
        frozenAt: userCtx.store.getFrozen()?.at ?? null,
      },
      policy: publicPolicy(currentPolicy),
      usage,
    };
  });

  app.put('/api/policy', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = PolicyBody.parse(req.body);
    const current = userCtx.store.getPolicy();
    const maxSolLamportsPerDay =
      body.maxSolPerDay !== undefined
        ? (body.maxSolPerDay === null ? null : solToLamports(body.maxSolPerDay))
        : current.maxSolLamportsPerDay;
    const policy = userCtx.store.setPolicy({
      maxSolLamportsPerTx: solToLamports(body.maxSolPerTx),
      maxSolLamportsPerDay,
      allowedRecipients: body.allowedRecipients,
      allowedMints: body.allowedMints,
      maxTokenAmountByMint: body.maxTokenAmountByMint,
    });
    userCtx.audit.record('policy.updated', null, { policy });
    return { policy: publicPolicy(policy) };
  });

  app.post('/api/agent/freeze', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    const currentFrozen = userCtx.store.getFrozen();
    if (currentFrozen) {
      return { frozen: true, frozenAt: currentFrozen.at };
    }
    const now = new Date().toISOString();
    userCtx.store.setFrozen(true, now);
    userCtx.audit.record('agent.frozen', null, { frozenAt: now });

    const pending = userCtx.store.listRequests().filter((r) => r.status === 'pending_approval');
    for (const r of pending) {
      userCtx.store.putRequest({
        ...r,
        status: 'denied',
        error: agentError('AGENT_FROZEN', 'agent was frozen by owner; pending approval cancelled'),
      });
      userCtx.audit.record('tx.blocked', r.id, { reason: 'agent_frozen' });
    }

    return { frozen: true, frozenAt: now };
  });

  app.post('/api/agent/unfreeze', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const currentFrozen = userCtx.store.getFrozen();
    if (!currentFrozen) {
      return { frozen: false, frozenAt: null };
    }
    userCtx.store.setFrozen(false);
    userCtx.audit.record('agent.unfrozen', null, { unfrozenAt: new Date().toISOString() });
    return { frozen: false, frozenAt: null };
  });

  // Public devnet RPC rate-limits, so repeated polls of the same page share one read for a few seconds.
  const historyCache = new Map<string, { at: number; page: Awaited<ReturnType<typeof getAgentHistory>> }>();
  app.get('/api/agent/history', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const query = req.query as { before?: string; limit?: string };
    const before = query.before || undefined;
    const limit = query.limit === undefined ? 10 : Number(query.limit);
    if ((before !== undefined && !SIGNATURE.test(before)) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return reply.status(400).send({ error: 'invalid_query', message: 'before must be a transaction signature and limit 1-50' });
    }
    const key = `${userCtx.agentPubkey}:${before ?? ''}:${limit}`;
    const now = Date.now();
    const cached = historyCache.get(key);
    if (cached && now - cached.at < HISTORY_CACHE_TTL_MS) return cached.page;
    try {
      const page = await getAgentHistory(userCtx.connection, userCtx.agentPubkey, ctx.config.SOLANA_CLUSTER, { limit, before });
      const writeAt = Date.now();
      for (const [entryKey, entry] of historyCache) {
        if (writeAt - entry.at >= HISTORY_CACHE_TTL_MS) historyCache.delete(entryKey);
      }
      while (historyCache.size >= HISTORY_CACHE_MAX) {
        const oldestKey = historyCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        historyCache.delete(oldestKey);
      }
      historyCache.set(key, { at: writeAt, page });
      return page;
    } catch (err) {
      return reply.status(502).send({ error: 'rpc_error', message: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/audit', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const raw = Number((req.query as { limit?: string }).limit ?? 100);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 500) : 100;
    return { entries: userCtx.audit.list(limit) };
  });
}
