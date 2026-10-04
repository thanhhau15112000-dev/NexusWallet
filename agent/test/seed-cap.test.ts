import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Keypair } from '@solana/web3.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import * as funder from '../src/funder.js';
import { registerRoutes } from '../src/routes.js';
import { SeedLedger } from '../src/seed-ledger.js';
import { SESSION_COOKIE_NAME } from '../src/sessions.js';

const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-seed-cap-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('SeedLedger', () => {
  it('grants up to the cap and frees slots as they leave the 24 hour window', () => {
    let now = 1_000_000_000_000;
    const ledger = new SeedLedger(undefined, 2, () => now);

    expect(ledger.reserve()).not.toBeNull();
    now += 10 * HOUR;
    expect(ledger.reserve()).not.toBeNull();
    expect(ledger.reserve()).toBeNull();
    expect(ledger.retryAfterSeconds()).toBe(14 * 3600);

    now += 14 * HOUR; // the first grant is now exactly 24 hours old
    expect(ledger.reserve()).not.toBeNull();
    expect(ledger.reserve()).toBeNull(); // the second grant is still inside the window
    now += 10 * HOUR;
    expect(ledger.reserve()).not.toBeNull();
  });

  it('gives a slot back on release and ignores unknown ids', () => {
    const ledger = new SeedLedger(undefined, 1, () => 5_000);
    const id = ledger.reserve()!;
    expect(ledger.reserve()).toBeNull();
    ledger.release(id + 1);
    expect(ledger.reserve()).toBeNull();
    ledger.release(id);
    expect(ledger.reserve()).not.toBeNull();
  });

  it('keeps the count across a restart', () => {
    const path = join(tempDir(), 'seed-ledger.json');
    const now = () => 2_000_000_000_000;
    const first = new SeedLedger(path, 2, now);
    first.reserve();
    first.reserve();

    const restarted = new SeedLedger(path, 2, now);
    expect(restarted.reserve()).toBeNull();
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('counts the whole cap as used when the ledger file is unreadable, instead of lifting the cap', () => {
    const path = join(tempDir(), 'seed-ledger.json');
    writeFileSync(path, '{not json');
    expect(new SeedLedger(path, 3, () => 1_000).reserve()).toBeNull();
  });

  it('blocks for 24 hours from the moment a bad ledger file is found, not from every restart', () => {
    for (const content of ['{not json', '{}', '{"grants": "x"}']) {
      const path = join(tempDir(), 'seed-ledger.json');
      writeFileSync(path, content);
      const start = 1_000_000_000_000;

      expect(new SeedLedger(path, 3, () => start).reserve(), content).toBeNull();
      // A restart an hour later is still inside the block and does not push it back.
      expect(new SeedLedger(path, 3, () => start + HOUR).reserve(), content).toBeNull();
      expect(new SeedLedger(path, 3, () => start + 25 * HOUR).reserve(), content).not.toBeNull();
    }
  });

  it('does not grant a slot it could not save', () => {
    const dir = tempDir();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'file');
    // The parent of the ledger path is a file, so every write fails.
    const ledger = new SeedLedger(join(blocker, 'seed-ledger.json'), 5, () => 1_000);
    expect(() => ledger.reserve()).toThrow();
    expect(readFileSync(blocker, 'utf8')).toBe('file');
  });
});

async function startApp(cap: number) {
  const dir = tempDir();
  const config = {
    ...loadConfig(),
    SEED_CAP_PER_DAY: cap,
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
  const ctx = createContext(config);
  const app = Fastify();
  await app.register(cookie, { secret: config.SESSION_COOKIE_SECRET });
  await registerRoutes(app, ctx);

  async function newOwner(): Promise<string> {
    const key = nacl.sign.keyPair();
    const pubkey = bs58.encode(key.publicKey);
    const issued = (await app.inject({ method: 'POST', url: '/api/auth/challenge', payload: { pubkey } })).json();
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(issued.message), key.secretKey));
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { challengeId: issued.challengeId, pubkey, signature },
    });
    const session = res.cookies.find((item: { name: string }) => item.name === SESSION_COOKIE_NAME)!;
    return `${session.name}=${session.value}`;
  }

  const claim = (cookieHeader: string) =>
    app.inject({ method: 'POST', url: '/api/agent/claim-seed', headers: { cookie: cookieHeader } });

  return { app, ctx, newOwner, claim };
}

