import type { TaskCapabilityRecord } from '@nexus/shared';
import { Layers, Plus, RefreshCw } from '../icons.js';
import { Card, Empty, Pill } from '../ui.js';
import { Button } from '../ui/button.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../i18n/context.js';
import { amountOf, assetOf, effectiveStatus, formatUnits, statusTone } from './units.js';

export function TaskListCard(props: {
  tasks: TaskCapabilityRecord[];
  selectedTaskId: string | null;
  showCreate: boolean;
  loading: boolean;
  nowSeconds: number;
  allowedMints: { label: string; address: string }[];
  onRefresh: () => void;
  onOpenCreate: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const { dict } = useI18n();

  return (
    <Card
      title={dict.taskVault.list.title}
      titleIcon={<Layers size={15} />}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title={dict.taskVault.list.refresh}
            aria-label={dict.taskVault.list.refresh}
            onClick={props.onRefresh}
            disabled={props.loading}
          >
            <RefreshCw size={13} className={cn(props.loading && 'animate-spin')} />
          </Button>
          {!props.showCreate ? (
            <Button type="button" variant="default" size="sm" className="h-7 px-2.5 text-xs" onClick={props.onOpenCreate}>
              <Plus size={12} />
              {dict.taskVault.list.newTask}
            </Button>
          ) : null}
        </>
      }
    >
      {props.tasks.length === 0 ? (
        <Empty>{dict.taskVault.list.empty}</Empty>
      ) : (
        <ul className="-mx-1 space-y-1">
          {props.tasks.map((t) => {
            const isSelected = !props.showCreate && t.taskId === props.selectedTaskId;
            const rowStatus = effectiveStatus(t, props.nowSeconds);
            const ratio = t.budgetLamports > 0 ? Math.min(100, (t.spentLamports / t.budgetLamports) * 100) : 0;
            return (
              <li key={t.taskId}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => props.onSelectTask(t.taskId)}
                  className={cn(
                    'w-full space-y-2 rounded-md px-3 py-2.5 text-left transition-colors',
                    isSelected ? 'bg-accent-soft' : 'hover:bg-surface-muted',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-sm font-medium', isSelected ? 'text-accent-strong' : 'text-ink')}>
                      {t.taskId}
                    </span>
                    <Pill tone={statusTone(rowStatus)}>{dict.taskVault.statuses[rowStatus]}</Pill>
                  </span>
                  <span className="block h-1 w-full overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${ratio}%` }} />
                  </span>
                  <span className="flex items-center justify-between text-xs text-muted tabular-nums">
                    <span>
                      {formatUnits(BigInt(t.spentLamports), assetOf(t, props.allowedMints).decimals)} /{' '}
                      {amountOf(t.budgetLamports, t, props.allowedMints)}
                    </span>
                    <span>
                      {dict.taskVault.list.cap}{' '}
                      {formatUnits(BigInt(t.perPaymentCapLamports), assetOf(t, props.allowedMints).decimals)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
