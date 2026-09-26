import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { registerRoutes } from '../src/routes.js';

function context() {
  const owner = Keypair.generate().publicKey.toBase58();
  const request = {
    id: 'req_actions_1',
    status: 'pending_approval',
    approval: {
      payload: {
        requestId: 'req_actions_1',
        agentId: 'agent-001',
        policyVersion: 1,
        actionType: 'transfer_sol',
        recipient: Keypair.generate().publicKey.toBase58(),
        amount: 100_000_000,
        mint: 'native',
        nonce: 'nonce-12345678',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      message: 'canonical approval message',
    },
  };
  return {
    owner,
    request,
    ctx: {
      config: { allowedOrigins: ['https://example.test'] },
      store: {
        getRequest: (id: string) => (id === request.id ? request : null),
        getOwner: () => owner,
      },
    } as never,
  };
}

describe('Solana Actions approval endpoints', () => {
  it('returns public metadata and a canonical message without a dashboard session', async () => {
    const fixture = context();
    const app = Fastify();
    await registerRoutes(app, fixture.ctx);

    const metadata = await app.inject({
      method: 'GET',
      url: `/api/actions/approve/${fixture.request.id}?owner=${fixture.owner}`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      label: 'Sign approval',
      links: { actions: [{ parameters: [{ name: 'account' }] }] },
    });

    const payload = await app.inject({
      method: 'POST',
      url: `/api/actions/approve/${fixture.request.id}`,
      payload: { account: fixture.owner },
    });
    expect(payload.statusCode).toBe(200);
    expect(payload.json()).toMatchObject({
      type: 'message',
      message: 'canonical approval message',
      account: fixture.owner,
    });
  });

  it('publishes the Actions discovery rule', async () => {
    const fixture = context();
    const app = Fastify();
    await registerRoutes(app, fixture.ctx);
    const response = await app.inject({ method: 'GET', url: '/.well-known/actions.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().rules[0]).toEqual({
      pathPattern: '/api/actions/approve/**',
      apiPath: '/api/actions/approve',
    });
  });
});
