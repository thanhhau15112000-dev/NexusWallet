import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error install.mjs is plain JavaScript without type declarations
import { getClientConfigPath, installClient, mergeJsonConfig, mergeTomlConfig, runCli } from '../scripts/install.mjs';

describe('mcp install script', () => {
  const dummyBundle = 'G:/test-repo/dist/mcp/nexuspay-mcp.mjs';

  describe('mergeJsonConfig', () => {
    it('creates fresh config when input is empty or blank', () => {
      const result = mergeJsonConfig('', dummyBundle);
      expect(JSON.parse(result)).toEqual({
        mcpServers: {
          nexuspay: {
            command: 'node',
            args: [dummyBundle],
          },
        },
      });
    });

    it('preserves existing servers and their secrets verbatim', () => {
      const existing = {
        mcpServers: {
          jira: {
            command: 'npx',
            args: ['-y', 'jira-mcp'],
            env: {
              JIRA_API_TOKEN: 'secret-token-xyz-12345',
              JIRA_HOST: 'https://example.atlassian.net',
            },
          },
        },
      };

      const merged = JSON.parse(mergeJsonConfig(JSON.stringify(existing, null, 2), dummyBundle));
      expect(merged.mcpServers.jira).toEqual(existing.mcpServers.jira);
      expect(merged.mcpServers.nexuspay).toEqual({
        command: 'node',
        args: [dummyBundle],
      });
    });
  });

  describe('mergeTomlConfig', () => {
    it('creates fresh toml when input is empty', () => {
      const result = mergeTomlConfig('', dummyBundle);
      expect(result).toContain('[mcp_servers.nexuspay]');
      expect(result).toContain(`args = ["${dummyBundle}"]`);
      expect(result).toContain('tool_timeout_sec = 90');
    });

    it('preserves other tables and replaces existing nexuspay table in place', () => {
      const initial = `
[settings]
theme = "dark"

[mcp_servers.nexuspay]
command = "node"
args = ["/old/path/nexuspay.mjs"]
env = { OLD = "val" }

[mcp_servers.other]
command = "other-tool"
args = ["--flag"]
`;

      const merged = mergeTomlConfig(initial, dummyBundle);
      expect(merged).toContain('[settings]\ntheme = "dark"');
      expect(merged).toContain('[mcp_servers.other]\ncommand = "other-tool"');
      expect(merged).toContain(`args = ["${dummyBundle}"]`);
      expect(merged).toContain('tool_timeout_sec = 90');
      expect(merged).not.toContain('/old/path/nexuspay.mjs');
      expect(merged).not.toContain('OLD = "val"');
    });
  });

  describe('installClient file operations', () => {
    it('creates directories and files under custom home without touching real paths', () => {
      const tempHome = mkdtempSync(resolve(tmpdir(), 'nexus-install-test-'));
      const testEnv = {
        NEXUS_MCP_INSTALL_HOME: tempHome,
        APPDATA: resolve(tempHome, 'AppData/Roaming'),
      };

      try {
        // Test claude-desktop
        const rClaude = installClient('claude-desktop', { env: testEnv, bundle: dummyBundle });
        expect(existsSync(rClaude.path)).toBe(true);
        expect(rClaude.action).toBe('created');
        const claudeJson = JSON.parse(readFileSync(rClaude.path, 'utf8'));
        expect(claudeJson.mcpServers.nexuspay.args[0]).toBe(dummyBundle);

        // Test antigravity
        const rAnti = installClient('antigravity', { env: testEnv, bundle: dummyBundle });
        expect(existsSync(rAnti.path)).toBe(true);
        expect(rAnti.action).toBe('created');

        // Test codex
        const rCodex = installClient('codex', { env: testEnv, bundle: dummyBundle });
        expect(existsSync(rCodex.path)).toBe(true);
        expect(rCodex.action).toBe('created');
        const codexToml = readFileSync(rCodex.path, 'utf8');
        expect(codexToml).toContain('[mcp_servers.nexuspay]');

        // Second run -> idempotent (unchanged)
        const rClaudeSecond = installClient('claude-desktop', { env: testEnv, bundle: dummyBundle });
        expect(rClaudeSecond.action).toBe('unchanged');

        // Modify file and run again -> creates .bak
        writeFileSync(rClaude.path, JSON.stringify({ mcpServers: { old: {} } }));
        const rClaudeUpdated = installClient('claude-desktop', { env: testEnv, bundle: dummyBundle });
        expect(rClaudeUpdated.action).toBe('updated');
        expect(existsSync(`${rClaude.path}.bak`)).toBe(true);
        const bakContent = readFileSync(`${rClaude.path}.bak`, 'utf8');
        expect(bakContent).toContain('old');
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it('supports dry-run without writing any files or creating directories', () => {
      const tempHome = resolve(tmpdir(), 'nexus-install-dryrun-' + Date.now());
      const testEnv = {
        NEXUS_MCP_INSTALL_HOME: tempHome,
        APPDATA: resolve(tempHome, 'AppData/Roaming'),
      };

      const result = installClient('claude-desktop', { dryRun: true, env: testEnv, bundle: dummyBundle });
      expect(result.action).toBe('dry-run');
      expect(existsSync(tempHome)).toBe(false);
    });

    it('never overwrites an existing backup file', () => {
      const tempHome = mkdtempSync(resolve(tmpdir(), 'nexus-install-backup-'));
      const testEnv = { NEXUS_MCP_INSTALL_HOME: tempHome, APPDATA: resolve(tempHome, 'AppData/Roaming') };
      try {
        const configPath = getClientConfigPath('codex', testEnv);
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, 'model = "a"');
        writeFileSync(`${configPath}.bak`, 'users own backup');

        installClient('codex', { env: testEnv, bundle: dummyBundle });
        writeFileSync(configPath, 'model = "b"');
        installClient('codex', { env: testEnv, bundle: dummyBundle });

        expect(readFileSync(`${configPath}.bak`, 'utf8')).toBe('users own backup');
        const backups = readdirSync(dirname(configPath)).filter((name) => name.startsWith('config.toml.bak-'));
        expect(backups).toHaveLength(2);
        const contents = backups.map((name) => readFileSync(resolve(dirname(configPath), name), 'utf8'));
        expect(contents).toContain('model = "a"');
        expect(contents).toContain('model = "b"');
      } finally {
        rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it('dry-run prints only the nexuspay entry, never other servers or their secrets', () => {
      const tempHome = mkdtempSync(resolve(tmpdir(), 'nexus-install-secret-'));
      const testEnv = { NEXUS_MCP_INSTALL_HOME: tempHome, APPDATA: resolve(tempHome, 'AppData/Roaming') };
      const configPath = getClientConfigPath('antigravity', testEnv);
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ mcpServers: { jira: { env: { JIRA_API_KEY: 'secret-jira-key' } } } }));
      const printed: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => { printed.push(args.join(' ')); });
      try {
        installClient('antigravity', { dryRun: true, env: testEnv, bundle: dummyBundle });
      } finally {
        spy.mockRestore();
        rmSync(tempHome, { recursive: true, force: true });
      }
      const output = printed.join('\n');
      expect(output).toContain('nexuspay');
      expect(output).not.toContain('secret-jira-key');
      expect(output).not.toContain('jira');
    });

    it('runCli executes all clients in dry-run mode safely', () => {
      const tempHome = resolve(tmpdir(), 'nexus-install-cli-' + Date.now());
      const testEnv = {
        NEXUS_MCP_INSTALL_HOME: tempHome,
        APPDATA: resolve(tempHome, 'AppData/Roaming'),
      };

      const results = runCli(['--dry-run', '--client=all'], testEnv);
      expect(results.length).toBe(3);
      for (const res of results) {
        expect(res.action).toBe('dry-run');
      }
      expect(existsSync(tempHome)).toBe(false);
    });
  });
});
