import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(packageRoot, '..');
export const bundlePath = resolve(repoRoot, 'dist/mcp/nexuspay-mcp.mjs').replaceAll('\\', '/');

const SUPPORTED_CLIENTS = ['claude-desktop', 'antigravity', 'codex'];

export function getClientConfigPath(client, env = process.env) {
  const home = env.NEXUS_MCP_INSTALL_HOME || os.homedir();
  const platform = env.NEXUS_MCP_INSTALL_PLATFORM || process.platform;

  switch (client) {
    case 'claude-desktop':
      if (platform === 'win32') {
        const appdata = env.APPDATA || resolve(home, 'AppData/Roaming');
        return resolve(appdata, 'Claude/claude_desktop_config.json');
      }
      if (platform === 'darwin') {
        return resolve(home, 'Library/Application Support/Claude/claude_desktop_config.json');
      }
      return resolve(home, '.config/Claude/claude_desktop_config.json');
    case 'antigravity':
      return resolve(home, '.gemini/config/mcp_config.json');
    case 'codex':
      return resolve(home, '.codex/config.toml');
    default:
      throw new Error(`Unknown client: ${client}. Supported clients: ${SUPPORTED_CLIENTS.join(', ')}`);
  }
}

export function mergeJsonConfig(existingText, bundle) {
  let data = {};
  if (existingText && existingText.trim()) {
    try {
      data = JSON.parse(existingText);
    } catch (err) {
      throw new Error(`Existing JSON config is malformed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    data = {};
  }
  if (!data.mcpServers || typeof data.mcpServers !== 'object' || Array.isArray(data.mcpServers)) {
    data.mcpServers = {};
  }
  data.mcpServers.nexuspay = {
    command: 'node',
    args: [bundle],
  };
  return JSON.stringify(data, null, 2) + '\n';
}

export function mergeTomlConfig(existingText, bundle) {
  const newBlock = `[mcp_servers.nexuspay]\ncommand = "node"\nargs = [${JSON.stringify(bundle)}]\ntool_timeout_sec = 90\n`;
  if (!existingText || !existingText.trim()) {
    return newBlock;
  }

  const match = /^\[mcp_servers\.nexuspay\][^\r\n]*/m.exec(existingText);
  if (match) {
    const start = match.index;
    const afterHeader = existingText.slice(start + match[0].length);
    const nextTableMatch = /\r?\n(\[[^\]]+\])/.exec(afterHeader);
    let end;
    if (nextTableMatch) {
      end = start + match[0].length + nextTableMatch.index + 1;
    } else {
      end = existingText.length;
    }
    let merged = existingText.slice(0, start) + newBlock;
    const remaining = existingText.slice(end);
    if (remaining.trim()) {
      if (!merged.endsWith('\n\n')) merged += '\n';
      merged += remaining.replace(/^\r?\n+/, '');
    }
    return merged;
  }

  let merged = existingText.trimEnd();
  if (merged.length > 0) merged += '\n\n';
  merged += newBlock;
  return merged;
}

export function installClient(client, options = {}) {
  const { dryRun = false, env = process.env, bundle = bundlePath } = options;
  const configPath = getClientConfigPath(client, env);
  const isToml = client === 'codex';

  let existingText = '';
  const exists = existsSync(configPath);
  if (exists) {
    existingText = readFileSync(configPath, 'utf8');
  }

  const merged = isToml
    ? mergeTomlConfig(existingText, bundle)
    : mergeJsonConfig(existingText, bundle);

  if (dryRun) {
    // Print only the nexuspay entry: the rest of a client config can hold other servers' secrets.
    const entry = isToml
      ? mergeTomlConfig('', bundle).trimEnd()
      : JSON.stringify({ mcpServers: { nexuspay: { command: 'node', args: [bundle] } } }, null, 2);
    console.log(`[DRY-RUN] ${client}: would ${exists ? 'update' : 'create'} ${configPath} with:\n${entry}`);
    return { client, path: configPath, action: 'dry-run', content: merged };
  }

  if (exists && existingText === merged) {
    console.log(`[OK] ${client}: ${configPath} already up to date`);
    return { client, path: configPath, action: 'unchanged', content: merged };
  }

  mkdirSync(dirname(configPath), { recursive: true });

  if (exists) {
    const backupPath = `${configPath}.bak`;
    copyFileSync(configPath, backupPath);
  }

  writeFileSync(configPath, merged, 'utf8');
  console.log(`[OK] ${client}: wrote configuration to ${configPath}${exists ? ' (backup created)' : ''}`);
  return { client, path: configPath, action: exists ? 'updated' : 'created', content: merged };
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  let targetClients = ['all'];
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--client' && i + 1 < argv.length) {
      targetClients = [argv[++i]];
    } else if (arg?.startsWith('--client=')) {
      targetClients = [arg.slice('--client='.length)];
    }
  }

  const clientsToRun = targetClients.includes('all')
    ? SUPPORTED_CLIENTS
    : targetClients;

  for (const client of clientsToRun) {
    if (!SUPPORTED_CLIENTS.includes(client)) {
      console.error(`Unknown client: ${client}. Supported: ${SUPPORTED_CLIENTS.join(', ')}, all`);
      process.exit(1);
    }
  }

  if (!existsSync(bundlePath)) {
    console.warn(`[WARN] bundle not found at ${bundlePath}; remember to run pnpm mcp:build`);
  }

  const results = [];
  for (const client of clientsToRun) {
    results.push(installClient(client, { dryRun, env, bundle: bundlePath }));
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli();
}