describe('POST /api/agent/claim-seed total cap', () => {
  it('refuses the claim after the cap without building a transfer', async () => {
    const { app, newOwner, claim } = await startApp(3);
    const dispense = vi.spyOn(funder, 'dispenseInitialSeed').mockResolvedValue({ signature: 'sig', slot: 1 });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) statuses.push((await claim(await newOwner())).statusCode);
      expect(statuses).toEqual([200, 200, 200, 429]);
      expect(dispense).toHaveBeenCalledTimes(3);

      const refused = await claim(await newOwner());
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        error: 'seed_cap_reached',
        message: expect.stringContaining('faucet.solana.com'),
        details: { retryAfterSeconds: expect.any(Number) },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(dispense).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('does not exceed the cap when claims arrive at the same time', async () => {
    const { app, newOwner, claim } = await startApp(3);
    const dispense = vi.spyOn(funder, 'dispenseInitialSeed').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { signature: 'sig', slot: 1 };
    });
    try {
      const cookies = await Promise.all(Array.from({ length: 8 }, () => newOwner()));
      const responses = await Promise.all(cookies.map((cookieHeader) => claim(cookieHeader)));
      const statuses = responses.map((res) => res.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
      expect(dispense).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
    }
  });

  it('opens again once grants leave the 24 hour window', async () => {
    const { app, ctx, newOwner, claim } = await startApp(2);
    let now = Date.now();
    ctx.seedLedger = new SeedLedger(undefined, 2, () => now);
    vi.spyOn(funder, 'dispenseInitialSeed').mockResolvedValue({ signature: 'sig', slot: 1 });
    try {
      expect((await claim(await newOwner())).statusCode).toBe(200);
      expect((await claim(await newOwner())).statusCode).toBe(200);
      expect((await claim(await newOwner())).statusCode).toBe(429);

      now += 24 * HOUR;
      expect((await claim(await newOwner())).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('keeps one seed per agent: a second claim is already_claimed even when the cap is full', async () => {
    const { app, newOwner, claim } = await startApp(1);
    const dispense = vi.spyOn(funder, 'dispenseInitialSeed').mockResolvedValue({ signature: 'sig', slot: 1 });
    try {
      const owner = await newOwner();
      expect((await claim(owner)).statusCode).toBe(200);
      const again = await claim(owner);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('already_claimed');
      expect(dispense).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns the slot when the transfer provably did not happen', async () => {
    const { app, newOwner, claim } = await startApp(1);
    const dispense = vi
      .spyOn(funder, 'dispenseInitialSeed')
      .mockRejectedValueOnce(new Error('Master Funder wallet does not have enough Devnet SOL'))
      .mockResolvedValue({ signature: 'sig', slot: 1 });
    try {
      const failed = await claim(await newOwner());
      expect(failed.statusCode).toBe(502);
      expect((await claim(await newOwner())).statusCode).toBe(200);
      expect(dispense).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('keeps the slot while a signed transfer is unresolved, and resuming it takes no second slot', async () => {
    const { app, newOwner, claim } = await startApp(1);
    let attempts = 0;
    vi.spyOn(funder, 'dispenseInitialSeed').mockImplementation(async (params) => {
      attempts += 1;
      if (!params.pending) {
        params.persistPending({
          signature: 'pending-sig',
          serializedTransaction: 'bW9jay10cmFuc2FjdGlvbg==',
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: 1000,
          recipientPubkey: params.recipientPubkey,
          amountLamports: params.amountLamports,
        });
        throw new funder.SeedTransferOutcomeUnknownError('rpc down');
      }
      return { signature: params.pending.signature, slot: 2 };
    });
    try {
      const owner = await newOwner();
      expect((await claim(owner)).statusCode).toBe(409);
      expect((await claim(await newOwner())).statusCode).toBe(429);

      const resumed = await claim(owner);
      expect(resumed.statusCode).toBe(200);
      expect(attempts).toBe(2);
      expect((await claim(await newOwner())).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it('defaults to 50 seeds per day', () => {
    expect(loadConfig().SEED_CAP_PER_DAY).toBe(50);
  });
});
