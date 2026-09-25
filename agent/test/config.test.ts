import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  process.env = { ...ENV_BACKUP };
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
});

describe('loadConfig - cluster boundary', () => {
  it('accepts the Devnet MVP cluster', () => {
    process.env.SOLANA_CLUSTER = 'devnet';

    expect(loadConfig().SOLANA_CLUSTER).toBe('devnet');
  });

  it('rejects another Solana cluster', () => {
    process.env.SOLANA_CLUSTER = 'testnet';

    expect(() => loadConfig()).toThrow(/Invalid literal value, expected.*devnet/i);
  });

  it('rejects mainnet RPC URL', () => {
    process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';

    expect(() => loadConfig()).toThrow(/only devnet is supported/i);
  });

  it('rejects testnet RPC URL', () => {
    process.env.SOLANA_RPC_URL = 'https://api.testnet.solana.com';

    expect(() => loadConfig()).toThrow(/only devnet is supported/i);
  });

  it('rejects an arbitrary RPC host that does not prove Devnet', () => {
    process.env.SOLANA_RPC_URL = 'https://example.com/solana-rpc';

    expect(() => loadConfig()).toThrow(/official Solana Devnet RPC endpoint/i);
  });

  it('rejects a non-standard port on the official RPC hostname', () => {
    process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com:8443';

    expect(() => loadConfig()).toThrow(/official Solana Devnet RPC endpoint/i);
  });

  it('accepts the official Solana Devnet RPC endpoint', () => {
    process.env.SOLANA_RPC_URL = 'https://api.devnet.solana.com';

    expect(loadConfig().SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
  });
});

describe('loadConfig - loopback and local runtime', () => {
  it('defaults HOST to 127.0.0.1', () => {
    delete process.env.HOST;

    expect(loadConfig().HOST).toBe('127.0.0.1');
  });

  it('accepts localhost as HOST', () => {
    process.env.HOST = 'localhost';

    expect(loadConfig().HOST).toBe('localhost');
  });

  it('rejects public host 0.0.0.0 in local-only MVP', () => {
    process.env.HOST = '0.0.0.0';

    expect(() => loadConfig()).toThrow(/HOST must be a loopback address/i);
  });

  it('rejects external IP addresses as HOST', () => {
    process.env.HOST = '192.168.1.100';

    expect(() => loadConfig()).toThrow(/HOST must be a loopback address/i);
  });

  it('accepts local WEB_ORIGIN', () => {
    process.env.WEB_ORIGIN = 'http://localhost:5173,http://127.0.0.1:5173';

    const config = loadConfig();
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('rejects non-local WEB_ORIGIN', () => {
    process.env.WEB_ORIGIN = 'https://example.com';

    expect(() => loadConfig()).toThrow(/WEB_ORIGIN contains non-local origin/i);
  });

  it('preserves optional OWNER_PUBKEY', () => {
    delete process.env.OWNER_PUBKEY;
    expect(loadConfig().OWNER_PUBKEY).toBe('');

    process.env.OWNER_PUBKEY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    expect(loadConfig().OWNER_PUBKEY).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  });

  it('correctly resolves adminPubkey precedence', () => {
    delete process.env.ADMIN_PUBKEY;
    delete process.env.OWNER_PUBKEY;
    // Default fallback
    expect(loadConfig().adminPubkey).toBe('GePDtss1nywz1RZcS2tvcRwKCkh8J3HdamfhWAkDrard');

    // OWNER_PUBKEY override
    process.env.OWNER_PUBKEY = 'BUoN4cmXh5JhYRBDhEw3rFSSwJmm9bHN9whQSitZZ44d';
    expect(loadConfig().adminPubkey).toBe('BUoN4cmXh5JhYRBDhEw3rFSSwJmm9bHN9whQSitZZ44d');

    // ADMIN_PUBKEY takes highest precedence
    process.env.ADMIN_PUBKEY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    expect(loadConfig().adminPubkey).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  });
});
