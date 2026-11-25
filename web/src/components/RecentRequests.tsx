import type { PaymentRequest } from '@nexus/shared';
import { Activity, ExternalLink } from './icons.js';
import { Card, Empty, Mono, Pill } from './ui.js';
import { Button } from './ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table.js';
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
      titleIcon={<Activity size={15} />}
      actions={
        props.requests.length > 0 ? (
          <Button type="button" variant="link" size="sm" className="text-xs" onClick={props.onViewAll}>
            {dict.overview.viewAll}
          </Button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <Empty>{dict.requests.noRequests}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{dict.overview.colStatus}</TableHead>
              <TableHead>{dict.overview.colCommand}</TableHead>
              <TableHead>{dict.overview.colAction}</TableHead>
              <TableHead className="text-right">{dict.overview.colTime}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((request) => (
              <TableRow key={request.id}>
                <TableCell>
                  <Pill tone={TONE[request.status]}>{dict.requests.statuses[request.status]}</Pill>
                </TableCell>
                <TableCell className="max-w-[260px] truncate text-xs text-ink" title={request.prompt}>
                  {request.prompt}
                </TableCell>
                <TableCell>
                  <Mono>{describeAction(request, dict.requests.actions)}</Mono>
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {new Date(request.createdAt).toLocaleTimeString()}
                    {request.execution ? (
                      <a
                        href={request.execution.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent hover:text-accent-hover"
                        aria-label={dict.requests.explorer}
                        title={dict.requests.explorer}
                      >
                        <ExternalLink size={12} />
                      </a>
                    ) : null}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
