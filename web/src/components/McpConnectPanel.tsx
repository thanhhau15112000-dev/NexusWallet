import { useState } from 'react';
import { Check, Copy, Plug, ShieldCheck, TriangleAlert } from './icons.js';
import { api, type McpClientConfig, type McpTokenStatus } from '../api.js';
import { Card, Notice } from './ui.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.js';
import { useI18n } from '../i18n/context.js';
import type { TranslationDictionary } from '../i18n/types.js';
import { errorText } from '../lib/errors.js';

type ClientId = 'claude-code' | 'codex' | 'antigravity';

const CLIENTS: Array<{
  id: ClientId;
  name: string;
  snippet: (config: McpClientConfig) => string;
  hint: (mcp: TranslationDictionary['mcp']) => string;
}> = [
  { id: 'claude-code', name: 'Claude Code', snippet: (c) => c.claudeCode, hint: (m) => m.hintClaudeCode },
  { id: 'codex', name: 'Codex', snippet: (c) => c.codexToml, hint: (m) => m.hintCodex },
  { id: 'antigravity', name: 'Antigravity', snippet: (c) => c.antigravityJson, hint: (m) => m.hintAntigravity },
];

type CopyTarget = 'url' | ClientId;

// The token stays masked on screen; Copy puts the full value on the clipboard.
const maskToken = (text: string, token: string) =>
  text.replaceAll(token, `${token.slice(0, token.lastIndexOf('_') + 5)}${'•'.repeat(12)}`);

/**
 * Connect an external AI client to this wallet over the remote MCP endpoint.
 */
export function McpConnectPanel() {
  const { dict } = useI18n();
  const [config, setConfig] = useState<McpClientConfig | null>(null);
  const [status, setStatus] = useState<McpTokenStatus | null>(null);
  const [client, setClient] = useState<ClientId>('claude-code');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  const load = async (issue: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = issue ? await api.rotateMcpToken() : await api.mcpConfig();
      if (next.token === null) {
        setStatus(next);
      } else {
        setConfig(next);
        setStatus(null);
        setConfirmRotate(false);
      }
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
    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void copy(target, text)}>
      {copied === target ? <Check size={12} className="text-accent" /> : <Copy size={12} />}
      {copied === target ? dict.mcp.copied : dict.mcp.copy}
    </Button>
  );

  const connection = config ?? status;
  const localOnly = connection ? /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(connection.url) : false;

  return (
    <div id="mcp-card">
      <Card
        title={dict.mcp.title}
        titleIcon={<Plug size={15} />}
        actions={<Badge variant="neutral" className="text-[10px]">MCP</Badge>}
      >
        <div className="space-y-3">
          {connection ? (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-muted/70 px-3 py-2">
                <code className="truncate font-mono text-xs text-ink">{connection.url}</code>
                {copyButton('url', connection.url)}
              </div>
              {localOnly ? (
                <p className="text-xs text-warn">{dict.mcp.localOnlyNote}</p>
              ) : null}
            </div>
          ) : null}

          {config ? (
            <div className="space-y-3">
              <Tabs value={client} onValueChange={(v) => setClient(v as ClientId)}>
                <TabsList>
                  {CLIENTS.map((item) => (
                    <TabsTrigger key={item.id} value={item.id}>
                      {item.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {CLIENTS.map((item) => {
                  const snippet = item.snippet(config);
                  return (
                    <TabsContent key={item.id} value={item.id} className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted">
                        <span>{item.hint(dict.mcp)}</span>
                        {copyButton(item.id, snippet)}
                      </div>
                      <pre className="overflow-x-auto rounded-md border border-line bg-surface-muted p-3 font-mono text-xs text-ink">
                        {maskToken(snippet, config.token)}
                      </pre>
                      {!localOnly ? <p className="text-xs text-warn">{dict.mcp.tokenOnceWarning}</p> : null}
                    </TabsContent>
                  );
                })}
              </Tabs>
              {confirmRotate ? (
                <div className="space-y-2 rounded-md border border-line bg-surface-muted/40 p-3 text-xs">
                  <p className="text-warn">{dict.mcp.rotateWarning}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="destructiveOutline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void load(true)}
                    >
                      {busy ? dict.mcp.rotating : dict.mcp.replaceToken}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmRotate(false)}
                    >
                      {dict.mcp.cancelRotate}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmRotate(true)}
                  >
                    {dict.mcp.replaceToken}
                  </Button>
                </div>
              )}
            </div>
          ) : status ? (
            <div className="space-y-2 rounded-md border border-line bg-surface-muted/40 p-3 text-xs">
              <p className="text-ink">{status.hasToken ? dict.mcp.tokenHidden : dict.mcp.noToken}</p>
              <p className="text-warn">{dict.mcp.tokenOnceWarning}</p>
              {status.hasToken ? <p className="text-warn">{dict.mcp.rotateWarning}</p> : null}
              <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => void load(true)}>
                {busy ? dict.mcp.rotating : status.hasToken ? dict.mcp.replaceToken : dict.mcp.createToken}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => void load(false)}>
              {busy ? dict.mcp.loading : dict.mcp.reveal}
            </Button>
          )}

          {error ? <p className="text-xs text-bad">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[11px] text-muted">
            <span className="inline-flex items-center gap-1 font-semibold text-ink">
              <ShieldCheck size={13} className="text-accent" aria-hidden="true" />
              {dict.mcp.scopeTitle}:
            </span>
            <span className="inline-flex items-center gap-1"><Check size={12} className="text-accent" />{dict.mcp.scopeStatus}</span>
            <span className="inline-flex items-center gap-1"><Check size={12} className="text-accent" />{dict.mcp.scopeRequests}</span>
            <span className="inline-flex items-center gap-1"><Check size={12} className="text-accent" />{dict.mcp.scopeTransfers}</span>
          </div>
          <Notice tone="warn" className="flex items-start gap-1.5 text-[11px]">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            {dict.mcp.ownerOnlyNote}
          </Notice>
        </div>
      </Card>
    </div>
  );
}
