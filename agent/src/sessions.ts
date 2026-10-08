import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomNonce, verifyMessageSignature } from './crypto.js';

type Challenge = {
  pubkey: string;
  message: string;
  expiresAt: number;
};

type Session = {
  owner: string;
  expiresAt: number;
};

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
// Pending challenges live two minutes and are small. The cap only bounds memory; it is high enough
// that a per-address rate limit cannot be outrun by a few clients evicting real users' challenges.
const MAX_CHALLENGES = 4096;
export const SESSION_COOKIE_NAME = 'nexus_session';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionManager {
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, Session>();
  private readonly allowedOwners: string[];

  constructor(
    allowedOwners: string | string[] = [],
    private readonly ttlSeconds: number = 1800,
    private readonly adminPubkey?: string,
    /** Optional file that keeps sessions across agent restarts; stores token hashes only. */
    private readonly storePath?: string,
  ) {
    this.allowedOwners = Array.isArray(allowedOwners)
      ? allowedOwners
      : allowedOwners ? [allowedOwners] : [];
    this.load();
  }

  createChallenge(pubkey: string, origin: string): { challengeId: string; message: string; expiresAt: string } | null {
    this.prune();
    if (this.allowedOwners.length > 0 && !this.allowedOwners.includes(pubkey)) {
      return null;
    }

    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value as string | undefined;
      if (!oldest) break;
      this.challenges.delete(oldest);
    }

    const challengeId = randomNonce(32);
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const message = [
      'nexusPay login',
      `Origin: ${origin}`,
      `Wallet: ${pubkey}`,
      `Nonce: ${randomNonce(32)}`,
      `Issued At: ${new Date().toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
      '',
      'This signature only establishes a login session. It does not authorize a transaction.',
    ].join('\n');

    this.challenges.set(challengeId, { pubkey, message, expiresAt });
    return { challengeId, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  verifyChallenge(input: {
    challengeId: string;
    pubkey: string;
    signature: string;
  }): { token: string; expiresAt: string; owner: string } | null {
    this.prune();
    const challenge = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    if (!challenge || input.pubkey !== challenge.pubkey || challenge.expiresAt <= Date.now()) {
      return null;
    }
    if (
      !verifyMessageSignature({
        message: challenge.message,
        signatureBase58: input.signature,
        pubkeyBase58: input.pubkey,
      })
    ) {
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    this.sessions.set(tokenHash(token), { owner: input.pubkey, expiresAt });
    this.persist();
    return { token, expiresAt: new Date(expiresAt).toISOString(), owner: input.pubkey };
  }

  getSession(token: string): { owner: string; expiresAt: string; isAdmin: boolean } | null {
    this.prune();
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.expiresAt <= Date.now()) return null;
    const isAdmin = Boolean(this.adminPubkey && session.owner === this.adminPubkey);
    return { owner: session.owner, expiresAt: new Date(session.expiresAt).toISOString(), isAdmin };
  }

  revoke(token: string): void {
    if (this.sessions.delete(tokenHash(token))) this.persist();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    let removed = false;
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) removed = this.sessions.delete(hash) || removed;
    }
    if (removed) this.persist();
  }

  private load(): void {
    if (!this.storePath || !existsSync(this.storePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.storePath, 'utf8')) as Record<string, Session>;
      const now = Date.now();
      for (const [hash, session] of Object.entries(stored)) {
        if (/^[0-9a-f]{64}$/.test(hash) && typeof session?.owner === 'string' && session.expiresAt > now) {
          this.sessions.set(hash, { owner: session.owner, expiresAt: session.expiresAt });
        }
      }
    } catch {
      // A corrupt session file only costs a re-login; start empty.
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }
}
