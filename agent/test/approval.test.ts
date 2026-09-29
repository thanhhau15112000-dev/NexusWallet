import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { buildApprovalMessage, type ApprovalPayload, type PaymentRequest } from '@nexus/shared';
vi.mock('../src/pipeline.js', () => ({
  execute: vi.fn(async (_ctx: unknown, request: PaymentRequest) => request),
}));
import { approveRequest, cancelRequest } from '../src/approvals.js';
import { execute } from '../src/pipeline.js';
import type { AppContext } from '../src/context.js';
import { safeEqual, verifyMessageSignature } from '../src/crypto.js';

const payload: ApprovalPayload = {
  requestId: 'req_abc123',
  agentId: 'agent-001',
  policyVersion: 3,
  actionType: 'transfer_sol',
  recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  amount: 500_000_000,
  mint: 'native',
  nonce: 'a1b2c3d4e5f60718',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

function sign(message: string, key = nacl.sign.keyPair()) {
  return {
    key,
    pubkey: bs58.encode(key.publicKey),
    signature: bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), key.secretKey),
    ),
  };
}

describe('buildApprovalMessage', () => {
  it('is deterministic for the same payload', () => {
    expect(buildApprovalMessage(payload)).toBe(buildApprovalMessage({ ...payload }));
  });

  it('shows the amount in SOL and lamports', () => {
    expect(buildApprovalMessage(payload)).toContain('0.5 SOL (500000000 lamports)');
  });

  it.each([
    ['requestId', { requestId: 'req_other' }],
    ['recipient', { recipient: '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM' }],
    ['amount', { amount: 500_000_001 }],
    ['nonce', { nonce: 'ffffffffffffffff' }],
    ['policyVersion', { policyVersion: 4 }],
    ['expiresAt', { expiresAt: '2030-01-02T00:00:00.000Z' }],
  ])('changes when %s changes', (_field, patch) => {
    expect(buildApprovalMessage({ ...payload, ...patch })).not.toBe(buildApprovalMessage(payload));
  });
});

describe('verifyMessageSignature', () => {
  it('accepts a signature over the exact message', () => {
    const message = buildApprovalMessage(payload);
    const { pubkey, signature } = sign(message);
    expect(verifyMessageSignature({ message, signatureBase58: signature, pubkeyBase58: pubkey })).toBe(
      true,
    );
  });

  it('rejects a signature replayed onto a different request', () => {
    const { pubkey, signature } = sign(buildApprovalMessage(payload));
    const other = buildApprovalMessage({ ...payload, requestId: 'req_other' });
    expect(
      verifyMessageSignature({ message: other, signatureBase58: signature, pubkeyBase58: pubkey }),
    ).toBe(false);
  });

  it('rejects a signature from a different wallet', () => {
    const message = buildApprovalMessage(payload);
    const { signature } = sign(message);
    const stranger = bs58.encode(nacl.sign.keyPair().publicKey);
    expect(
      verifyMessageSignature({ message, signatureBase58: signature, pubkeyBase58: stranger }),
    ).toBe(false);
  });

  it('rejects malformed input instead of throwing', () => {
    expect(
      verifyMessageSignature({
        message: 'x',
        signatureBase58: 'not-base58-!!',
        pubkeyBase58: 'also-bad',
      }),
    ).toBe(false);
  });
});

