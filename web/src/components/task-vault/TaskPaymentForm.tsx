import type { FormEvent } from 'react';
import { Play } from '../icons.js';
import { Card } from '../ui.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { useI18n } from '../../i18n/context.js';
import { Field, UnitInput } from './units.js';

export function TaskPaymentForm(props: {
  unit: string;
  amount: string;
  worker: string;
  service: string;
  advancedOpen: boolean;
  busy: boolean;
  locked: boolean;
  onAmountChange: (val: string) => void;
  onWorkerChange: (val: string) => void;
  onServiceChange: (val: string) => void;
  onAdvancedOpenChange: (open: boolean) => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const { dict } = useI18n();

  return (
    <Card title={dict.taskVault.payment.title} titleIcon={<Play size={15} />}>
      <form onSubmit={props.onSubmit} className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <Field label={dict.taskVault.payment.amount} required>
              <UnitInput unit={props.unit} min="0.000001" value={props.amount} onChange={props.onAmountChange} />
            </Field>
          </div>
          <Button type="submit" variant="default" disabled={props.busy || props.locked}>
            {props.busy ? dict.taskVault.payment.submittingBtn : dict.taskVault.payment.submitBtn}
          </Button>
        </div>
        <details
          className="text-xs"
          open={props.advancedOpen}
          onToggle={(e) => props.onAdvancedOpenChange(e.currentTarget.open)}
        >
          <summary className="cursor-pointer font-medium text-muted hover:text-ink">
            {dict.taskVault.payment.advanced}
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field label={dict.taskVault.payment.workerAddress}>
              <Input
                type="text"
                value={props.worker}
                onChange={(e) => props.onWorkerChange(e.target.value)}
                placeholder={dict.taskVault.payment.workerPlaceholder}
              />
            </Field>
            <Field label={dict.taskVault.payment.serviceId} required>
              <Input type="text" value={props.service} onChange={(e) => props.onServiceChange(e.target.value)} />
            </Field>
          </div>
        </details>
      </form>
    </Card>
  );
}
