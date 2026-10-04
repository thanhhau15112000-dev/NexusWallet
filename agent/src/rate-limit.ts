import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AGENT_ERROR_REMEDIATION } from '@nexus/shared';
import { requestIdentity } from './auth-hook.js';
import type { AppContext } from './context.js';
import { verifyMcpToken } from './mcp-token.js';

/**
 * Fixed-window request limits for one agent process. State lives in memory, so counters reset
 * on restart and are not shared between instances. There is no CDN/WAF behind this: it keeps one
 * client from monopolising the process, it does not absorb network-layer floods.
 */
export type RateRule = {
  id: string;
  limit: number;
  windowMs: number;
  /** `ip`: the client address. `owner`: the verified session or MCP token owner, falling back to the address. */
  by: 'ip' | 'owner';
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const authRule = (id: string): RateRule => ({ id, limit: 10, windowMs: MINUTE, by: 'ip' });
const faucetRule = (id: string): RateRule => ({ id, limit: 5, windowMs: HOUR, by: 'ip' });
const proposeRule: RateRule = { id: 'propose', limit: 30, windowMs: MINUTE, by: 'owner' };

/**
 * Keyed by `METHOD <registered route pattern>`, not the raw URL, so encodings, dot segments and
 * trailing slashes cannot step around a rule.
 *
 * The dashboard polls three reads every 6 s (about 30/min per open tab) and the MCP client polls a held
 * request every 5 s, so the read ceilings sit well above one tab and one agent.
 */
export const DEFAULT_RATE_RULES: Record<string, RateRule> = {
  'POST /api/auth/challenge': authRule('auth.challenge'),
  'POST /api/auth/login': authRule('auth.login'),
  'POST /api/agent/claim-seed': faucetRule('claim-seed'),
  'POST /api/agent/airdrop': faucetRule('airdrop'),
  'POST /api/agent/intents': proposeRule,
  'POST /api/commands': proposeRule,
  'POST /mcp': { id: 'mcp', limit: 120, windowMs: MINUTE, by: 'owner' },
};

/** Every other /api route, including unknown paths. */
export const DEFAULT_FALLBACK_RULE: RateRule = { id: 'api', limit: 240, windowMs: MINUTE, by: 'owner' };

export type RateLimitOptions = {
  rules?: Record<string, RateRule>;
  fallback?: RateRule;
  now?: () => number;
};

type Bucket = { count: number; resetAt: number };

// Upper bound on tracked keys. Past it expired buckets are swept, then the oldest are dropped.
const MAX_BUCKETS = 20_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one request. `retryAfterSeconds` is 0 when allowed. */
  hit(key: string, rule: RateRule): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.makeRoom(now);
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= rule.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < MAX_BUCKETS) break;
      this.buckets.delete(key);
    }
  }
}

function clientKey(ctx: AppContext, req: FastifyRequest, rule: RateRule): string {
  if (rule.by === 'owner') {
    // Only a verified credential selects an owner bucket. A bearer string that fails verification
    // is keyed by address, so nobody can spend another owner's allowance by naming them.
    const tokenOwner =
      req.routeOptions.url === '/mcp' ? verifyMcpToken(ctx.config.usersDir, req.headers.authorization) : null;
    const identity = tokenOwner ? { kind: 'token', owner: tokenOwner } : requestIdentity(ctx, req);
    if (identity) return `${rule.id}|${identity.kind}:${identity.owner}`;
  }
  return `${rule.id}|ip:${req.ip}`;
}

export function registerRateLimit(app: FastifyInstance, ctx: AppContext, options: RateLimitOptions = {}): void {
  const rules = options.rules ?? DEFAULT_RATE_RULES;
  const fallback = options.fallback ?? DEFAULT_FALLBACK_RULE;
  const limiter = new RateLimiter(options.now);

  // onRequest runs before body parsing, so a flood is rejected before its payload is read.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const rule = rules[`${req.method} ${req.routeOptions.url ?? ''}`] ?? (req.url.startsWith('/api/') ? fallback : null);
    if (!rule) return;
    const result = limiter.hit(clientKey(ctx, req, rule), rule);
    if (result.allowed) return;
    return reply
      .status(429)
      .header('retry-after', String(result.retryAfterSeconds))
      .send({
        error: 'RATE_LIMITED',
        code: 'RATE_LIMITED',
        message: `Too many requests. Retry in ${result.retryAfterSeconds} seconds.`,
        remediation: AGENT_ERROR_REMEDIATION.RATE_LIMITED,
        details: { retryAfterSeconds: result.retryAfterSeconds },
      });
  });
}
