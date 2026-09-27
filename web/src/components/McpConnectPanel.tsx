import { useState } from 'react';
import { Plug } from './icons.js';
import { api, ApiError, type McpClientConfig } from '../api.js';

// The panel sits inside the dark agent card, so text inherits its light color and code
// blocks get a translucent dark background instead of the global light pre style.
const panelStyle = { marginTop: 12, fontSize: 13 } as const;
const textStyle = { color: 'inherit', opacity: 0.85, margin: '8px 0 4px' } as const;
const warnStyle = { ...textStyle, opacity: 1, fontWeight: 600 } as const;
const preStyle = {
  background: 'rgba(0, 0, 0, 0.35)',
  color: 'inherit',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: 6,
  padding: 8,
  margin: '4px 0',
  maxHeight: 160,
  overflow: 'auto',
  fontSize: 11,
  whiteSpace: 'pre',
} as const;
const buttonStyle = { color: 'inherit', textDecoration: 'underline', marginRight: 12 } as const;

/**
 * Hands the owner a ready-to-paste MCP client entry (bundle path + tenant token), so an
 * AI agent can be connected without editing headers or config values by hand.
 */
export function McpConnectPanel() {
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async (rotate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(rotate ? await api.rotateMcpToken() : await api.mcpConfig());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to load MCP config');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError('Clipboard is not available; select the text and copy it manually');
    }
  };

  return (
    <details className="mcp-connect" style={panelStyle} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !config) void load(false); }}>
      <summary style={{ cursor: 'pointer' }}>
        <Plug size={14} /> Connect an AI agent (MCP)
      </summary>
      {error ? <p style={warnStyle}>{error}</p> : null}
      {config ? (
        <div className="mcp-connect-body">
          {!config.bundleBuilt ? (
            <p style={warnStyle}>
              MCP bundle not built yet. Run <code>{config.buildCommand}</code> in the repository, then paste the entry below.
            </p>
          ) : null}
          <p style={textStyle}>
            Claude Desktop, Claude Code (<code>.mcp.json</code>), Cursor and Antigravity (<code>~/.gemini/config/mcp_config.json</code>):
          </p>
          <pre style={preStyle}>{config.mcpServersJson}</pre>
          <button type="button" className="link" style={buttonStyle} onClick={() => void copy('json', config.mcpServersJson)}>
            {copied === 'json' ? 'Copied' : 'Copy JSON'}
          </button>
          <p style={textStyle}>Codex (<code>~/.codex/config.toml</code>):</p>
          <pre style={preStyle}>{config.codexToml}</pre>
          <button type="button" className="link" style={buttonStyle} onClick={() => void copy('toml', config.codexToml)}>
            {copied === 'toml' ? 'Copied' : 'Copy TOML'}
          </button>
          <p style={textStyle}>
            The token only lets the agent read status and requests and propose transfers; the policy and your approvals still decide.
            Rotating it disconnects clients that use the old one.
          </p>
          <button type="button" className="link" style={buttonStyle} disabled={busy} onClick={() => void load(true)}>
            {busy ? 'Rotating…' : 'Rotate token'}
          </button>
        </div>
      ) : busy ? <p style={textStyle}>Loading…</p> : null}
    </details>
  );
}
