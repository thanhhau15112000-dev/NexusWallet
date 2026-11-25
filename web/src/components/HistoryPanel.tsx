import { useCallback, useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL, type PaymentRequest } from '@nexus/shared';
import { ChevronLeft, ChevronRight, Clock, ExternalLink, RefreshCw } from './icons.js';
import { api, type AgentHistoryItem } from '../api.js';
import { Card, Empty, Pill } from './ui.js';
import { Button } from './ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table.js';
import { RecentRequests } from './RecentRequests.js';
import { cn } from '../lib/utils.js';
import { useI18n } from '../i18n/context.js';

const POLL_MS = 15_000;
const PAGE_SIZE = 10;

function formatSol(lamports: number, signed = false): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  const digits = sol !== 0 && Math.abs(sol) < 0.001 ? 6 : 4;
  const text = Math.abs(sol).toFixed(digits);
  if (!signed) return text;
  return `${sol > 0 ? '+' : sol < 0 ? '-' : ''}${text}`;
}

function ChainHistory(props: { active: boolean }) {
  const { dict, interpolate } = useI18n();
  const [items, setItems] = useState<AgentHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursors, setCursors] = useState<string[]>(['']);
  const [page, setPage] = useState(0);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const before = cursors[page] ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.agentHistory({ before: before || undefined, limit: PAGE_SIZE });
      setItems(result.items);
      setNextBefore(result.nextBefore);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [before]);

  useEffect(() => {
    if (!props.active) return;
    void load();
    if (page !== 0) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [props.active, page, load]);

  const goOlder = () => {
    if (!nextBefore) return;
    setCursors([...cursors.slice(0, page + 1), nextBefore]);
    setPage(page + 1);
  };

  return (
    <Card
      title={dict.history.title}
      titleIcon={<Clock size={15} />}
      actions={
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} aria-hidden="true" />
          {dict.history.refresh}
        </Button>
      }
    >
      {error ? (
        <p className="rounded-md border border-bad-line bg-bad-soft px-3 py-2 text-xs text-bad">
          {dict.history.loadFailed}: {error}
        </p>
      ) : null}

      {items === null ? (
        error ? null : <Empty>{dict.history.loading}</Empty>
      ) : items.length === 0 ? (
        <Empty>{dict.history.empty}</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{dict.history.colTime}</TableHead>
              <TableHead>{dict.history.colType}</TableHead>
              <TableHead className="text-right">{dict.history.colChange}</TableHead>
              <TableHead className="text-right">{dict.history.colBalance}</TableHead>
              <TableHead className="text-right" aria-label={dict.history.explorer} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const received = item.deltaLamports > 0;
              return (
                <TableRow key={item.signature}>
                  <TableCell className="font-mono text-xs text-muted tabular-nums whitespace-nowrap">
                    {item.blockTime === null ? '-' : new Date(item.blockTime * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {item.status === 'failed' ? (
                      <Pill tone="bad">{dict.history.failed}</Pill>
                    ) : (
                      <Pill tone={received ? 'ok' : 'warn'}>
                        {received ? dict.history.received : dict.history.sent}
                      </Pill>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono text-xs font-semibold tabular-nums whitespace-nowrap',
                      received ? 'text-accent' : 'text-ink',
                    )}
                  >
                    {formatSol(item.deltaLamports, true)} SOL
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted tabular-nums whitespace-nowrap">
                    {formatSol(item.balanceAfterLamports)} SOL
                  </TableCell>
                  <TableCell className="text-right">
                    <a
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                      href={item.explorerUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {dict.history.explorer}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {items !== null && (page > 0 || nextBefore) ? (
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={dict.history.prev}
            title={dict.history.prev}
            disabled={loading || page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </Button>
          <span className="font-mono text-xs text-muted tabular-nums">
            {interpolate(dict.history.page, { page: page + 1 })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={dict.history.next}
            title={dict.history.next}
            disabled={loading || !nextBefore}
            onClick={goOlder}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Where transactions are tracked: the agent's requests and the SOL going in and out on-chain.
 */
export function HistoryPanel(props: { active: boolean; requests: PaymentRequest[]; onViewAll: () => void }) {
  const { dict } = useI18n();
  return (
    <div className="space-y-4">
      <RecentRequests
        title={dict.history.requestsTitle}
        requests={props.requests}
        limit={20}
        onViewAll={props.onViewAll}
      />
      <ChainHistory active={props.active} />
    </div>
  );
}
