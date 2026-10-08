import type { PaymentRequest } from '@nexus/shared';
import { Activity, ExternalLink } from './icons.js';
import { Card, Empty, Mono, Pill } from './ui.js';
import { TONE, describeAction } from './RequestList.js';
import { useI18n } from '../i18n/context.js';

/** Compact, read-only table of the newest requests; full detail lives on the Approvals page. */
export function RecentRequests(props: {
  title: string;
  requests: PaymentRequest[];
  limit: number;
  onViewAll: () => void;
}) {
  const { dict } = useI18n();
  const rows = props.requests.slice(0, props.limit);

  return (
    <Card
      title={props.title}
      titleIcon={<Activity size={16} />}
      actions={
        props.requests.length > 0 ? (
          <button type="button" className="link" onClick={props.onViewAll}>
            {dict.overview.viewAll}
          </button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <Empty>{dict.requests.noRequests}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{dict.overview.colStatus}</th>
                <th>{dict.overview.colCommand}</th>
                <th>{dict.overview.colAction}</th>
                <th>{dict.overview.colTime}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => (
                <tr key={request.id}>
                  <td>
                    <Pill tone={TONE[request.status]}>{dict.requests.statuses[request.status]}</Pill>
                  </td>
                  <td className="cell-prompt" title={request.prompt}>
                    {request.prompt}
                  </td>
                  <td>
                    <Mono>{describeAction(request, dict.requests.actions)}</Mono>
                  </td>
                  <td className="cell-time">
                    {new Date(request.createdAt).toLocaleTimeString()}
                    {request.execution ? (
                      <a
                        href={request.execution.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={dict.requests.explorer}
                        title={dict.requests.explorer}
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
