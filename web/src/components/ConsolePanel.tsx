import { useState } from 'react';
import { Command, Send } from './icons.js';
import type { PaymentRequest } from '@nexus/shared';
import type { AgentState } from '../api.js';
import { TONE, localizeError } from './RequestList.js';
import { Card, Pill } from './ui.js';
import { Button } from './ui/button.js';
import { Textarea } from './ui/textarea.js';
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
  const last = lastId ? props.requests.find((request) => request.id === lastId) : undefined;
  const limit = props.state.policy.maxSolPerTx;
  const label = props.state.policy.allowedRecipients[0]?.label;

  const under = Number((limit / 2).toFixed(6)) || 0.01;
  const over = Number((limit * 5).toFixed(6)) || 0.5;

  const presets = label
    ? [
        {
          text: interpolate(dict.console.presetCommand, { amount: under, recipient: label }),
          hint: dict.console.autoHint,
          tone: 'ok' as const,
        },
        {
          text: interpolate(dict.console.presetCommand, { amount: over, recipient: label }),
          hint: dict.console.approvalHint,
          tone: 'warn' as const,
        },
        {
          text: interpolate(dict.console.presetCommand, { amount: under, recipient: OFF_ALLOWLIST_ADDRESS }),
          hint: dict.console.deniedHint,
          tone: 'bad' as const,
        },
      ]
    : [];

  const submit = async (text: string) => {
    const value = text.trim();
    if (!value || !props.connected) return;
    const id = await props.onRun(value);
    if (id) {
      setLastId(id);
      setPrompt('');
    }
  };

  return (
    <Card title={dict.console.title} titleIcon={<Command size={15} />}>
      {!props.connected ? (
        <p className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
          {dict.console.connectToUse}
        </p>
      ) : null}

      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(prompt);
        }}
      >
        <Textarea
          className="min-h-[76px] resize-y font-mono text-[13px]"
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!props.busy) void submit(prompt);
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-muted">{dict.console.sendHint}</span>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={props.busy || !props.connected || !prompt.trim()}
          >
            {props.busy ? dict.console.running : dict.console.run}
            <Send size={13} aria-hidden="true" />
          </Button>
        </div>
      </form>

      {last ? (
        <div className="space-y-1.5 rounded-md border border-line bg-surface-muted/60 p-3 text-xs" role="status">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{dict.console.lastTitle}</span>
            <Pill tone={TONE[last.status]}>{dict.requests.statuses[last.status]}</Pill>
          </div>
          <p className="font-mono text-ink">{last.prompt}</p>
          {last.error ? (
            <p className="text-bad">{localizeError(last.error, dict.requests.errors, interpolate)}</p>
          ) : null}
        </div>
      ) : null}

      {presets.length > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-3">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted">
            {dict.console.presetsTitle}
          </span>
          <div className="flex flex-col gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.text}
                type="button"
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border border-line bg-panel px-3 py-2 text-left font-mono text-xs text-ink transition-colors hover:border-line-strong hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-50"
                disabled={props.busy || !props.connected}
                onClick={() => void submit(preset.text)}
              >
                <span className="truncate">{preset.text}</span>
                <Pill tone={preset.tone}>{preset.hint}</Pill>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-muted">
          <span>{dict.console.noPresets}</span>
          {props.onOpenPolicy ? (
            <Button type="button" variant="link" size="sm" className="text-xs" onClick={props.onOpenPolicy}>
              {dict.console.openPolicy}
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
