import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENT_ERROR_REMEDIATION,
  ModelActionSchema,
  PubkeySchema,
} from '@nexus/shared';
import { ApprovalError, approveRequest, cancelRequest, expirePendingApprovals } from '../approvals.js';
import type { AppContext } from '../context.js';
import { requestIdentity } from '../auth-hook.js';
import { IdempotencyConflictError, runAction, runCommand, type AgentAction } from '../pipeline.js';
import { fetchWithX402, resolveX402Payment } from '../x402.js';
import { resolveUserContext } from './shared.js';

const CommandBody = z.object({
  prompt: z.string().trim().min(1).max(600),
  idempotencyKey: z.string().trim().max(120).optional(),
});

/** Structured actions from an external agent (MCP). Same action set as the planner, minus the non-executable one. */
const AgentActionBody = z.object({
  action: ModelActionSchema.refine(
    (action): action is AgentAction => action.type !== 'request_manual_approval',
    { message: 'request_manual_approval is not an executable action' },
  ),
  idempotencyKey: z.string().trim().max(120).optional(),
});

const x402IdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9:_-]+$/)
  .optional();

const X402ResolveBody = z.object({
  challenge: z.union([z.string(), z.record(z.string(), z.unknown())]),
  resourceUrl: z.string().url().optional(),
  idempotencyKey: x402IdempotencyKeySchema,
});

const X402FetchBody = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']).optional().default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(262_144).optional(),
  idempotencyKey: x402IdempotencyKeySchema,
});

const ApproveBody = z.object({
  signature: z.string().trim().min(32).max(200),
  signerPubkey: PubkeySchema,
});

export function registerRequestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/commands', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = CommandBody.parse(req.body);
    const request = await runCommand(userCtx, {
      prompt: body.prompt,
      idempotencyKey: body.idempotencyKey ?? null,
    });
    return { request };
  });

  // Not under /api/actions/: that prefix is public for Blinks and skips session auth.
  app.post('/api/agent/intents', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = AgentActionBody.parse(req.body);
    try {
      const request = await runAction(userCtx, {
        action: body.action as AgentAction,
        idempotencyKey: body.idempotencyKey ?? null,
      });
      return { request };
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return reply.status(409).send({
          error: 'IDEMPOTENCY_CONFLICT',
          message: err.message,
          remediation: AGENT_ERROR_REMEDIATION.IDEMPOTENCY_CONFLICT,
          details: { idempotencyKey: body.idempotencyKey ?? null },
        });
      }
      throw err;
    }
  });

  app.post('/api/agent/x402/resolve', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = X402ResolveBody.parse(req.body);
    const result = await resolveX402Payment(userCtx, body.challenge, body.resourceUrl, body.idempotencyKey);
    if (result.status === 'denied') {
      const status = result.code === 'AGENT_FROZEN' || result.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 403;
      return reply.status(status).send(result);
    }
    if (result.status === 'pending_approval') {
      return reply.status(202).send(result);
    }
    return reply.status(200).send(result);
  });

  app.post('/api/agent/x402/fetch', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const body = X402FetchBody.parse(req.body);
    const init = {
      method: body.method,
      headers: body.headers,
      body: body.body,
    };
    const result = await fetchWithX402(userCtx, body.url, init, body.idempotencyKey);
    return reply.status(200).send(result);
  });

  app.get('/api/requests', async (req) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    return { requests: userCtx.store.listRequests() };
  });

  app.get('/api/requests/:id', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    expirePendingApprovals(userCtx);
    const { id } = req.params as { id: string };
    const request = userCtx.store.getRequest(id);
    if (!request) return reply.status(404).send({ error: 'not_found' });
    return { request };
  });

  app.post('/api/requests/:id/approve', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { id } = req.params as { id: string };
    const body = ApproveBody.parse(req.body);
    try {
      const request = await approveRequest(userCtx, {
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

  app.post('/api/requests/:id/cancel', async (req, reply) => {
    const userCtx = resolveUserContext(ctx, req);
    const { id } = req.params as { id: string };
    try {
      const by = requestIdentity(ctx, req)?.kind === 'token' ? 'agent' : 'owner';
      return { request: cancelRequest(userCtx, id, by) };
    } catch (err) {
      if (err instanceof ApprovalError) {
        const status = err.code === 'not_found' ? 404 : 409;
        return reply.status(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
