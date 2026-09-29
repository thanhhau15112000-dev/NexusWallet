import { useEffect, useState } from 'react';
import { AllowlistEntrySchema, PubkeySchema } from '@nexus/shared';
import { ShieldCheck, Wallet } from './icons.js';
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

  const parsedMaxSol = Number(maxSol);
  const maxSolInvalid =
    maxSol.trim() === '' || !Number.isFinite(parsedMaxSol) || parsedMaxSol <= 0 || parsedMaxSol > 1000;
  const trimmedDay = maxSolDay.trim();
  const parsedDay = trimmedDay === '' ? null : Number(trimmedDay);
  const maxSolDayInvalid =
    parsedDay !== null && (!Number.isFinite(parsedDay) || parsedDay < 0 || parsedDay > 100000);
  const labelInvalid = label.length > 32;
  const addressInvalid = address !== '' && !PubkeySchema.safeParse(address).success;
  const duplicateEntry = Boolean(
    address && recipients.some((entry) => entry.address === address),
  );
  const duplicateLabel = Boolean(
    label && recipients.some((entry) => entry.label.toLowerCase() === label.toLowerCase()),
  );
  const existingRecipientInvalid = recipients.some(
    (entry) => !AllowlistEntrySchema.safeParse(entry).success,
  );

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
    if (!AllowlistEntrySchema.safeParse(entry).success) return;
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
    if (maxSolInvalid || maxSolDayInvalid || existingRecipientInvalid) return;
    try {
      await props.onSave({
        maxSolPerTx: parsedMaxSol,
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
    <div className="page-stack">
      <div className="split-grid policy-grid">
        <Card
          title={dict.overview.spendingLimits}
          titleIcon={<ShieldCheck size={16} />}
          actions={<span className="version">v{policy.version}</span>}
        >
          <label className="field">
            <span>{dict.policy.maxPerTx}</span>
            <div className="input-with-suffix">
              <input
                type="number"
                min="0.000000001"
                max="1000"
                step="any"
                value={maxSol}
                onChange={(e) => {
                  setMaxSol(e.target.value);
                  setDirty(true);
                }}
              />
              <span>SOL</span>
            </div>
            {maxSolInvalid ? <span className="request-error">{dict.policy.invalidPerTx}</span> : null}
          </label>

          <label className="field">
            <span>{dict.policy.maxPerDay}</span>
            <div className="input-with-suffix">
              <input
                type="number"
                min="0"
                max="100000"
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
            {maxSolDayInvalid ? <span className="request-error">{dict.policy.invalidPerDay}</span> : null}
          </label>
        </Card>

        <Card
          title={dict.policy.recipients}
          titleIcon={<Wallet size={16} />}
          actions={<span className="count-badge">{recipients.length}</span>}
        >
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

          <div className="recipient-form">
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
              disabled={!label || !address || labelInvalid || addressInvalid || duplicateEntry || duplicateLabel}
              onClick={() => {
                addEntry({ label, address });
                setLabel('');
                setAddress('');
              }}
            >
              {dict.policy.addRecipient}
            </button>
          </div>
          {labelInvalid ? <p className="request-error">{dict.policy.invalidLabel}</p> : null}
          {addressInvalid ? <p className="request-error">{dict.policy.invalidAddress}</p> : null}
          {duplicateEntry ? <p className="request-error">{dict.policy.duplicateAddress}</p> : null}
          {duplicateLabel ? <p className="request-error">{dict.policy.duplicateLabel}</p> : null}
          {existingRecipientInvalid ? <p className="request-error">{dict.policy.invalidSavedRecipient}</p> : null}
          <button
            type="button"
            className="link"
            disabled={!props.wallet}
            onClick={() => props.wallet && addEntry({ label: 'my-wallet', address: props.wallet })}
          >
            {dict.policy.useOwnerWallet}
          </button>
        </Card>
      </div>

      <div className={dirty ? 'save-bar is-dirty' : 'save-bar'}>
        {dirty ? <span className="hint">{dict.policy.unsaved}</span> : null}
        <button
          type="button"
          className="primary"
          disabled={props.busy || !dirty || maxSolInvalid || maxSolDayInvalid || existingRecipientInvalid}
          onClick={save}
        >
          {props.busy ? dict.policy.saving : dict.policy.save}
        </button>
      </div>
    </div>
  );
}
