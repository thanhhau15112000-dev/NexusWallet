import { useState } from 'react';
import { ClipboardList } from './icons.js';
import type { AuditEntryView } from '@nexus/shared';
import { Card, DateTime, Empty, Mono } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function AuditPanel(props: { entries: AuditEntryView[] }) {
  const { dict } = useI18n();
  const [showSealed, setShowSealed] = useState(false);

  return (
    <Card
      title={dict.audit.title}
      titleIcon={<ClipboardList size={15} />}
      actions={
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-accent"
            checked={showSealed}
            onChange={(e) => setShowSealed(e.target.checked)}
          />
          <span>{dict.audit.ciphertext}</span>
        </label>
      }
    >
      {props.entries.length === 0 ? (
        <Empty>{dict.audit.noEntries}</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {props.entries.map((entry) => (
            <li key={entry.id} className="px-3 py-2">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 text-xs">
                  <Mono className="text-muted"><DateTime value={entry.at} /></Mono>
                  <span className="font-mono font-semibold text-ink">{entry.event}</span>
                  {entry.requestId ? (
                    <Mono title={entry.requestId} className="ml-auto text-muted">
                      {entry.requestId}
                    </Mono>
                  ) : null}
                </summary>
                <pre className="mt-2 overflow-x-auto rounded border border-line bg-surface-muted p-2.5 font-mono text-[11px] text-ink">
                  {showSealed ? entry.sealed.ciphertext : JSON.stringify(entry.detail, null, 2).slice(0, 600)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
