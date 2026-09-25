import { useState } from 'react';
import { Send } from 'lucide-react';
import type { AgentState } from '../api.js';
import { Card, Pill } from './ui.js';

/** A valid devnet address that is deliberately never allowlisted, for the deny demo. */
export const OFF_ALLOWLIST_ADDRESS = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

export function ConsolePanel(props: {
  state: AgentState;
  busy: boolean;
  onRun: (prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState('');
  const limit = props.state.policy.maxSolPerTx;
  const label = props.state.policy.allowedRecipients[0]?.label;

  const under = Number((limit / 2).toFixed(6)) || 0.01;
  const over = Number((limit * 5).toFixed(6)) || 0.5;

  const presets = label
    ? [
        { text: `Send ${under} SOL to ${label}`, hint: 'Auto', tone: 'ok' },
        { text: `Send ${over} SOL to ${label}`, hint: 'Approval', tone: 'warn' },
        {
          text: `Send ${under} SOL to ${OFF_ALLOWLIST_ADDRESS}`,
          hint: 'Denied',
          tone: 'bad',
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
    <Card title="Command" className="panel-command">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(prompt);
        }}
      >
        <input
          className="grow"
          aria-label="Command"
          placeholder={
            label ? `Send ${under} SOL to ${label}` : 'Add a recipient first'
          }
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          type="submit"
          className="primary button-with-icon"
          disabled={props.busy || !prompt.trim()}
        >
          {props.busy ? 'Running' : 'Run'}
          <Send size={15} aria-hidden="true" />
        </button>
      </form>

      {presets.length > 0 ? (
        <div className="presets">
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
        <p className="empty">Add a recipient to use presets</p>
      )}
    </Card>
  );
}
