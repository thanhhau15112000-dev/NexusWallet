import type { ReactNode } from 'react';
import type { TaskCapabilityRecord } from '@nexus/shared';
import { Input } from '../ui/input.js';
import { shorten } from '../ui.js';

export type TaskStatusTone = 'ok' | 'warn' | 'bad' | 'neutral';

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

// The stored status stays 'active' after expiry until someone closes the task; show what the guard enforces.
export function effectiveStatus(task: TaskCapabilityRecord, nowSeconds: number) {
  return task.status === 'active' && nowSeconds >= task.expiry ? 'expired' : task.status;
}

export function statusTone(status: string): TaskStatusTone {
  switch (status) {
    case 'active':
      return 'ok';
    case 'completed':
      return 'neutral';
    case 'revoked':
      return 'bad';
    case 'expired':
      return 'warn';
    default:
      return 'neutral';
  }
}

/** Display unit and decimals of a task's budget asset. */
export function assetOf(
  task: TaskCapabilityRecord,
  allowedMints: { label: string; address: string }[],
): { unit: string; decimals: number } {
  if (!task.mint) return { unit: 'SOL', decimals: 9 };
  const label = allowedMints.find((entry) => entry.address === task.mint)?.label ?? shorten(task.mint, 4);
  return { unit: label, decimals: task.mintDecimals ?? 0 };
}

/** Parse a positive decimal string into exact integer base units without float rounding drift. */
export function parseDecimalToBaseUnits(raw: string, decimals: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const [whole = '0', frac = ''] = trimmed.split('.');
  if (frac.length > decimals) return null;
  const baseUnits = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0'));
  if (baseUnits <= 0n || baseUnits > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(baseUnits);
}

/** Base units as an exact decimal string, trailing zeros dropped. */
export function formatUnits(baseUnits: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (baseUnits % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${baseUnits / divisor}.${fraction}` : (baseUnits / divisor).toString();
}

/** A base-unit amount of the task's asset with its unit. */
export function amountOf(
  baseUnits: number,
  task: TaskCapabilityRecord,
  allowedMints: { label: string; address: string }[],
): string {
  const asset = assetOf(task, allowedMints);
  return `${formatUnits(BigInt(baseUnits), asset.decimals)} ${asset.unit}`;
}

export function Field(props: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-ink">
        {props.label}
        {props.required ? (
          <span className="ml-0.5 text-bad" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {props.children}
    </label>
  );
}

export function UnitInput(props: { unit: string; value: string; onChange: (value: string) => void; min?: string; max?: string }) {
  return (
    <div className="relative">
      <Input
        type="number"
        step="any"
        min={props.min}
        max={props.max}
        className="tabular-nums"
        // Asset labels vary in length; reserve room so typed digits never run under the unit.
        style={{ paddingRight: `calc(${props.unit.length * 0.5}em + 1rem)` }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{props.unit}</span>
    </div>
  );
}
