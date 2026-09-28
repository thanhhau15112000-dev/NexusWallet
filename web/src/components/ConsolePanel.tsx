import { useState } from 'react';
import { Command, Send } from './icons.js';
import type { AgentState } from '../api.js';
import { Card, Pill } from './ui.js';
import { useI18n } from '../i18n/context.js';

/** A valid devnet address that is deliberately never allowlisted, for the deny demo. */
export const OFF_ALLOWLIST_ADDRESS = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

export function ConsolePanel(props: {
  state: AgentState;
  busy: boolean;
  onRun: (prompt: string) => Promise<void>;
}) {
  const { dict, interpolate } = useI18n();
  const [prompt, setPrompt] = useState('');
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
    if (!value) return;
    await props.onRun(value);
    setPrompt('');
  };

  return (
    <Card title={dict.console.title} titleIcon={<Command size={16} />} className="panel-command">
      <p className="card-desc">{dict.console.desc}</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(prompt);
        }}
      >
        <input
          className="grow"
          aria-label={dict.console.title}
          placeholder={
            label
              ? interpolate(dict.console.placeholderExample, { amount: under, label })
              : dict.console.placeholderDefault
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          type="submit"
          className="primary button-with-icon"
          disabled={props.busy || !prompt.trim()}
        >
          {props.busy ? dict.console.running : dict.console.run}
          <Send size={15} aria-hidden="true" />
        </button>
      </form>

      {presets.length > 0 ? (
        <div className="presets">
          <span className="section-label">{dict.console.presetsTitle}</span>
          {presets.map((preset) => (
            <button
              key={preset.text}
              type="button"
              className="preset"
              disabled={props.busy}
              onClick={() => void submit(preset.text)}
            >
              <span>{preset.text}</span>
              <Pill tone={preset.tone}>{preset.hint}</Pill>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty">{dict.console.noPresets}</p>
      )}
    </Card>
  );
}
