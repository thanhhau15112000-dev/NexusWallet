import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Settings come from the MCP client's `env` block or are discovered from the local
 * agent service's data directory. Phase 1 talks to a local agent service only.
 * The tenant is authenticated by the per-tenant MCP token (`nxp_<ownerPubkey>_<secret>`),
 * sent as a bearer token.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const AGENT_TOKEN = /^nxp_([1-9A-HJ-NP-Za-km-z]{32,44})_[A-Za-z0-9_-]{43}$/;
const PUBKEY_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type McpConfig = {
  apiUrl: string;
  agentToken: string;
  /** Owner wallet the token belongs to; for messages only, never sent as a credential. */
  ownerPubkey: string;
  /** Source of the token: 'env' or the absolute path to the token file. */
  tokenSource: 'env' | string;
  dashboardUrl: string;
  timeoutMs: number;
};

export type LoadMcpConfigOptions = {
  repoRoot?: string;
};

function loopbackOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${name} must be a loopback origin such as http://127.0.0.1:8787; hosted agents are not supported yet`,
    );
  }
  return url.origin;
}

type Candidate = {
  owner: string;
  tokenPath: string;
  token: string;
};

function discoverTokenFromDisk(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): { agentToken: string; ownerPubkey: string; tokenSource: string } {
  let dataDir: string;
  const rawNexusDataDir = env.NEXUS_AGENT_DATA_DIR?.trim();

  if (rawNexusDataDir) {
    dataDir = resolve(rawNexusDataDir);
    if (!existsSync(dataDir)) {
      throw new Error(`NEXUS_AGENT_DATA_DIR directory does not exist: ${dataDir}`);
    }
  } else {
    let agentDataDirValue = env.AGENT_DATA_DIR?.trim();
    if (!agentDataDirValue) {
      const envPath = resolve(repoRoot, '.env');
      if (existsSync(envPath)) {
        try {
          const parsed = parseEnv(readFileSync(envPath, 'utf8'));
          agentDataDirValue = parsed.AGENT_DATA_DIR?.trim();
        } catch {
          // Ignore malformed .env
        }
      }
    }
    dataDir = resolve(repoRoot, 'agent', agentDataDirValue || './data');
  }

  const usersDir = resolve(dataDir, 'users');
  const candidates: Candidate[] = [];

  if (existsSync(usersDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(usersDir);
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!PUBKEY_REGEX.test(entry)) continue;
      const tenantDir = resolve(usersDir, entry);
      try {
        if (!statSync(tenantDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const tokenPath = resolve(tenantDir, 'mcp-token');
      if (!existsSync(tokenPath)) continue;
      let token = '';
      try {
        token = readFileSync(tokenPath, 'utf8').trim();
      } catch {
        continue;
      }
      const match = AGENT_TOKEN.exec(token);
      if (!match) continue;
      if (match[1] !== entry) continue;
      candidates.push({ owner: entry, tokenPath, token });
    }
  }

  const requestedOwner = env.NEXUS_OWNER_PUBKEY?.trim();
  let selected: Candidate;

  if (requestedOwner) {
    const match = candidates.find((c) => c.owner === requestedOwner);
    if (!match) {
      throw new Error(
        `no MCP token found for owner ${requestedOwner} in ${dataDir}; sign in to the dashboard with that wallet once`,
      );
    }
    selected = match;
  } else {
    if (candidates.length === 0) {
      throw new Error(
        `no MCP token found in ${dataDir}; sign in to the dashboard with the owner wallet once (creates the MCP token), searched ${dataDir}`,
      );
    }
    if (candidates.length > 1) {
      const owners = candidates.map((c) => c.owner).join(', ');
      throw new Error(
        `multiple owners with MCP tokens found (${owners}); set NEXUS_OWNER_PUBKEY to specify which one to use`,
      );
    }
    selected = candidates[0]!;
  }

  return {
    agentToken: selected.token,
    ownerPubkey: selected.owner,
    tokenSource: selected.tokenPath,
  };
}

/** Settings that must be valid for the server to start at all. */
export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env): Omit<McpConfig, 'agentToken' | 'ownerPubkey' | 'tokenSource'> {
  const apiUrl = loopbackOrigin('NEXUS_API_URL', env.NEXUS_API_URL?.trim() || 'http://127.0.0.1:8787');
  const dashboardUrl = loopbackOrigin(
    'NEXUS_DASHBOARD_URL',
    env.NEXUS_DASHBOARD_URL?.trim() || 'http://localhost:5173',
  );

  const rawTimeout = env.NEXUS_TIMEOUT_MS?.trim();
  // Below the 60 s tool timeout some clients (Codex) apply by default, so a slow transfer
  // still comes back as outcome_unknown with its key instead of a client-side cutoff.
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 45_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('NEXUS_TIMEOUT_MS must be an integer between 1000 and 300000');
  }

  return { apiUrl, dashboardUrl, timeoutMs };
}

export type ResolvedToken = Pick<McpConfig, 'agentToken' | 'ownerPubkey' | 'tokenSource'>;

/** The agent token from NEXUS_AGENT_TOKEN or the agent data directory; throws with the fix when unresolved. */
export function resolveAgentToken(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadMcpConfigOptions = {},
): ResolvedToken {
  const rawToken = env.NEXUS_AGENT_TOKEN?.trim();
  if (rawToken) {
    const tokenMatch = AGENT_TOKEN.exec(rawToken);
    if (!tokenMatch) {
      throw new Error(
        'NEXUS_AGENT_TOKEN is malformed; copy the MCP entry from the nexusPay dashboard (agent card > Connect an AI agent) or run pnpm mcp:config',
      );
    }
    return { agentToken: rawToken, ownerPubkey: tokenMatch[1]!, tokenSource: 'env' };
  }
  const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  return discoverTokenFromDisk(env, options.repoRoot ?? defaultRepoRoot);
}

export function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadMcpConfigOptions = {},
): McpConfig {
  return { ...loadBaseConfig(env), ...resolveAgentToken(env, options) };
}
