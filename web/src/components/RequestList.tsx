import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from './icons.js';
import { type PaymentRequest, type RequestStatus } from '@nexus/shared';
import { Card, DateTime, Empty, Mono, Pill, shorten } from './ui.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';
import { useI18n } from '../i18n/context.js';

export const TONE: Record<RequestStatus, string> = {
  planned: 'neutral',
  auto_approved: 'ok',
  pending_approval: 'warn',
  approved: 'ok',
  confirmed: 'ok',
  failed: 'bad',
  denied: 'bad',
  expired: 'bad',
};

function verdictTone(verdict: string): string {
  if (verdict === 'allow') return 'ok';
  if (verdict === 'require_approval') return 'warn';
  return 'bad';
}

export type ActionLabels = { balance: string; manualApproval: string };

export function describeAction(request: PaymentRequest, labels: ActionLabels): string {
  const action = request.plan?.action;
  if (!action) return '-';
  switch (action.type) {
    case 'transfer_sol':
      return `${action.amountSol} SOL → ${shorten(action.recipient, 6)}`;
    case 'transfer_spl':
      return `${action.amount} ${shorten(action.mint, 4)} → ${shorten(action.recipient, 6)}`;
    case 'get_balance':
      return labels.balance;
    case 'request_manual_approval':
      return labels.manualApproval;
  }
}

/**
 * Localized text for a request error, keyed by its code. Falls back to the raw message for unknown
 * codes, and for requests stored before `details` existed when a placeholder cannot be filled.
 */
export function localizeError(
  error: NonNullable<PaymentRequest['error']>,
  templates: Record<string, string>,
  interpolate: (template: string, params: Record<string, string | number>) => string,
): string {
  const template = templates[error.code];
  if (!template) return error.message;
  const params: Record<string, string | number> = { message: error.message };
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') params[key] = value;
  }
  const placeholders = Array.from(template.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? '');
  if (placeholders.some((key) => !(key in params))) return error.message;
  return interpolate(template, params);
}

