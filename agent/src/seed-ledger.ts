import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Caps how many initial seeds the Master Funder hands out in a sliding window, across all agents.
 * The route reserves a slot before it builds the transfer, so a burst of new wallets cannot spend more
 * than the cap even while earlier transfers are still in flight. Reserve, release and the cap check run
 * in one synchronous step, so concurrent requests cannot both take the last slot.
 *
 * Grant times are kept next to the funder key, so the count survives a restart while `/data` survives.
 */
export class SeedLedger {
  private grants: number[] = [];

  constructor(
    private readonly path: string | undefined,
    private readonly cap: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = DAY_MS,
  ) {
    this.load();
  }

  /** Takes one slot and returns its id, or null when the window is full. Throws if the slot cannot be saved. */
  reserve(): number | null {
    this.prune();
    if (this.grants.length >= this.cap) return null;
    // Strictly increasing, so an id identifies exactly one slot.
    const id = Math.max(this.now(), (this.grants.at(-1) ?? 0) + 1);
    this.grants.push(id);
    try {
      this.persist();
    } catch (err) {
      this.grants.pop();
      throw err;
    }
    return id;
  }

  /** Gives a slot back after a transfer that provably did not happen. */
  release(id: number): void {
    const index = this.grants.indexOf(id);
    if (index === -1) return;
    this.grants.splice(index, 1);
    try {
      this.persist();
    } catch {
      // The slot stays counted on disk until it ages out; that errs on the side of fewer seeds.
    }
  }

  /** Seconds until the oldest slot in the window frees up. */
  retryAfterSeconds(): number {
    this.prune();
    const oldest = this.grants[0];
    return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.grants.length > 0 && this.grants[0]! <= cutoff) this.grants.shift();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const stored = JSON.parse(readFileSync(this.path, 'utf8')) as { grants?: unknown };
      if (Array.isArray(stored.grants)) {
        this.grants = stored.grants.filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b);
      }
    } catch {
      // An unreadable ledger would otherwise lift the cap, so fail closed: count the whole cap as used now.
      this.grants = Array.from({ length: this.cap }, (_, index) => this.now() + index);
    }
    this.prune();
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ grants: this.grants }), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
