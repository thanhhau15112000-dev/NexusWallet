import type { FormEvent } from 'react';
import { Plus } from '../icons.js';
import { Card } from '../ui.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { useI18n } from '../../i18n/context.js';
import { Field, formatUnits, UnitInput } from './units.js';

export function CreateTaskCard(props: {
  owner: string | null;
  locked: boolean;
  busy: boolean;
  allowedMints: { label: string; address: string }[];
  newAsset: string;
  newAssetUnit: string;
  ownerBalance: { asset: string; baseUnits: bigint; decimals: number } | null;
  newBudgetSol: string;
  newCapSol: string;
  newHours: string;
  createAdvancedOpen: boolean;
  newAllowedWorker: string;
  newAllowedServiceId: string;
  submitOnchain: boolean;
  onAssetChange: (asset: string) => void;
  onBudgetChange: (val: string) => void;
  onCapChange: (val: string) => void;
  onHoursChange: (val: string) => void;
  onAdvancedOpenChange: (open: boolean) => void;
  onAllowedWorkerChange: (val: string) => void;
  onAllowedServiceIdChange: (val: string) => void;
  onSubmitOnchainChange: (checked: boolean) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const { dict } = useI18n();

  return (
    <Card
      title={dict.taskVault.create.title}
      titleIcon={<Plus size={15} />}
      actions={
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={props.onClose}>
          {dict.taskVault.create.cancel}
        </Button>
      }
    >
      <form onSubmit={props.onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={dict.taskVault.create.asset} required>
            <select
              className="flex h-9 w-full rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm text-ink transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
              value={props.newAsset}
              onChange={(e) => props.onAssetChange(e.target.value)}
            >
              <option value="">SOL</option>
              {props.allowedMints.map((entry) => (
                <option key={entry.address} value={entry.address}>
                  {entry.label}
                </option>
              ))}
            </select>
          </Field>
          {props.owner ? (
            <p className="self-end pb-2 text-xs text-muted tabular-nums sm:col-span-2">
              {dict.taskVault.create.ownerBalance}:{' '}
              {props.ownerBalance?.asset === props.newAsset
                ? `${formatUnits(props.ownerBalance.baseUnits, props.ownerBalance.decimals)} ${props.newAssetUnit}`
                : '…'}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={dict.taskVault.create.totalBudget} required>
            <UnitInput unit={props.newAssetUnit} min="0.000001" value={props.newBudgetSol} onChange={props.onBudgetChange} />
          </Field>
          <Field label={dict.taskVault.create.perPaymentCap} required>
            <UnitInput unit={props.newAssetUnit} min="0.000001" value={props.newCapSol} onChange={props.onCapChange} />
          </Field>
          <Field label={dict.taskVault.create.expiryDuration} required>
            <UnitInput unit={dict.taskVault.create.hoursUnit} min="0.05" max="168" value={props.newHours} onChange={props.onHoursChange} />
          </Field>
        </div>

        <details
          className="text-xs"
          open={props.createAdvancedOpen}
          onToggle={(e) => props.onAdvancedOpenChange(e.currentTarget.open)}
        >
          <summary className="cursor-pointer font-medium text-muted hover:text-ink">
            {dict.taskVault.create.advanced}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field label={dict.taskVault.create.allowedWorker} required={props.submitOnchain}>
                <Input
                  type="text"
                  value={props.newAllowedWorker}
                  onChange={(e) => props.onAllowedWorkerChange(e.target.value)}
                  placeholder={dict.taskVault.create.allowedWorkerPlaceholder}
                />
              </Field>
              <Field label={dict.taskVault.create.allowedService}>
                <Input
                  type="text"
                  value={props.newAllowedServiceId}
                  onChange={(e) => props.onAllowedServiceIdChange(e.target.value)}
                  placeholder={dict.taskVault.create.allowedServicePlaceholder}
                />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={props.submitOnchain}
                onChange={(e) => props.onSubmitOnchainChange(e.target.checked)}
              />
              <span>{dict.taskVault.create.broadcastOnChain}</span>
            </label>
          </div>
        </details>

        <div className="flex justify-end border-t border-line pt-4">
          <Button type="submit" variant="default" disabled={props.busy || !props.owner || props.locked}>
            {props.busy ? dict.taskVault.create.submittingBtn : dict.taskVault.create.submitBtn}
          </Button>
        </div>
        {!props.owner ? <p className="text-xs text-warn">{dict.taskVault.create.connectHint}</p> : null}
      </form>
    </Card>
  );
}
