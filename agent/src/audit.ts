import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { AuditEntry, AuditEntryView } from '@nexus/shared';
import { createSealer, type Sealer } from './crypto.js';

const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function loadSalt(path: string): Buffer {
  try {
    return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const salt = randomBytes(16);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, salt.toString('base64'), { mode: 0o600 });
    return salt;
  }
}

/**
 * Append-only tamper-evident audit log with cryptographic SHA-256 hash chaining.
 * The event name stays in clear text so the log can be scanned without the key;
 * the detail payload is sealed with AES-256-GCM.
 * Each entry cryptographically binds to the previous entry hash to detect
 * deletion, insertion, modification, or reordering.
 */
export class AuditLog {
  private readonly sealer: Sealer;
  private lastHash: string = GENESIS_PREV_HASH;

  constructor(
    private readonly path: string,
    saltPath: string,
    passphrase: string,
  ) {
    this.sealer = createSealer(passphrase, loadSalt(saltPath));
    this.initializeLastHash();
  }

  private initializeLastHash(): void {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const lastEntry = JSON.parse(lastLine) as AuditEntry;
        if (lastEntry.hash) {
          this.lastHash = lastEntry.hash;
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  record(event: string, requestId: string | null, detail: unknown): AuditEntry {
    const id = randomUUID();
    const at = new Date().toISOString();
    const sealed = this.sealer.seal(detail);
    const prevHash = this.lastHash;
    const hash = createHash('sha256')
      .update(`${prevHash}:${id}:${at}:${requestId ?? ''}:${event}:${sealed.ciphertext}:${sealed.tag}`)
      .digest('hex');
    this.lastHash = hash;

    const entry: AuditEntry = {
      id,
      at,
      requestId,
      event,
      sealed,
      prevHash,
      hash,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  /**
   * Verifies the cryptographic integrity of the audit log file.
   * Detects deleted lines, reordered entries, modified timestamps, or tampered payloads.
   */
  verifyIntegrity(): { valid: boolean; compromisedIndex?: number; reason?: string } {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { valid: true };
      throw err;
    }

    const lines = raw.split('\n').filter(Boolean);
    let expectedPrevHash = GENESIS_PREV_HASH;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        return { valid: false, compromisedIndex: i, reason: 'corrupted_json' };
      }

      if (!entry.hash || !entry.prevHash) {
        return { valid: false, compromisedIndex: i, reason: 'missing_hash_metadata' };
      }

      if (entry.prevHash !== expectedPrevHash) {
        return { valid: false, compromisedIndex: i, reason: 'broken_hash_chain' };
      }

      const calculatedHash = createHash('sha256')
        .update(`${entry.prevHash}:${entry.id}:${entry.at}:${entry.requestId ?? ''}:${entry.event}:${entry.sealed.ciphertext}:${entry.sealed.tag}`)
        .digest('hex');

      if (entry.hash !== calculatedHash) {
        return { valid: false, compromisedIndex: i, reason: 'tampered_entry_hash' };
      }

      expectedPrevHash = entry.hash;
    }

    return { valid: true };
  }

  /** Newest first. `reveal` decrypts the payload for the dashboard. */
  list(limit = 100, reveal = true): AuditEntryView[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const lines = raw.split('\n').filter(Boolean).slice(-limit).reverse();
    return lines.map((line) => {
      const entry = JSON.parse(line) as AuditEntry;
      let detail: unknown = null;
      if (reveal) {
        try {
          detail = this.sealer.open(entry.sealed);
        } catch {
          detail = { error: 'cannot decrypt: audit key changed since this entry was written' };
        }
      }
      return { ...entry, detail };
    });
  }
}
