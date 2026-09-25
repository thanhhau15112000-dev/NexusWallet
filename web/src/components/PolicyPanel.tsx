import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { AgentState } from '../api.js';
import { Card, Mono, shorten } from './ui.js';

type Entry = { label: string; address: string };

export function PolicyPanel(props: {
  state: AgentState;
  wallet: string | null;
  busy: boolean;
  onSave: (input: {
    maxSolPerTx: number;
    allowedRecipients: Entry[];
    allowedMints: Entry[];
    maxTokenAmountByMint: Record<string, number>;
  }) => Promise<void>;
}) {
  const { policy } = props.state;
  const [maxSol, setMaxSol] = useState(String(policy.maxSolPerTx));
  const [recipients, setRecipients] = useState<Entry[]>(policy.allowedRecipients);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [dirty, setDirty] = useState(false);

  // Re-sync when the agent reports a newer policy and nothing local is pending.
  useEffect(() => {
    if (dirty) return;
    setMaxSol(String(policy.maxSolPerTx));
    setRecipients(policy.allowedRecipients);
  }, [policy.version, policy.maxSolPerTx, policy.allowedRecipients, dirty]);

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
    try {
      await props.onSave({
        maxSolPerTx: parsed,
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
      title="Policy"
      titleIcon={<ShieldCheck size={16} />}
      className="panel-policy"
      actions={<span className="version">v{policy.version}</span>}
    >
      <label className="field">
        <span>Max per transaction</span>
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

      <div className="field">
        <div className="field-row">
          <span>Recipients</span>
          <span className="count">{recipients.length}</span>
        </div>
        {recipients.length === 0 ? (
          <p className="empty">No recipients</p>
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
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="row">
        <input
          aria-label="Recipient name"
          placeholder="Name"
          value={label}
          onChange={(e) => setLabel(e.target.value.trim())}
        />
        <input
          aria-label="Recipient address"
          placeholder="Address"
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
          Add recipient
        </button>
      </div>

      <div className="row">
        <button
          type="button"
          className="ghost"
          disabled={!props.wallet}
          onClick={() => props.wallet && addEntry({ label: 'my-wallet', address: props.wallet })}
        >
          Use owner wallet
        </button>
        <button type="button" className="primary" disabled={props.busy || !dirty} onClick={save}>
          {props.busy ? 'Saving' : 'Save'}
        </button>
      </div>
      {dirty ? <p className="hint warn">Unsaved</p> : null}
    </Card>
  );
}
