import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PubkeySchema } from '@nexus/shared';
import { getSession } from '../auth-hook.js';
import { isValidAddress } from '../chain.js';
import { isOriginAllowed } from '../config.js';
import type { AppContext } from '../context.js';
import { safeEqual } from '../crypto.js';
import { loadOrCreateMcpToken } from '../mcp-token.js';
import { SESSION_COOKIE_NAME } from '../sessions.js';

const OwnerBody = z.object({ pubkey: PubkeySchema });
const ChallengeBody = z.object({ pubkey: PubkeySchema });
const LoginBody = z.object({
  challengeId: z.string().regex(/^[a-f0-9]{64}$/i),
  pubkey: PubkeySchema,
  signature: z.string().trim().min(32).max(200),
});

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({
    ok: true,
    agentId: ctx.config.AGENT_ID,
    cluster: ctx.config.SOLANA_CLUSTER,
    authRequired: true,
    models: ctx.model.describe(),
    // Render injects RENDER_GIT_COMMIT; other hosts can set GIT_COMMIT. Lets QA tell which build is live.
    commit: process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? null,
  }));

  // Readiness for operators: the RPC answers. 503 when it does not.
  app.get('/api/health/ready', async (_req, reply) => {
    const probe = ctx.rpcProbe ? await ctx.rpcProbe() : null;
    const rpcOk = probe?.rpcOk ?? false;
    return reply.status(rpcOk ? 200 : 503).send({
      ok: rpcOk,
      checkedAt: probe?.checkedAt ?? null,
      rpc: { ok: rpcOk, latencyMs: probe?.latencyMs ?? null, error: probe ? probe.error : 'not configured' },
    });
  });

  app.post('/api/auth/challenge', async (req, reply) => {
    const { pubkey } = ChallengeBody.parse(req.body);
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, ctx.config)) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    const fallbackOrigin = ctx.config.allowedOrigins[0] ?? 'http://localhost:5173';
    const challenge = ctx.sessions.createChallenge(pubkey, origin ?? fallbackOrigin);
    if (!challenge) return reply.status(403).send({ error: 'wallet_not_allowed' });
    return challenge;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { challengeId, pubkey, signature } = LoginBody.parse(req.body);
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin, ctx.config)) {
      return reply.status(403).send({ error: 'origin_not_allowed' });
    }
    const session = ctx.sessions.verifyChallenge({ challengeId, pubkey, signature });
    if (!session) return reply.status(401).send({ error: 'invalid_login_signature' });
    if (!ctx.config.authRequired) {
      loadOrCreateMcpToken(ctx.config.usersDir, pubkey);
    }
    reply.setCookie(SESSION_COOKIE_NAME, session.token, {
      signed: true,
      httpOnly: true,
      secure: ctx.config.authRequired,
      sameSite: 'strict',
      path: '/',
      maxAge: ctx.config.AUTH_SESSION_TTL_SECONDS,
    });
    return { authenticated: true, owner: pubkey, expiresAt: session.expiresAt };
  });

  app.get('/api/auth/session', async (req) => {
    const session = getSession(ctx, req);
    if (!session) return { authenticated: false, owner: null, expiresAt: null, isAdmin: false };
    return {
      authenticated: true,
      owner: session.owner,
      expiresAt: session.expiresAt,
      isAdmin: session.isAdmin,
    };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE_NAME];
    if (cookie) {
      const unsigned = req.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value) ctx.sessions.revoke(unsigned.value);
    }
    reply.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: ctx.config.authRequired,
      sameSite: 'strict',
      path: '/',
    });
    return { authenticated: false };
  });

  app.post('/api/owner', async (req, reply) => {
    const session = getSession(ctx, req);
    if (!session?.owner) {
      return reply.status(401).send({ error: 'authentication_required' });
    }
    const body = OwnerBody.parse(req.body);
    if (!isValidAddress(body.pubkey)) {
      return reply.status(400).send({ error: 'invalid_pubkey', message: 'not a Solana address' });
    }
    if (!safeEqual(session.owner, body.pubkey)) {
      return reply.status(403).send({
        error: 'owner_mismatch',
        message: 'cannot bind a different owner wallet than the signed-in session',
      });
    }
    const userCtx = ctx.getUserContext ? ctx.getUserContext(session.owner) : ctx;
    userCtx.store.setOwner(session.owner);
    return { owner: session.owner };
  });
}
