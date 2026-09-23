/**
 * Key handling and sealing. Nothing here ever leaves the agent process in clear
 * text: the agent's private key lives in memory and as ciphertext on disk, and
 * audit payloads are sealed before they are written.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

const ALGO = 'aes-256-gcm';

export type SealedBox = { iv: string; tag: string; ciphertext: string };

export type Sealer = {
  seal: (value: unknown) => SealedBox;
  open: <T = unknown>(box: SealedBox) => T;
};

/** The scrypt derivation runs once; sealing an entry is then a single cipher pass. */
export function createSealer(passphrase: string, salt: Buffer): Sealer {
  const key = scryptSync(passphrase, salt, 32);

  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGO, key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value ?? null), 'utf8'),
        cipher.final(),
      ]);
      return {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    },
    open<T>(box: SealedBox): T {
      const decipher = createDecipheriv(ALGO, key, Buffer.from(box.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(box.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    },
  };
}

export function randomNonce(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time compare, used for the owner public key. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify an ed25519 signature produced by Phantom's `signMessage`. Returns false
 * rather than throwing on malformed input, so a hostile body cannot crash a route.
 */
export function verifyMessageSignature(params: {
  message: string;
  signatureBase58: string;
  pubkeyBase58: string;
}): boolean {
  try {
    const signature = bs58.decode(params.signatureBase58);
    const pubkey = bs58.decode(params.pubkeyBase58);
    if (signature.length !== 64 || pubkey.length !== 32) return false;
    return nacl.sign.detached.verify(
      new TextEncoder().encode(params.message),
      signature,
      pubkey,
    );
  } catch {
    return false;
  }
}

type KeystoreFile = {
  version: 1;
  createdAt: string;
  publicKey: string;
  salt: string;
  sealed: SealedBox;
};

export type AgentKey = {
  publicKey: string;
  /** 64-byte ed25519 secret key. Never logged, never sent to a model. */
  secretKey: Uint8Array;
  created: boolean;
};

/** Load the agent keypair from its encrypted keystore, creating one on first run. */
export function loadOrCreateAgentKey(path: string, passphrase: string): AgentKey {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('AGENT_KEYSTORE_PASSPHRASE must be at least 8 characters');
  }

  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (raw) {
    const file = JSON.parse(raw) as KeystoreFile;
    const sealer = createSealer(passphrase, Buffer.from(file.salt, 'base64'));
    let secretKeyBase58: string;
    try {
      secretKeyBase58 = sealer.open<string>(file.sealed);
    } catch {
      throw new Error(
        `cannot decrypt ${path} - AGENT_KEYSTORE_PASSPHRASE does not match this keystore`,
      );
    }
    const secretKey = bs58.decode(secretKeyBase58);
    const publicKey = bs58.encode(secretKey.slice(32));
    if (publicKey !== file.publicKey) {
      throw new Error(`keystore ${path} is corrupt: public key mismatch`);
    }
    return { publicKey, secretKey, created: false };
  }

  const pair = nacl.sign.keyPair();
  const salt = randomBytes(16);
  const sealer = createSealer(passphrase, salt);
  const file: KeystoreFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    publicKey: bs58.encode(pair.publicKey),
    salt: salt.toString('base64'),
    sealed: sealer.seal(bs58.encode(pair.secretKey)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  return { publicKey: file.publicKey, secretKey: pair.secretKey, created: true };
}