describe('safeEqual', () => {
  it('matches identical strings and rejects everything else', () => {
    expect(safeEqual('owner-pubkey', 'owner-pubkey')).toBe(true);
    expect(safeEqual('owner-pubkey', 'other-pubkey')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
  });
});

describe('approveRequest hard gates', () => {
  const ownerKey = nacl.sign.keyPair();
  const ownerPub = bs58.encode(ownerKey.publicKey);

  function createMockContext(request: PaymentRequest, policyVersion = 3, frozen = false) {
    const store = {
      isFrozen: vi.fn(() => frozen),
      getRequest: vi.fn((id: string) => (id === request.id ? request : undefined)),
      getOwner: vi.fn(() => ownerPub),
      getPolicy: vi.fn(() => ({
        version: policyVersion,
        agentId: 'agent-001',
        maxSolLamportsPerTx: 100_000_000,
        allowedRecipients: [],
        allowedMints: [],
        maxTokenAmountByMint: {},
        updatedAt: new Date().toISOString(),
      })),
      putRequest: vi.fn((req: PaymentRequest) => req),
    };

    const audit = {
      record: vi.fn(),
    };

    return { store, audit } as unknown as AppContext;
  }

  function validRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
    const msg = buildApprovalMessage(payload);
    return {
      id: 'req_abc123',
      agentId: 'agent-001',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      status: 'pending_approval',
      prompt: 'Send 0.5 SOL to treasury',
      idempotencyKey: null,
      intent: null,
      plan: null,
      decision: {
        verdict: 'require_approval',
        policyVersion: payload.policyVersion,
        reasons: ['over limit'],
        resolved: {
          type: 'transfer_sol',
          recipient: payload.recipient,
          recipientLabel: 'treasury',
          lamports: payload.amount,
        },
      },
      modelTrace: null,
      approval: {
        payload: { ...payload },
        message: msg,
        signature: null,
        signerPubkey: null,
        signedAt: null,
        consumedAt: null,
      },
      execution: null,
      balanceLamports: null,
      error: null,
      ...overrides,
    };
  }

  it('rejects not_found when request does not exist', async () => {
    const ctx = createMockContext(validRequest());
    await expect(
      approveRequest(ctx, { requestId: 'req_missing', signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects agent_frozen when agent is frozen', async () => {
    const req = validRequest();
    const ctx = createMockContext(req, 3, true);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'agent_frozen' });
  });

  it('rejects bad_status if request is not pending_approval', async () => {
    const req = validRequest({ status: 'confirmed' });
    const ctx = createMockContext(req);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'bad_status' });
  });

  it('rejects replay if approval was already consumed', async () => {
    const req = validRequest();
    req.approval!.consumedAt = '2025-01-01T01:00:00.000Z';
    const ctx = createMockContext(req);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'replay' });
  });

  it('rejects expired approvals', async () => {
    const req = validRequest();
    req.approval!.payload.expiresAt = '2020-01-01T00:00:00.000Z';
    const ctx = createMockContext(req);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects wrong signer when signature comes from another wallet', async () => {
    const req = validRequest();
    const stranger = bs58.encode(nacl.sign.keyPair().publicKey);
    const ctx = createMockContext(req);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: stranger }),
    ).rejects.toMatchObject({ code: 'wrong_signer' });
  });

  it('rejects stale policy when policy version has changed', async () => {
    const req = validRequest(); // payload has policyVersion: 3
    const ctx = createMockContext(req, 4); // current policy version is 4
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'policy_changed' });
  });

  it('rejects tampered message mismatch', async () => {
    const req = validRequest();
    req.approval!.message = 'tampered message content';
    const ctx = createMockContext(req);
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: 'sig', signerPubkey: ownerPub }),
    ).rejects.toMatchObject({ code: 'message_mismatch' });
  });

  it('rejects invalid signature', async () => {
    const req = validRequest();
    const ctx = createMockContext(req);
    const invalidSig = bs58.encode(new Uint8Array(64));
    await expect(
      approveRequest(ctx, { requestId: req.id, signature: invalidSig, signerPubkey: ownerPub }),
      ).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('rejects an approval payload that does not match the executable action', async () => {
    const req = validRequest();
    req.decision!.resolved = {
      type: 'transfer_sol',
      recipient: '5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM',
      recipientLabel: 'other',
      lamports: payload.amount,
    };
    const ctx = createMockContext(req);
    const signed = sign(req.approval!.message, ownerKey);

    await expect(
      approveRequest(ctx, {
        requestId: req.id,
        signature: signed.signature,
        signerPubkey: signed.pubkey,
      }),
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
  });

  it('cancels a pending request without executing it, and it can no longer be approved', async () => {
    let stored = validRequest();
    const audit = { record: vi.fn() };
    const ctx = {
      store: {
        isFrozen: vi.fn(() => false),
        getRequest: vi.fn((id: string) => (id === stored.id ? stored : undefined)),
        getOwner: vi.fn(() => ownerPub),
        putRequest: vi.fn((next: PaymentRequest) => (stored = next)),
      },
      audit,
    } as unknown as AppContext;
    vi.mocked(execute).mockClear();

    const cancelled = cancelRequest(ctx, stored.id);

    expect(cancelled.status).toBe('denied');
    expect(cancelled.error).toMatchObject({ code: 'cancelled' });
    expect(audit.record).toHaveBeenCalledWith('approval.cancelled', stored.id, {});
    const signed = sign(payload && buildApprovalMessage(payload), ownerKey);
    await expect(
      approveRequest(ctx, { requestId: stored.id, signature: signed.signature, signerPubkey: signed.pubkey }),
    ).rejects.toMatchObject({ code: 'bad_status' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to cancel a request that is not waiting for approval, or that does not exist', () => {
    const confirmed = validRequest({ status: 'confirmed' });
    const ctx = createMockContext(confirmed);
    expect(() => cancelRequest(ctx, confirmed.id)).toThrowError(expect.objectContaining({ code: 'bad_status' }));
    expect(() => cancelRequest(ctx, 'req_missing')).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(ctx.store.putRequest).not.toHaveBeenCalled();
  });
  it('serializes concurrent approval retries for one request', async () => {
    const req = validRequest();
    const ctx = createMockContext(req);
    vi.mocked(execute).mockClear();
    const signed = sign(req.approval!.message, ownerKey);

    const input = {
      requestId: req.id,
      signature: signed.signature,
      signerPubkey: signed.pubkey,
    };
    const [first, second] = await Promise.all([approveRequest(ctx, input), approveRequest(ctx, input)]);

    expect(first).toEqual(second);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