function RequestRow(props: {
  request: PaymentRequest;
  now: number;
  focused: boolean;
  canApprove: boolean;
  busy: boolean;
  onApprove: (request: PaymentRequest) => void;
  onCancel: (request: PaymentRequest) => void;
}) {
  const { dict, interpolate } = useI18n();
  const { request } = props;
  const decision = request.decision;
  const approvalExpired = Boolean(
    request.status === 'pending_approval'
    && request.approval
    && new Date(request.approval.payload.expiresAt).getTime() <= props.now,
  );
  const displayedStatus = approvalExpired ? 'expired' : request.status;

  return (
    <li
      id={`request-${request.id}`}
      className={cn(
        'space-y-2.5 px-4 py-3.5 transition-colors',
        props.focused && 'bg-accent-soft/40 ring-1 ring-inset ring-accent',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Pill tone={TONE[displayedStatus]}>{dict.requests.statuses[displayedStatus]}</Pill>
          <span className="truncate text-sm font-medium text-ink" title={request.prompt}>
            {request.prompt}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Mono title={request.id}>{shorten(request.id, 5)}</Mono>
          <span className="font-mono text-[11px] tabular-nums">
            <DateTime value={request.createdAt} />
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <Mono className="text-ink">{describeAction(request, dict.requests.actions)}</Mono>
        {request.execution ? (
          <a
            href={request.execution.explorerUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-accent hover:underline"
          >
            {dict.requests.explorer}
          </a>
        ) : null}
      </div>

      {request.error ? (
        <p className="rounded-md border border-bad-line bg-bad-soft px-2.5 py-1.5 text-xs text-bad">
          {localizeError(request.error, dict.requests.errors, interpolate)}
        </p>
      ) : null}
      {approvalExpired ? (
        <p className="rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          {dict.requests.expiredNotice}
        </p>
      ) : null}

      {request.status === 'pending_approval' && request.approval && !approvalExpired ? (
        <div className="space-y-2 rounded-md border border-warn-line bg-warn-soft/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!props.canApprove || props.busy}
              onClick={() => props.onApprove(request)}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {props.busy ? dict.requests.waitingForWallet : dict.requests.approve}
            </Button>
            <Button
              type="button"
              variant="destructiveOutline"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onCancel(request)}
            >
              {dict.requests.cancel}
            </Button>
            <span className="ml-auto font-mono text-[11px] text-muted tabular-nums">
              {dict.requests.expires} <DateTime value={request.approval.payload.expiresAt} />
            </span>
          </div>
          {!props.canApprove ? (
            <p className="text-xs font-medium text-warn">{dict.requests.connectOwnerWallet}</p>
          ) : null}
          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-muted hover:text-ink">
              {dict.requests.message}
            </summary>
            <pre className="mt-2 overflow-x-auto rounded border border-line bg-panel p-2.5 font-mono text-[11px] text-ink">
              {request.approval.message}
            </pre>
          </details>
        </div>
      ) : null}

      {request.approval?.signature ? (
        <p className="text-[11px] text-muted">
          {dict.requests.approvedBy}{' '}
          <Mono className="text-ink">{shorten(request.approval.signerPubkey ?? '', 6)}</Mono>{' '}
          <span className="font-mono tabular-nums">
            <DateTime value={request.approval.signedAt} />
          </span>
        </p>
      ) : null}

      <details className="text-xs">
        <summary className="cursor-pointer text-[11px] font-medium text-muted hover:text-ink">
          {dict.requests.details}
        </summary>
        <div className="mt-2 space-y-1.5 rounded-md border border-line bg-surface-muted/50 p-2.5 text-[11px]">
          {decision ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="neutral" className="font-mono">v{decision.policyVersion}</Badge>
              <Pill tone={verdictTone(decision.verdict)}>{decision.verdict}</Pill>
              <span className="text-muted">{decision.reasons.join('; ')}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <span className="font-semibold text-muted">{dict.requests.createdTag}:</span>{' '}
              <DateTime value={request.createdAt} className="font-mono" />
            </span>
            {request.updatedAt !== request.createdAt ? (
              <span>
                <span className="font-semibold text-muted">{dict.requests.updatedTag}:</span>{' '}
                <DateTime value={request.updatedAt} className="font-mono" />
              </span>
            ) : null}
            {request.execution ? (
              <span>
                <span className="font-semibold text-muted">{dict.requests.confirmedTag}:</span>{' '}
                <DateTime value={request.execution.confirmedAt} className="font-mono" />
              </span>
            ) : null}
          </div>
          {request.execution ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold text-muted">{dict.requests.signatureTag}:</span>
              <a
                href={request.execution.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent hover:underline"
              >
                {shorten(request.execution.signature, 10)}
              </a>
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function RequestList(props: {
  requests: PaymentRequest[];
  wallet: string | null;
  owner: string | null;
  busyId: string | null;
  /** Request named by the `?request=` deep link an agent receives for a held transfer. */
  focusId?: string | null;
  onApprove: (request: PaymentRequest) => void;
  onCancel: (request: PaymentRequest) => void;
}) {
  const { dict, interpolate } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scrolledTo = useRef<string | null>(null);
  const focusLoaded = Boolean(props.focusId && props.requests.some((request) => request.id === props.focusId));

  useEffect(() => {
    if (!props.focusId || !focusLoaded || scrolledTo.current === props.focusId) return;
    scrolledTo.current = props.focusId;
    document.getElementById(`request-${props.focusId}`)?.scrollIntoView({ block: 'center' });
  }, [props.focusId, focusLoaded]);

  useEffect(() => {
    if (!props.requests.some((request) => request.status === 'pending_approval' && request.approval)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [props.requests]);

  const canApprove = Boolean(props.wallet && props.wallet === props.owner);
  const recentRequests = props.requests.slice(0, 6);
  const visibleRequests = showAll
    ? props.requests
    : [
        ...recentRequests,
        ...props.requests.filter(
          (request) =>
            (request.status === 'pending_approval' || request.id === props.focusId) &&
            !recentRequests.some((recent) => recent.id === request.id),
        ),
      ];

  return (
    <Card
      title={dict.requests.title}
      actions={<Badge variant="neutral" className="font-mono">{props.requests.length}</Badge>}
    >
      {props.requests.length === 0 ? (
        <Empty>{dict.requests.noRequests}</Empty>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {visibleRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              now={now}
              focused={request.id === props.focusId}
              canApprove={canApprove}
              busy={props.busyId === request.id}
              onApprove={props.onApprove}
              onCancel={props.onCancel}
            />
          ))}
        </ul>
      )}
      {props.requests.length > 6 ? (
        <Button type="button" variant="link" size="sm" className="text-xs" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? dict.requests.showRecent
            : interpolate(dict.requests.showAll, { count: props.requests.length })}
        </Button>
      ) : null}
    </Card>
  );
}
