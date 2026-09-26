/**
 * Headless end-to-end check against a running agent service.
 *
 * It drives the three demo paths and the approval attack cases with a locally
 * generated ed25519 key standing in for Phantom. It binds that key as the agent
 * owner, so re-connect Phantom in the dashboard afterwards to take ownership
 * back. This is intentionally a local-demo-only flow; pin OWNER_PUBKEY for a
 * deployed instance.
 *
 *   pnpm --filter @nexus/agent e2e
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { buildApprovalMessage, type PaymentRequest } from '@nexus/shared';

const BASE = process.env.AGENT_API ?? 'http://127.0.0.1:8787';
const OFF_ALLOWLIST = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

const configuredOwnerSecret = process.env.E2E_OWNER_SECRET;
const owner = configuredOwnerSecret
  ? nacl.sign.keyPair.fromSecretKey(bs58.decode(configuredOwnerSecret))
  : nacl.sign.keyPair();
const ownerPubkey = bs58.encode(owner.publicKey);

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T & { error?: string; message?: string } }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(path !== '/api/health' ? { 'x-owner-pubkey': ownerPubkey } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T & { error?: string } };
}

function sign(message: string, key = owner): string {
  return bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey));
}

async function command(prompt: string): Promise<PaymentRequest> {
  const { body } = await call<{ request: PaymentRequest }>('/api/commands', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  });
  return body.request;
}

async function main(): Promise<void> {
  const health = await call<{ ok: boolean; cluster: string }>('/api/health');
  if (health.status !== 200) throw new Error(`agent service not reachable at ${BASE}`);
  console.log(`agent: ${BASE} cluster=${health.body.cluster}\n`);

  await call('/api/owner', { method: 'POST', body: JSON.stringify({ pubkey: ownerPubkey }) });

  const policy = await call<{ policy: { version: number } }>('/api/policy', {
    method: 'PUT',
    body: JSON.stringify({
      maxSolPerTx: 0.1,
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    }),
  });
  check('policy saved', policy.status === 200, `v${policy.body.policy?.version}`);

  // 1. under the limit -> the agent signs on its own
  const auto = await command('Send 0.05 SOL to treasury');
  check(
    'under-limit request is auto-approved by policy',
    auto.decision?.verdict === 'allow',
    auto.decision?.reasons.join('; '),
  );
  check(
    'under-limit request reaches the chain',
    auto.status === 'confirmed',
    auto.execution?.explorerUrl ?? `${auto.status}: ${auto.error?.message ?? ''}`,
  );

  // 2. over the limit -> held for the owner
  const held = await command('Send 0.5 SOL to treasury');
  check('over-limit request requires approval', held.status === 'pending_approval', held.status);
  check('over-limit request has a bound approval message', Boolean(held.approval?.message));

  if (held.approval) {
    const message = held.approval.message;
    check(
      'approval message is reproducible from its payload',
      message === buildApprovalMessage(held.approval.payload),
    );

    const stranger = nacl.sign.keyPair();
    const wrongSigner = await call(`/api/requests/${held.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        signature: sign(message, stranger),
        signerPubkey: bs58.encode(stranger.publicKey),
      }),
    });
    check(
      'approval from a non-owner wallet is rejected',
      wrongSigner.status === 403 && wrongSigner.body.error === 'wrong_signer',
      wrongSigner.body.error,
    );

    const tampered = await call(`/api/requests/${held.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        signature: sign(message.replace('0.5 SOL', '5 SOL')),
        signerPubkey: ownerPubkey,
      }),
    });
    check(
      'signature over a tampered message is rejected',
      tampered.status === 403 && tampered.body.error === 'bad_signature',
      tampered.body.error,
    );

    const approved = await call<{ request: PaymentRequest }>(
      `/api/requests/${held.id}/approve`,
      { method: 'POST', body: JSON.stringify({ signature: sign(message), signerPubkey: ownerPubkey }) },
    );
    check('owner approval is accepted', approved.status === 200, approved.body.error ?? '');
    check(
      'approved request reaches the chain',
      approved.body.request?.status === 'confirmed',
      approved.body.request?.execution?.explorerUrl ??
        `${approved.body.request?.status}: ${approved.body.request?.error?.message ?? ''}`,
    );

    const replay = await call(`/api/requests/${held.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ signature: sign(message), signerPubkey: ownerPubkey }),
    });
    check(
      'replaying the same approval is rejected',
      replay.status === 403,
      replay.body.error,
    );
  }

  // 3. recipient outside the allowlist -> denied outright
  const denied = await command(`Send 0.01 SOL to ${OFF_ALLOWLIST}`);
  check('off-allowlist recipient is denied', denied.decision?.verdict === 'deny', denied.status);
  check('denied request never produced a transaction', denied.execution === null);

  // 4. a stale approval dies when the policy changes under it
  const stale = await command('Send 0.7 SOL to treasury');
  check('second over-limit request is held', stale.status === 'pending_approval', stale.status);
  await call('/api/policy', {
    method: 'PUT',
    body: JSON.stringify({
      maxSolPerTx: 0.1,
      allowedRecipients: [{ label: 'treasury', address: ownerPubkey }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    }),
  });
  if (stale.approval) {
    const afterPolicyChange = await call(`/api/requests/${stale.id}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        signature: sign(stale.approval.message),
        signerPubkey: ownerPubkey,
      }),
    });
    check(
      'approval issued under an older policy version is rejected',
      afterPolicyChange.status === 403 && afterPolicyChange.body.error === 'policy_changed',
      afterPolicyChange.body.error,
    );
  }

  const audit = await call<{ entries: { event: string }[] }>('/api/audit?limit=200');
  const events = new Set(audit.body.entries.map((e) => e.event));
  check(
    'audit log recorded the policy decisions',
    events.has('policy.decided') && events.has('approval.requested'),
    [...events].join(', '),
  );

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
