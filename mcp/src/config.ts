/**
 * Settings come from the MCP client's `env` block. Phase 1 talks to a local
 * agent service only: the local API has no session, so the tenant is picked by
 * `x-owner-pubkey`. Hosted access needs a scoped agent token and is not wired yet.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type McpConfig = {
  apiUrl: string;
  ownerPubkey: string;
  dashboardUrl: string;
  timeoutMs: number;
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

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const apiUrl = loopbackOrigin('NEXUS_API_URL', env.NEXUS_API_URL?.trim() || 'http://127.0.0.1:8787');
  const dashboardUrl = loopbackOrigin(
    'NEXUS_DASHBOARD_URL',
    env.NEXUS_DASHBOARD_URL?.trim() || 'http://localhost:5173',
  );

  const ownerPubkey = env.NEXUS_OWNER_PUBKEY?.trim() ?? '';
  if (!BASE58_PUBKEY.test(ownerPubkey)) {
    throw new Error('NEXUS_OWNER_PUBKEY must be the owner wallet address bound in the dashboard');
  }

  const rawTimeout = env.NEXUS_TIMEOUT_MS?.trim();
  // Below the 60 s tool timeout some clients (Codex) apply by default, so a slow transfer
  // still comes back as outcome_unknown with its key instead of a client-side cutoff.
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 45_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('NEXUS_TIMEOUT_MS must be an integer between 1000 and 300000');
  }

  return { apiUrl, ownerPubkey, dashboardUrl, timeoutMs };
}
