import { useEffect, useState } from 'react';
import { AllowlistEntrySchema, PubkeySchema } from '@nexus/shared';
import { ShieldCheck, Wallet } from './icons.js';
import type { AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, shorten } from './ui.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
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
      // Keep the draft dirty so unsaved edits are preserved on error.
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title={dict.overview.spendingLimits}
          titleIcon={<ShieldCheck size={15} />}
          actions={<Badge variant="neutral">v{policy.version}</Badge>}
        >
          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-ink">{dict.policy.maxPerTx}</span>
            <div className="relative">
              <Input
                type="number"
                min="0.000000001"
                max="1000"
                step="any"
                className="pr-12 tabular-nums"
                value={maxSol}
                onChange={(e) => {
                  setMaxSol(e.target.value);
                  setDirty(true);
                }}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
                SOL
              </span>
            </div>
            {maxSolInvalid ? <p className="text-xs text-bad">{dict.policy.invalidPerTx}</p> : null}
          </label>

          <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-ink">{dict.policy.maxPerDay}</span>
            <div className="relative">
              <Input
                type="number"
                min="0"
                max="100000"
                step="0.01"
                className="pr-12 tabular-nums"
                placeholder={dict.policy.unlimitedPlaceholder}
                value={maxSolDay}
                onChange={(e) => {
                  setMaxSolDay(e.target.value);
                  setDirty(true);
                }}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">
                SOL
              </span>
            </div>
            {maxSolDayInvalid ? <p className="text-xs text-bad">{dict.policy.invalidPerDay}</p> : null}
          </label>
        </Card>

        <Card
          title={dict.policy.recipients}
          titleIcon={<Wallet size={15} />}
          actions={<Badge variant="neutral">{recipients.length}</Badge>}
        >
          {recipients.length === 0 ? (
            <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-xs text-muted">
              {dict.policy.noRecipients}
            </p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {recipients.map((entry) => (
                <li key={entry.address} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs font-semibold text-ink">{entry.label}</span>
                    <Mono title={entry.address} className="text-muted">{shorten(entry.address, 6)}</Mono>
                    <CopyAddressButton value={entry.address} label={dict.wallet.copyAddress} />
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="text-xs text-bad hover:text-bad"
                    onClick={() => {
                      setRecipients(recipients.filter((r) => r.address !== entry.address));
                      setDirty(true);
                    }}
                  >
                    {dict.policy.remove}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_minmax(0,1fr)_auto]">
            <Input
              aria-label={dict.policy.namePlaceholder}
              placeholder={dict.policy.namePlaceholder}
              value={label}
              onChange={(e) => setLabel(e.target.value.trim())}
            />
            <Input
              aria-label={dict.policy.addressPlaceholder}
              placeholder={dict.policy.addressPlaceholder}
              className="text-xs"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!label || !address || labelInvalid || addressInvalid || duplicateEntry || duplicateLabel}
              onClick={() => {
                addEntry({ label, address });
                setLabel('');
                setAddress('');
              }}
            >
              {dict.policy.addRecipient}
            </Button>
          </div>

          {labelInvalid ? <p className="text-xs text-bad">{dict.policy.invalidLabel}</p> : null}
          {addressInvalid ? <p className="text-xs text-bad">{dict.policy.invalidAddress}</p> : null}
          {duplicateEntry ? <p className="text-xs text-bad">{dict.policy.duplicateAddress}</p> : null}
          {duplicateLabel ? <p className="text-xs text-bad">{dict.policy.duplicateLabel}</p> : null}
          {existingRecipientInvalid ? <p className="text-xs text-bad">{dict.policy.invalidSavedRecipient}</p> : null}

          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-xs"
            disabled={!props.wallet}
            onClick={() => props.wallet && addEntry({ label: 'my-wallet', address: props.wallet })}
          >
            {dict.policy.useOwnerWallet}
          </Button>
        </Card>
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-line pt-3">
        {dirty ? <span className="text-xs font-medium text-warn">{dict.policy.unsaved}</span> : null}
        <Button
          type="button"
          variant="default"
          disabled={props.busy || !dirty || maxSolInvalid || maxSolDayInvalid || existingRecipientInvalid}
          onClick={save}
        >
          {props.busy ? dict.policy.saving : dict.policy.save}
        </Button>
      </div>
    </div>
  );
}
