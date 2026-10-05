import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { SessionManager } from '../src/sessions.js';

function login(sm: SessionManager, key = nacl.sign.keyPair()) {
  const pubkey = bs58.encode(key.publicKey);
  const challenge = sm.createChallenge(pubkey, 'http://localhost:5173')!;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), key.secretKey));
  return { pubkey, session: sm.verifyChallenge({ challengeId: challenge.challengeId, pubkey, signature })! };
}

describe('SessionManager challenges', () => {
  it('keeps a pending challenge usable while many others are requested', () => {
    const sm = new SessionManager([], 1800);
    const key = nacl.sign.keyPair();
    const pubkey = bs58.encode(key.publicKey);
    const real = sm.createChallenge(pubkey, 'http://localhost:5173')!;
    for (let i = 0; i < 500; i += 1) sm.createChallenge(bs58.encode(nacl.sign.keyPair().publicKey), 'http://localhost:5173');

    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(real.message), key.secretKey));
    expect(sm.verifyChallenge({ challengeId: real.challengeId, pubkey, signature })?.owner).toBe(pubkey);
  });
});

describe('SessionManager persistence', () => {
  it('keeps sessions across a restart and stores only token hashes', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'nexus-sessions-')), 'sessions.json');
    const first = new SessionManager([], 1800, undefined, storePath);
    const { pubkey, session } = login(first);

    expect(readFileSync(storePath, 'utf8')).not.toContain(session.token);

    // A new manager over the same file stands in for an agent restart.
    const restarted = new SessionManager([], 1800, undefined, storePath);
    expect(restarted.getSession(session.token)?.owner).toBe(pubkey);

    restarted.revoke(session.token);
    expect(new SessionManager([], 1800, undefined, storePath).getSession(session.token)).toBeNull();
  });

  it('drops expired or malformed entries on load', () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'nexus-sessions-')), 'sessions.json');
    const sm = new SessionManager([], 1800, undefined, storePath);
    const { session } = login(sm);
    const stored = JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, { owner: string; expiresAt: number }>;
    for (const entry of Object.values(stored)) entry.expiresAt = Date.now() - 1;
    stored['not-a-hash'] = { owner: 'x', expiresAt: Date.now() + 60_000 };
    writeFileSync(storePath, JSON.stringify(stored));

    expect(new SessionManager([], 1800, undefined, storePath).getSession(session.token)).toBeNull();

    writeFileSync(storePath, '{not json');
    expect(() => new SessionManager([], 1800, undefined, storePath)).not.toThrow();
  });
});
