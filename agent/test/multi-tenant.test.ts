import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { SessionManager } from '../src/sessions.js';
import { Store } from '../src/store.js';
import { createContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';

function sign(message: string, key = nacl.sign.keyPair()) {
  return {
    key,
    pubkey: bs58.encode(key.publicKey),
    signature: bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(message), key.secretKey),
    ),
  };
}

describe('Multi-tenant SessionManager', () => {
  const adminKey = nacl.sign.keyPair();
  const adminPubkey = bs58.encode(adminKey.publicKey);

  const userAKey = nacl.sign.keyPair();
  const userAPubkey = bs58.encode(userAKey.publicKey);

  const userBKey = nacl.sign.keyPair();
  const userBPubkey = bs58.encode(userBKey.publicKey);

  it('allows multiple distinct users to login and maintains separate sessions', () => {
    const sm = new SessionManager([], 1800, adminPubkey);

    // User A challenge & login
    const challengeA = sm.createChallenge(userAPubkey, 'http://localhost:5173');
    expect(challengeA).not.toBeNull();
    const sigA = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challengeA!.message), userAKey.secretKey),
    );
    const sessionA = sm.verifyChallenge({
      challengeId: challengeA!.challengeId,
      pubkey: userAPubkey,
      signature: sigA,
    });
    expect(sessionA).not.toBeNull();
    expect(sessionA!.owner).toBe(userAPubkey);

    // User B challenge & login
    const challengeB = sm.createChallenge(userBPubkey, 'http://localhost:5173');
    expect(challengeB).not.toBeNull();
    const sigB = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challengeB!.message), userBKey.secretKey),
    );
    const sessionB = sm.verifyChallenge({
      challengeId: challengeB!.challengeId,
      pubkey: userBPubkey,
      signature: sigB,
    });
    expect(sessionB).not.toBeNull();
    expect(sessionB!.owner).toBe(userBPubkey);

    // Verify session retrieval
    const retrievedA = sm.getSession(sessionA!.token);
    expect(retrievedA?.owner).toBe(userAPubkey);
    expect(retrievedA?.isAdmin).toBe(false);

    const retrievedB = sm.getSession(sessionB!.token);
    expect(retrievedB?.owner).toBe(userBPubkey);
    expect(retrievedB?.isAdmin).toBe(false);
  });

  it('correctly marks admin sessions as isAdmin', () => {
    const sm = new SessionManager([], 1800, adminPubkey);

    const challenge = sm.createChallenge(adminPubkey, 'http://localhost:5173');
    const sig = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(challenge!.message), adminKey.secretKey),
    );
    const session = sm.verifyChallenge({
      challengeId: challenge!.challengeId,
      pubkey: adminPubkey,
      signature: sig,
    });

    const retrieved = sm.getSession(session!.token);
    expect(retrieved?.isAdmin).toBe(true);
    expect(retrieved?.owner).toBe(adminPubkey);
  });

  it('enforces allowedOwners whitelist if provided', () => {
    const sm = new SessionManager([userAPubkey], 1800, adminPubkey);

    expect(sm.createChallenge(userAPubkey, 'http://localhost:5173')).not.toBeNull();
    expect(sm.createChallenge(userBPubkey, 'http://localhost:5173')).toBeNull();
  });
});

describe('Multi-tenant Store & Context Isolation', () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-mt-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it('initializes store with initialOwner and defaults my-wallet to that pubkey', () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'state.json');
    const userPubkey = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

    const store = new Store(statePath, 'agent-001', 50, userPubkey);
    expect(store.getOwner()).toBe(userPubkey);
    expect(store.hasClaimedInitialFunding()).toBe(false);

    const policy = store.getPolicy();
    expect(policy.allowedRecipients).toEqual([
      { label: 'my-wallet', address: userPubkey },
    ]);

    store.setClaimedInitialFunding(true);
    expect(store.hasClaimedInitialFunding()).toBe(true);

    // Reopen store from disk to verify persistence
    const reloaded = new Store(statePath, 'agent-001', 50);
    expect(reloaded.getOwner()).toBe(userPubkey);
    expect(reloaded.hasClaimedInitialFunding()).toBe(true);
  });

  it('provides completely isolated contexts and agent wallets for different users', () => {
    const dir = makeTempDir();
    const config = {
      ...loadConfig(),
      AGENT_DATA_DIR: dir,
      dataDir: dir,
      usersDir: join(dir, 'users'),
      masterFunderPath: join(dir, 'master-funder.json'),
      legacyKeystorePath: join(dir, 'agent-keystore.json'),
      statePath: join(dir, 'state.json'),
      auditPath: join(dir, 'audit.jsonl'),
      keystorePath: join(dir, 'agent-keystore.json'),
      saltPath: join(dir, 'audit-salt'),
    };

    const masterCtx = createContext(config);
    expect(masterCtx.getUserContext).toBeDefined();

    const user1 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const user2 = 'BUoN4cmXh5JhYRBDhEw3rFSSwJmm9bHN9whQSitZZ44d';

    const ctx1 = masterCtx.getUserContext!(user1);
    const ctx2 = masterCtx.getUserContext!(user2);

    // Different dedicated agent pubkeys
    expect(ctx1.agentPubkey).toBeDefined();
    expect(ctx2.agentPubkey).toBeDefined();
    expect(ctx1.agentPubkey).not.toBe(ctx2.agentPubkey);

    // Isolated policies
    ctx1.store.setPolicy({
      maxSolLamportsPerTx: 200_000_000,
      allowedRecipients: [{ label: 'my-wallet', address: user1 }],
      allowedMints: [],
      maxTokenAmountByMint: {},
    });

    expect(ctx1.store.getPolicy().maxSolLamportsPerTx).toBe(200_000_000);
    expect(ctx2.store.getPolicy().maxSolLamportsPerTx).toBe(100_000_000); // unaffected default
  });
});
