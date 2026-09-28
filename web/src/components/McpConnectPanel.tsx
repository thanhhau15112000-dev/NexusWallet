import { useState } from 'react';
import { Check, Copy, Plug, ShieldCheck, X } from './icons.js';
import { api, ApiError, type McpClientConfig } from '../api.js';
import { useI18n } from '../i18n/context.js';
import type { TranslationDictionary } from '../i18n/types.js';

type ClientId = 'claude-code' | 'codex' | 'antigravity' | 'claude-desktop';

const CLIENTS: Array<{
  id: ClientId;
  name: string;
  snippet: (config: McpClientConfig) => string;
  hint: (mcp: TranslationDictionary['mcp']) => string;
}> = [
  { id: 'claude-code', name: 'Claude Code', snippet: (c) => c.claudeCode, hint: (m) => m.hintClaudeCode },
  { id: 'codex', name: 'Codex', snippet: (c) => c.codexToml, hint: (m) => m.hintCodex },
  { id: 'antigravity', name: 'Antigravity', snippet: (c) => c.antigravityJson, hint: (m) => m.hintAntigravity },
  { id: 'claude-desktop', name: 'Claude Desktop', snippet: (c) => c.claudeDesktopJson, hint: (m) => m.hintClaudeDesktop },
];

type CopyTarget = 'url' | ClientId;

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError || err instanceof Error ? err.message : fallback;

// The token stays off the screen (screenshots, screen sharing); Copy still puts the full value on the clipboard.
const maskToken = (text: string, token: string) =>
  text.replaceAll(token, `${token.slice(0, token.lastIndexOf('_') + 5)}${'•'.repeat(12)}`);

/**
 * The app's headline feature: connect an AI client to this wallet over the remote MCP
 * endpoint. The client only needs the URL and the owner's MCP token; nothing is installed.
 */
export function McpConnectPanel() {
  const { dict } = useI18n();
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [client, setClient] = useState<ClientId>('claude-code');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  const load = async (rotate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setConfig(rotate ? await api.rotateMcpToken() : await api.mcpConfig());
    } catch (err) {
      setError(errorText(err, dict.mcp.loadFailed));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (target: CopyTarget, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError(dict.mcp.clipboardUnavailable);
    }
  };

  const copyButton = (target: CopyTarget, text: string) => (
    <button type="button" className="mcp-copy-btn" onClick={() => void copy(target, text)}>
      {copied === target ? <Check size={14} /> : <Copy size={14} />}
      {copied === target ? dict.mcp.copied : dict.mcp.copy}
    </button>
  );

  const selected = CLIENTS.find((item) => item.id === client) ?? CLIENTS[0]!;
  const snippet = config ? selected.snippet(config) : '';
  const localOnly = config ? /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.url) : false;

  return (
    <section className="mcp-card" aria-labelledby="mcp-card-title">
      <div className="mcp-card-intro">
        <span className="mcp-eyebrow">
          <Plug size={14} />
          {dict.mcp.eyebrow}
        </span>
        <h2 id="mcp-card-title">{dict.mcp.title}</h2>
        <p className="mcp-pitch">{dict.mcp.pitch}</p>

        <ol className="mcp-steps">
          <li>
            <strong>{dict.mcp.step1Title}</strong>
            <p>{dict.mcp.step1Desc}</p>
            {config ? (
              <>
                <div className="mcp-command">
                  <code>{config.url}</code>
                  {copyButton('url', config.url)}
                </div>
                {localOnly ? <p className="mcp-warn">{dict.mcp.localOnlyNote}</p> : null}
                <div className="mcp-format-switch" role="group" aria-label={dict.mcp.step1Title}>
                  {CLIENTS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={client === item.id}
                      onClick={() => setClient(item.id)}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
                <p>{selected.hint(dict.mcp)}</p>
                <div className="mcp-code">
                  <pre>{maskToken(snippet, config.token)}</pre>
                  {copyButton(client, snippet)}
                </div>
              </>
            ) : (
              <button type="button" className="mcp-reveal-btn" disabled={busy} onClick={() => void load(false)}>
                {busy ? dict.mcp.loading : dict.mcp.reveal}
              </button>
            )}
            {error ? <p className="mcp-warn">{error}</p> : null}
          </li>
          <li>
            <strong>{dict.mcp.step2Title}</strong>
            <p>{dict.mcp.step2Desc}</p>
          </li>
          <li>
            <strong>{dict.mcp.step3Title}</strong>
            <p className="mcp-prompt">&ldquo;{dict.mcp.step3Prompt}&rdquo;</p>
          </li>
        </ol>
      </div>

      <div className="mcp-card-manual">
        <h3>{dict.mcp.scopeTitle}</h3>
        <ul className="mcp-scope">
          <li><Check size={15} />{dict.mcp.scopeStatus}</li>
          <li><Check size={15} />{dict.mcp.scopeRequests}</li>
          <li><Check size={15} />{dict.mcp.scopeTransfers}</li>
          <li className="is-denied"><X size={15} />{dict.mcp.scopeDenied}</li>
        </ul>

        <h3 className="mcp-manual-title">{dict.mcp.tokenTitle}</h3>
        <p className="mcp-note">
          <ShieldCheck size={15} />
          <span>{dict.mcp.securityNote}</span>
        </p>
        {config ? (
          <button type="button" className="link" disabled={busy} onClick={() => void load(true)}>
            {busy ? dict.mcp.rotating : dict.mcp.rotateToken}
          </button>
        ) : null}
      </div>
    </section>
  );
}
