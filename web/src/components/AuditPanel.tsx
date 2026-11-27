import type { ReactNode } from 'react';
import { ClipboardList } from './icons.js';
import type { AuditEntryView } from '@nexus/shared';
import { Card, DateTime, Empty, Mono, Notice } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function AuditPanel(props: {
  entries: AuditEntryView[] | null;
  error?: string | null;
  actions?: ReactNode;
}) {
  const { dict } = useI18n();

  return (
    <Card title={dict.audit.title} titleIcon={<ClipboardList size={15} />} actions={props.actions}>
      {props.error ? (
        <Notice tone="bad">
          {dict.history.loadFailed}: {props.error}
        </Notice>
      ) : null}

      {props.entries === null ? (
        props.error ? null : <Empty>{dict.history.loading}</Empty>
      ) : props.entries.length === 0 ? (
        <Empty>{dict.audit.noEntries}</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {props.entries.map((entry) => (
            <li key={entry.id} className="px-3 py-2">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 text-xs">
                  <span className="text-muted tabular-nums">
                    <DateTime value={entry.at} />
                  </span>
                  <span className="font-semibold text-ink" title={entry.event}>
                    {dict.audit.events[entry.event] ?? entry.event}
                  </span>
                </summary>
                <div className="mt-2 space-y-2">
                  {entry.requestId ? (
                    <p className="text-[11px] text-muted">
                      {dict.audit.requestId}:{' '}
                      <Mono title={entry.requestId} className="text-ink">
                        {entry.requestId}
                      </Mono>
                    </p>
                  ) : null}
                  <pre className="overflow-x-auto rounded border border-line bg-surface-muted p-2.5 font-mono text-[11px] text-ink">
                    {JSON.stringify(entry.detail, null, 2).slice(0, 600)}
                  </pre>
                  <details className="text-[11px]">
                    <summary className="cursor-pointer font-medium text-muted hover:text-ink">
                      {dict.audit.ciphertext}
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded border border-line bg-surface-muted p-2.5 font-mono text-[11px] text-ink">
                      {entry.sealed.ciphertext}
                    </pre>
                  </details>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
