import { useState } from 'react';
import { ClipboardList } from './icons.js';
import type { AuditEntryView } from '@nexus/shared';
import { Card, Empty, Mono } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function AuditPanel(props: { entries: AuditEntryView[] }) {
  const { dict } = useI18n();
  const [showSealed, setShowSealed] = useState(false);

  return (
    <Card
      title={dict.audit.title}
      titleIcon={<ClipboardList size={16} />}
      className="panel-audit"
      actions={
        <label className="toggle">
          <input type="checkbox" checked={showSealed} onChange={(e) => setShowSealed(e.target.checked)} />
          {dict.audit.ciphertext}
        </label>
      }
    >
      {props.entries.length === 0 ? (
        <Empty>{dict.audit.noEntries}</Empty>
      ) : (
        <ul className="audit-list">
          {props.entries.map((entry) => (
            <li key={entry.id}>
              <details>
                <summary className="audit-head">
                  <Mono>{new Date(entry.at).toLocaleTimeString()}</Mono>
                  <strong>{entry.event}</strong>
                  {entry.requestId ? <Mono title={entry.requestId}>{entry.requestId}</Mono> : null}
                </summary>
                <pre>
                  {showSealed ? entry.sealed.ciphertext : JSON.stringify(entry.detail, null, 1).slice(0, 600)}
                </pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
