import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PubkeySchema } from '@nexus/shared';
import { ApprovalError, approveRequest } from '../approvals.js';
import type { AppContext } from '../context.js';

const ActionBody = z.object({
  account: PubkeySchema,
  signature: z.string().trim().min(32).max(200).optional(),
});

function actionOrigin(ctx: AppContext): string {
  return ctx.config.allowedOrigins[0] ?? 'http://localhost:5173';
}

function actionContext(ctx: AppContext, owner: string | undefined): AppContext | null {
  if (owner && !PubkeySchema.safeParse(owner).success) return null;
  if (!owner) return ctx;
  // Actions are public; do not create a new tenant directory/keypair just
  // because an attacker guessed a valid-looking owner address.
  if (ctx.config.usersDir && !existsSync(resolve(ctx.config.usersDir, owner, 'state.json'))) return null;
  return ctx.getUserContext ? ctx.getUserContext(owner) : ctx;
}

function actionRequest(ctx: AppContext, requestId: string, owner: string | undefined) {
  const userCtx = actionContext(ctx, owner);
  if (!userCtx) return { userCtx: null, request: null };
  return { userCtx, request: userCtx.store.getRequest(requestId) };
}

function actionResponseHeaders(reply: FastifyReply): FastifyReply {
  return reply
    .header('Access-Control-Allow-Origin', '*')
    .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    .header('Access-Control-Allow-Headers', 'Content-Type')
    .header('Content-Type', 'application/json');
}

export function registerActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/.well-known/actions.json', async (_req, reply) => {
    actionResponseHeaders(reply);
    return {
      rules: [{
        pathPattern: '/api/actions/approve/**',
        apiPath: '/api/actions/approve',
      }],
    };
  });

  app.get('/api/actions/approve/:requestId', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const owner = (req.query as { owner?: string }).owner;
    const { request } = actionRequest(ctx, requestId, owner);
    actionResponseHeaders(reply);
    if (!request || !request.approval || request.status !== 'pending_approval') {
      return reply.status(404).send({ error: 'approval_not_found' });
    }
    const origin = actionOrigin(ctx);
    const actionHref = `${origin}/api/actions/approve/${encodeURIComponent(requestId)}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`;
    const payload = request.approval.payload;
    const amount = payload.actionType === 'transfer_sol'
      ? `${payload.amount / 1_000_000_000} SOL`
      : `${payload.amount} tokens`;
    return {
      icon: `${origin}/solana-logo-mark.svg`,
      title: 'Approve nexusPay agent transaction',
      description: `Approve ${amount} to ${payload.recipient}.`,
      label: 'Sign approval',
      links: {
        actions: [{
          label: 'Sign approval',
          href: actionHref,
          parameters: [{ name: 'account', label: 'Owner wallet address' }],
        }],
      },
    };
  });

  app.options('/api/actions/approve/:requestId', async (_req, reply) => {
    actionResponseHeaders(reply);
    return reply.send();
  });

  app.post('/api/actions/approve/:requestId', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const body = ActionBody.parse(req.body);
    const { userCtx, request } = actionRequest(ctx, requestId, body.account);
    actionResponseHeaders(reply);
    if (!userCtx || !request || !request.approval || request.status !== 'pending_approval') {
      return reply.status(404).send({ error: 'approval_not_found' });
    }
    if (userCtx.store.getOwner() !== body.account) {
      return reply.status(403).send({ error: 'wrong_signer', message: 'account is not the bound owner wallet' });
    }
    if (body.signature) {
      try {
        const approved = await approveRequest(userCtx, {
          requestId,
          signature: body.signature,
          signerPubkey: body.account,
        });
        return {
          type: 'message',
          message: 'Approval accepted; the agent is executing the transfer.',
          requestId,
          request: approved,
        };
      } catch (err) {
        if (err instanceof ApprovalError) {
          const status = err.code === 'not_found' ? 404 : 403;
          return reply.status(status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }
    return {
      type: 'message',
      message: request.approval.message,
      requestId,
      expiresAt: request.approval.payload.expiresAt,
      account: body.account,
    };
  });
}
