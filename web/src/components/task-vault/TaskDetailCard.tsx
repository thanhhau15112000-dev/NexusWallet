import type { TaskCapabilityRecord } from '@nexus/shared';
import { Coins, ExternalLink } from '../icons.js';
import { Card, CopyAddressButton, DateTime, Mono, Notice, Pill, shorten } from '../ui.js';
import { Button } from '../ui/button.js';
import { useI18n } from '../../i18n/context.js';
import { amountOf, assetOf, explorerTx, formatUnits, statusTone } from './units.js';

export function TaskDetailCard(props: {
  task: TaskCapabilityRecord;
  detailStatus: 'active' | 'completed' | 'revoked' | 'expired';
  taskOpen: boolean;
  hasHeldEscrow: boolean;
  vaultRemainingLamports: number;
  refundedLamports: number;
  busyAction: string | null;
  locked: boolean;
  allowedMints: { label: string; address: string }[];
  onRevoke: (taskId: string) => void;
  onRefund: (taskId: string) => void;
}) {
  const { dict } = useI18n();
  const { task } = props;

  return (
    <Card
      title={task.taskId}
      titleIcon={<Coins size={15} />}
      titleAction={<Pill tone={statusTone(props.detailStatus)}>{dict.taskVault.statuses[props.detailStatus]}</Pill>}
      actions={
        <>
          {props.taskOpen ? (
            <Button
              type="button"
              variant="destructiveOutline"
              size="sm"
              disabled={Boolean(props.busyAction) || props.locked}
              onClick={() => props.onRevoke(task.taskId)}
            >
              {dict.taskVault.detail.revoke}
            </Button>
          ) : null}
          {!task.isClosed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(props.busyAction) || props.hasHeldEscrow || props.locked}
              aria-describedby={props.hasHeldEscrow ? 'refund-blocked-note' : undefined}
              onClick={() => props.onRefund(task.taskId)}
            >
              {dict.taskVault.detail.refundAndClose}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-2">
        <span className="block text-xs font-medium text-muted">{dict.taskVault.detail.remaining}</span>
        <strong className="block text-2xl font-semibold text-ink tabular-nums [font-stretch:112%]">
          {amountOf(props.vaultRemainingLamports, task, props.allowedMints)}
        </strong>
        <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <span
            className="block h-full rounded-full bg-accent"
            style={{
              width: `${task.budgetLamports > 0 ? Math.min(100, (task.spentLamports / task.budgetLamports) * 100) : 0}%`,
            }}
          />
        </span>
        <span className="block text-xs text-muted tabular-nums">
          {dict.taskVault.detail.totalSpent}: {formatUnits(BigInt(task.spentLamports), assetOf(task, props.allowedMints).decimals)} /{' '}
          {amountOf(task.budgetLamports, task, props.allowedMints)}
          {task.isClosed
            ? ` · ${task.isSimulated === false ? dict.taskVault.detail.refunded : dict.taskVault.detail.refundedSimulated}: ${amountOf(props.refundedLamports, task, props.allowedMints)}`
            : null}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line pt-3 text-sm sm:grid-cols-3">
        <div className="space-y-1">
          <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.perPaymentCap}</dt>
          <dd className="text-ink tabular-nums">{amountOf(task.perPaymentCapLamports, task, props.allowedMints)}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.expiresAt}</dt>
          <dd className="text-ink tabular-nums">
            <DateTime value={task.expiry * 1000} />
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.executionMode}</dt>
          <dd>
            {task.txSignature ? (
              <a href={explorerTx(task.txSignature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                <Pill tone="ok">{dict.taskVault.detail.devnetTx}</Pill>
                <ExternalLink size={12} className="text-accent" />
              </a>
            ) : (
              <Pill tone="neutral">{dict.taskVault.detail.simulated}</Pill>
            )}
          </dd>
        </div>
      </dl>

      {props.detailStatus === 'expired' && !task.isClosed ? (
        <Notice tone="warn" role="status">
          {dict.taskVault.detail.expiredNote}
        </Notice>
      ) : null}
      {props.hasHeldEscrow && !task.isClosed ? (
        <Notice tone="warn" id="refund-blocked-note" role="status">
          {dict.taskVault.detail.refundBlockedPending}
        </Notice>
      ) : null}

      <details className="text-xs">
        <summary className="cursor-pointer font-medium text-muted hover:text-ink">
          {dict.taskVault.detail.technicalDetails}
        </summary>
        <dl className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-line bg-surface-muted/40 p-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">{dict.taskVault.detail.allowedWorker}</dt>
            <dd className="inline-flex items-center gap-1">
              <Mono title={task.allowedWorker ?? undefined}>
                {task.allowedWorker ? shorten(task.allowedWorker, 4) : dict.taskVault.detail.any}
              </Mono>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">{dict.taskVault.detail.allowedService}</dt>
            <dd>
              <Mono>{task.allowedServiceId || dict.taskVault.detail.any}</Mono>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">{dict.taskVault.detail.capabilityPda}</dt>
            <dd className="inline-flex items-center gap-1">
              <Mono title={task.pda ?? undefined}>{shorten(task.pda ?? '—', 8)}</Mono>
              {task.pda ? <CopyAddressButton value={task.pda} label={dict.taskVault.detail.copyCapPda} /> : null}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted">{dict.taskVault.detail.vaultPda}</dt>
            <dd className="inline-flex items-center gap-1">
              <Mono title={task.vaultPda ?? undefined}>{shorten(task.vaultPda ?? '—', 8)}</Mono>
              {task.vaultPda ? <CopyAddressButton value={task.vaultPda} label={dict.taskVault.detail.copyVaultPda} /> : null}
            </dd>
          </div>
          {task.txSignature ? (
            <div className="flex items-center justify-between gap-2 sm:col-span-2">
              <dt className="text-muted">{dict.taskVault.detail.devnetTxLabel}</dt>
              <dd>
                <a
                  href={explorerTx(task.txSignature)}
                  target="_blank"
                  rel="noreferrer"
                  title={task.txSignature}
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                >
                  {shorten(task.txSignature, 8)}
                  <ExternalLink size={12} />
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      </details>
    </Card>
  );
}
