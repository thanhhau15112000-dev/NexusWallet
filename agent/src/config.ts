import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default('127.0.0.1'),

  // This MVP is intentionally Devnet-only. Do not let an environment typo
  // move the agent signer onto another Solana cluster.
  SOLANA_CLUSTER: z.literal('devnet').default('devnet'),
  SOLANA_RPC_URL: z.string().url().default('https://api.devnet.solana.com'),

  AGENT_ID: z.string().min(1).default('agent-001'),
  AGENT_DATA_DIR: z.string().default('./data'),
  AGENT_KEYSTORE_PASSPHRASE: z.string().min(8).default('nexus-devnet-demo-passphrase'),
  AUDIT_ENCRYPTION_PASSPHRASE: z.string().min(8).default('nexus-devnet-demo-audit-key'),

  /** Pin the owner wallet. Left empty, the first wallet that connects is bound. */
  OWNER_PUBKEY: z.string().trim().default(''),

  /** `auto` uses a provider when its key is set, `mock` never calls one. */
  MODEL_MODE: z.enum(['auto', 'mock']).default('auto'),
  GEMINI_API_KEY: z.string().trim().default(''),
  GEMINI_MODEL: z.string().trim().default('gemini-2.5-flash'),
  GEMINI_THINKING_BUDGET: z.coerce.number().int().min(0).default(2048),
  GROQ_API_KEY: z.string().trim().default(''),
  GROQ_MODEL: z.string().trim().default('openai/gpt-oss-120b'),

  WEB_ORIGIN: z.string().default('http://localhost:5173'),

  APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_REQUESTS_KEPT: z.coerce.number().int().positive().default(200),
});

export const LOCAL_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const DEVNET_RPC_HOSTS = new Set(['api.devnet.solana.com']);

/**
 * The MVP is deliberately limited to the official Solana Devnet endpoint.
 * A URL containing no "mainnet"/"testnet" marker is not proof that it serves
 * Devnet, so arbitrary custom RPC hosts must not receive the agent signer.
 */
export function isAllowedDevnetRpcUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      DEVNET_RPC_HOSTS.has(url.hostname.toLowerCase()) &&
      (!url.port || url.port === '443') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
  }

  const env = EnvSchema.parse(process.env);

  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!loopbackHosts.has(env.HOST.toLowerCase())) {
    throw new Error(
      `HOST must be a loopback address (127.0.0.1 or localhost) in local-only MVP; received "${env.HOST}"`,
    );
  }

  if (!isAllowedDevnetRpcUrl(env.SOLANA_RPC_URL)) {
    throw new Error(
      'only Devnet is supported in this MVP; use the official Solana Devnet RPC endpoint; custom, testnet and mainnet RPC URLs are out of scope',
    );
  }

  const allowedOrigins = env.WEB_ORIGIN.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  for (const origin of allowedOrigins) {
    if (!LOCAL_ORIGIN_REGEX.test(origin)) {
      throw new Error(
        `WEB_ORIGIN contains non-local origin "${origin}"; only local origins are permitted`,
      );
    }
  }

  const dataDir = resolve(process.cwd(), env.AGENT_DATA_DIR);

  return {
    ...env,
    dataDir,
    statePath: resolve(dataDir, 'state.json'),
    auditPath: resolve(dataDir, 'audit.jsonl'),
    keystorePath: resolve(dataDir, 'agent-keystore.json'),
    saltPath: resolve(dataDir, 'audit-salt'),
    allowedOrigins,
  };
}
