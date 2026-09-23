import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { AuditEntry, AuditEntryView } from '@nexus/shared';
import { createSealer, type Sealer } from './crypto.js';

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
 * Append-only audit log. The event name stays in clear text so the log can be
 * scanned without the key; the detail payload (addresses, amounts, model
 * output, policy reasons) is sealed with AES-256-GCM.
 */
export class AuditLog {
  private readonly sealer: Sealer;

  constructor(
    private readonly path: string,
    saltPath: string,
    passphrase: string,
  ) {
    this.sealer = createSealer(passphrase, loadSalt(saltPath));
  }

  record(event: string, requestId: string | null, detail: unknown): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      requestId,
      event,
      sealed: this.sealer.seal(detail),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    return entry;
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
