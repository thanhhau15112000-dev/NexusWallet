import { useState } from 'react';
import { Command, Send } from './icons.js';
import type { PaymentRequest } from '@nexus/shared';
import type { AgentState } from '../api.js';
import { TONE, localizeError } from './RequestList.js';
import { Card, Pill } from './ui.js';
import { useI18n } from '../i18n/context.js';

/** A valid devnet address that is deliberately never allowlisted, for the deny demo. */
export const OFF_ALLOWLIST_ADDRESS = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

export function ConsolePanel(props: {
  state: AgentState;
  busy: boolean;
  /** Commands act on behalf of the owner, so they need the owner wallet connected. */
  connected: boolean;
  requests: PaymentRequest[];
  /** Resolves to the created request id, or null when the command failed. */
  onRun: (prompt: string) => Promise<string | null>;
  onOpenPolicy?: () => void;
}) {
  const { dict, interpolate } = useI18n();
  const [prompt, setPrompt] = useState('');
  const [lastId, setLastId] = useState<string | null>(null);
  // Read the request live so the result follows approval, not the snapshot taken at send time.
  const last = lastId ? props.requests.find((request) => request.id === lastId) : undefined;
  const limit = props.state.policy.maxSolPerTx;
  const label = props.state.policy.allowedRecipients[0]?.label;

  const under = Number((limit / 2).toFixed(6)) || 0.01;
  const over = Number((limit * 5).toFixed(6)) || 0.5;

  const presets = label
    ? [
        {
          text: `Send ${under} SOL to ${label}`,
          hint: dict.console.autoHint,
          tone: 'ok' as const,
        },
        {
          text: `Send ${over} SOL to ${label}`,
          hint: dict.console.approvalHint,
          tone: 'warn' as const,
        },
        {
          text: `Send ${under} SOL to ${OFF_ALLOWLIST_ADDRESS}`,
          hint: dict.console.deniedHint,
          tone: 'bad' as const,
        },
      ]
    : [];

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value || !props.connected) return;
    const id = await props.onRun(value);
    // Keep the text after a failure so a manual retry sends the same command.
    if (id) {
      setLastId(id);
      setPrompt('');
    }
  };

  return (
    <Card title={dict.console.title} titleIcon={<Command size={16} />} className="panel-command">
      <p className="card-desc">{dict.console.desc}</p>
      {!props.connected ? <p className="hint-warn" role="status">{dict.console.connectToUse}</p> : null}
      <form
        className="stack-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(prompt);
        }}
      >
        <textarea
          className="console-input"
          aria-label={dict.console.title}
          placeholder={
            label
              ? interpolate(dict.console.placeholderExample, { amount: under, label })
              : dict.console.placeholderDefault
          }
          value={prompt}
          disabled={!props.connected}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line; Enter that confirms an IME composition (e.g. Telex) is not a send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!props.busy) void submit(prompt);
            }
          }}
        />
        <div className="console-actions">
          <span className="hint">{dict.console.sendHint}</span>
          <button
            type="submit"
            className="primary button-with-icon"
            disabled={props.busy || !props.connected || !prompt.trim()}
          >
            {props.busy ? dict.console.running : dict.console.run}
            <Send size={15} aria-hidden="true" />
          </button>
        </div>
      </form>

      {last ? (
        <div className="console-last" role="status">
          <div className="console-last-head">
            <span className="section-label">{dict.console.lastTitle}</span>
            <Pill tone={TONE[last.status]}>{dict.requests.statuses[last.status]}</Pill>
          </div>
          <span className="console-last-prompt">{last.prompt}</span>
          {last.error ? (
            <span className="bad-text">{localizeError(last.error, dict.requests.errors, interpolate)}</span>
          ) : null}
        </div>
      ) : null}

      {presets.length > 0 ? (
        <div className="presets">
          <span className="section-label">{dict.console.presetsTitle}</span>
          {presets.map((preset) => (
            <button
              key={preset.text}
              type="button"
              className="preset"
              disabled={props.busy || !props.connected}
              onClick={() => void submit(preset.text)}
            >
              <span>{preset.text}</span>
              <Pill tone={preset.tone}>{preset.hint}</Pill>
            </button>
          ))}
        </div>
      ) : (
        <div className="stack-form">
          <p className="empty">{dict.console.noPresets}</p>
          {props.onOpenPolicy ? (
            <button type="button" className="link" onClick={props.onOpenPolicy}>
              {dict.console.openPolicy}
            </button>
          ) : null}
        </div>
      )}
      <p className="hint">{dict.console.mcpNote}</p>
    </Card>
  );
}
