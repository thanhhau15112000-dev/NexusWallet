import { useEffect, useState } from 'react';
import { ShieldCheck } from './icons.js';
import type { AgentState } from '../api.js';
import { Card, Mono, shorten } from './ui.js';
import { useI18n } from '../i18n/context.js';

type Entry = { label: string; address: string };

export function PolicyPanel(props: {
  state: AgentState;
  wallet: string | null;
  busy: boolean;
  onSave: (input: {
    maxSolPerTx: number;
    maxSolPerDay?: number | null;
    allowedRecipients: Entry[];
    allowedMints: Entry[];
    maxTokenAmountByMint: Record<string, number>;
  }) => Promise<void>;
}) {
  const { dict } = useI18n();
  const { policy } = props.state;
  const [maxSol, setMaxSol] = useState(String(policy.maxSolPerTx));
  const [maxSolDay, setMaxSolDay] = useState(
    policy.maxSolPerDay !== undefined && policy.maxSolPerDay !== null
      ? String(policy.maxSolPerDay)
      : '',
  );
  const [recipients, setRecipients] = useState<Entry[]>(policy.allowedRecipients);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [dirty, setDirty] = useState(false);

  // Re-sync when the agent reports a newer policy and nothing local is pending.
  useEffect(() => {
    if (dirty) return;
    setMaxSol(String(policy.maxSolPerTx));
    setMaxSolDay(
      policy.maxSolPerDay !== undefined && policy.maxSolPerDay !== null
        ? String(policy.maxSolPerDay)
        : '',
    );
    setRecipients(policy.allowedRecipients);
  }, [policy.version, policy.maxSolPerTx, policy.maxSolPerDay, policy.allowedRecipients, dirty]);

  const addEntry = (entry: Entry) => {
    if (!entry.label || !entry.address) return;
    if (
      recipients.some(
        (r) => r.address === entry.address || r.label.toLowerCase() === entry.label.toLowerCase(),
      )
    ) {
      return;
    }
    setRecipients([...recipients, entry]);
    setDirty(true);
  };

  const save = async () => {
    const parsed = Number(maxSol);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const trimmedDay = maxSolDay.trim();
    let parsedDay: number | null = null;
    if (trimmedDay !== '') {
      const num = Number(trimmedDay);
      if (!Number.isFinite(num) || num < 0) return;
      parsedDay = num;
    }
    try {
      await props.onSave({
        maxSolPerTx: parsed,
        maxSolPerDay: parsedDay,
        allowedRecipients: recipients,
        allowedMints: policy.allowedMints,
        maxTokenAmountByMint: policy.maxTokenAmountByMint,
      });
      setDirty(false);
    } catch {
      // The parent has already surfaced the error. Keep the draft dirty so the
      // user does not lose an unsaved policy after a failed request.
    }
  };

  return (
    <Card
      title={dict.policy.title}
      titleIcon={<ShieldCheck size={16} />}
      className="panel-policy"
      actions={<span className="version">v{policy.version}</span>}
    >
      <label className="field">
        <span>{dict.policy.maxPerTx}</span>
        <div className="input-with-suffix">
          <input
            type="number"
            min="0"
            step="0.01"
            value={maxSol}
            onChange={(e) => {
              setMaxSol(e.target.value);
              setDirty(true);
            }}
          />
          <span>SOL</span>
        </div>
      </label>

      <label className="field">
        <span>{dict.policy.maxPerDay}</span>
        <div className="input-with-suffix">
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder={dict.policy.unlimitedPlaceholder}
            value={maxSolDay}
            onChange={(e) => {
              setMaxSolDay(e.target.value);
              setDirty(true);
            }}
          />
          <span>SOL</span>
        </div>
      </label>

      <div className="field">
        <div className="field-row">
          <span>{dict.policy.recipients}</span>
          <span className="count">{recipients.length}</span>
        </div>
        {recipients.length === 0 ? (
          <p className="empty">{dict.policy.noRecipients}</p>
        ) : (
          <ul className="entry-list">
            {recipients.map((entry) => (
              <li key={entry.address}>
                <div>
                  <strong>{entry.label}</strong>
                  <Mono title={entry.address}>{shorten(entry.address, 6)}</Mono>
                </div>
                <button
                  type="button"
                  className="link danger"
                  onClick={() => {
                    setRecipients(recipients.filter((r) => r.address !== entry.address));
                    setDirty(true);
                  }}
                >
                  {dict.policy.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="row">
        <input
          aria-label={dict.policy.namePlaceholder}
          placeholder={dict.policy.namePlaceholder}
          value={label}
          onChange={(e) => setLabel(e.target.value.trim())}
        />
        <input
          aria-label={dict.policy.addressPlaceholder}
          placeholder={dict.policy.addressPlaceholder}
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
        />
        <button
          type="button"
          onClick={() => {
            addEntry({ label, address });
            setLabel('');
            setAddress('');
          }}
        >
          {dict.policy.addRecipient}
        </button>
      </div>

      <div className="row">
        <button
          type="button"
          className="ghost"
          disabled={!props.wallet}
          onClick={() => props.wallet && addEntry({ label: 'my-wallet', address: props.wallet })}
        >
          {dict.policy.useOwnerWallet}
        </button>
        <button type="button" className="primary" disabled={props.busy || !dirty} onClick={save}>
          {props.busy ? dict.policy.saving : dict.policy.save}
        </button>
      </div>
      {dirty ? <p className="hint warn">{dict.policy.unsaved}</p> : null}
    </Card>
  );
}
