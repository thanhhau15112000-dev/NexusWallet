import { createHash, randomBytes } from 'node:crypto';
import { randomNonce, verifyMessageSignature } from './crypto.js';

type Challenge = {
  message: string;
  expiresAt: number;
};

type Session = {
  expiresAt: number;
};

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_CHALLENGES = 64;
export const SESSION_COOKIE_NAME = 'nexus_session';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SessionManager {
  private readonly challenges = new Map<string, Challenge>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ownerPubkey: string,
    private readonly ttlSeconds: number,
  ) {}

  createChallenge(pubkey: string, origin: string): { challengeId: string; message: string; expiresAt: string } | null {
    this.prune();
    if (pubkey !== this.ownerPubkey) return null;

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
      `Wallet: ${this.ownerPubkey}`,
      `Nonce: ${randomNonce(32)}`,
      `Issued At: ${new Date().toISOString()}`,
      `Expires At: ${new Date(expiresAt).toISOString()}`,
      '',
      'This signature only establishes a login session. It does not authorize a transaction.',
    ].join('\n');

    this.challenges.set(challengeId, { message, expiresAt });
    return { challengeId, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  verifyChallenge(input: {
    challengeId: string;
    pubkey: string;
    signature: string;
  }): { token: string; expiresAt: string } | null {
    this.prune();
    const challenge = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    if (!challenge || input.pubkey !== this.ownerPubkey || challenge.expiresAt <= Date.now()) {
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
    this.sessions.set(tokenHash(token), { expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  getSession(token: string): { owner: string; expiresAt: string } | null {
    this.prune();
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.expiresAt <= Date.now()) return null;
    return { owner: this.ownerPubkey, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  revoke(token: string): void {
    this.sessions.delete(tokenHash(token));
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    }
    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(hash);
    }
  }
}
