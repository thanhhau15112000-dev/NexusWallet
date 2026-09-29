import { useCallback, useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL, type PaymentRequest } from '@nexus/shared';
import { ChevronLeft, ChevronRight, Clock, ExternalLink, RefreshCw } from './icons.js';
import { api, type AgentHistoryItem } from '../api.js';
import { Card, Empty, Pill } from './ui.js';
import { RecentRequests } from './RecentRequests.js';
import { useI18n } from '../i18n/context.js';

const POLL_MS = 15_000;
const PAGE_SIZE = 10;

function formatSol(lamports: number, signed = false): string {
  const sol = lamports / LAMPORTS_PER_SOL;
  // A failed transaction only costs the network fee, which rounds to zero at 4 digits.
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
  // Pages are cursor-based (the RPC pages by signature), so remember where each visited page started.
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

  // The panels stay mounted, so only read the chain while this tab is showing. Older pages do not
  // change, so only the newest page is refreshed on a timer.
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
      titleIcon={<Clock size={16} />}
      actions={
        <button type="button" className="button-with-icon" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
          {dict.history.refresh}
        </button>
      }
    >
      {error ? (
        <p className="request-error">
          {dict.history.loadFailed}: {error}
        </p>
      ) : null}
      {items === null ? (
        error ? null : <Empty>{dict.history.loading}</Empty>
      ) : items.length === 0 ? (
        <Empty>{dict.history.empty}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{dict.history.colTime}</th>
                <th>{dict.history.colType}</th>
                <th className="num">{dict.history.colChange}</th>
                <th className="num">{dict.history.colBalance}</th>
                <th aria-label={dict.history.explorer} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const received = item.deltaLamports > 0;
                return (
                  <tr key={item.signature}>
                    <td className="cell-time">
                      {item.blockTime === null ? '-' : new Date(item.blockTime * 1000).toLocaleString()}
                    </td>
                    <td>
                      {item.status === 'failed' ? (
                        <Pill tone="bad">{dict.history.failed}</Pill>
                      ) : (
                        <Pill tone={received ? 'ok' : 'warn'}>
                          {received ? dict.history.received : dict.history.sent}
                        </Pill>
                      )}
                    </td>
                    <td className={`num ${received ? 'delta-in' : 'delta-out'}`}>
                      {formatSol(item.deltaLamports, true)} SOL
                    </td>
                    <td className="num">{formatSol(item.balanceAfterLamports)} SOL</td>
                    <td className="cell-action">
                      <a
                        className="explorer-cta button-with-icon"
                        href={item.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {dict.history.explorer}
                        <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {items !== null && (page > 0 || nextBefore) ? (
        <div className="pager">
          <button
            type="button"
            className="icon-btn"
            aria-label={dict.history.prev}
            title={dict.history.prev}
            disabled={loading || page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="hint">{interpolate(dict.history.page, { page: page + 1 })}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={dict.history.next}
            title={dict.history.next}
            disabled={loading || !nextBefore}
            onClick={goOlder}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <p className="hint">{dict.history.note}</p>
    </Card>
  );
}

/**
 * Where transactions are tracked: the agent's requests (including ones that were denied or are still
 * waiting for approval) and the SOL going in and out of the agent wallet, read from the chain.
 */
export function HistoryPanel(props: { active: boolean; requests: PaymentRequest[]; onViewAll: () => void }) {
  const { dict } = useI18n();
  return (
    <div className="page-stack">
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
