import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from './icons.js';
import { LAMPORTS_PER_SOL, type PaymentRequest, type RequestStatus } from '@nexus/shared';
import { Card, Empty, Mono, Pill, shorten } from './ui.js';
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

function formatTrace(request: PaymentRequest): string {
  const trace = request.modelTrace;
  if (!trace) return '-';
  return `${trace.stage1.name}:${trace.stage1.model} ${trace.stage1.ms}ms → ${trace.stage2.name}:${trace.stage2.model} ${trace.stage2.ms}ms`;
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
    <li id={`request-${request.id}`} className={props.focused ? 'request focused' : 'request'}>
      <div className="request-head">
        <Pill tone={TONE[displayedStatus]}>{dict.requests.statuses[displayedStatus]}</Pill>
        <span className="prompt">{request.prompt}</span>
        <Mono title={request.id}>{shorten(request.id, 5)}</Mono>
      </div>

      <div className="request-summary">
        <Mono>{describeAction(request, dict.requests.actions)}</Mono>
        {request.execution ? (
          <a href={request.execution.explorerUrl} target="_blank" rel="noreferrer" className="link">
            {dict.requests.explorer}
          </a>
        ) : null}
      </div>

      {request.error ? (
        <p className="request-error">{localizeError(request.error, dict.requests.errors, interpolate)}</p>
      ) : null}
      {approvalExpired ? <p className="request-error">{dict.requests.expiredNotice}</p> : null}

      {request.status === 'pending_approval' && request.approval && !approvalExpired ? (
        <div className="approval">
          <div className="approval-bar">
            <button
              type="button"
              className="primary button-with-icon"
              disabled={!props.canApprove || props.busy}
              onClick={() => props.onApprove(request)}
            >
              {props.busy ? dict.requests.waitingForWallet : dict.requests.approve}
              <ShieldCheck size={15} aria-hidden="true" />
            </button>
            <button type="button" className="danger-outline" disabled={props.busy} onClick={() => props.onCancel(request)}>
              {dict.requests.cancel}
            </button>
            <span className="hint">
              {dict.requests.expires} {new Date(request.approval.payload.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          {!props.canApprove ? <p className="hint warn">{dict.requests.connectOwnerWallet}</p> : null}
          <details className="request-details">
            <summary>{dict.requests.message}</summary>
            <pre>{request.approval.message}</pre>
          </details>
        </div>
      ) : null}

      {request.approval?.signature ? (
        <p className="hint">
          {dict.requests.approvedBy} <Mono>{shorten(request.approval.signerPubkey ?? '', 6)}</Mono>{' '}
          {new Date(request.approval.signedAt ?? '').toLocaleTimeString()}
        </p>
      ) : null}

      <details className="request-details">
        <summary>{dict.requests.details}</summary>
        <div className="detail-grid">
          {decision ? (
            <div>
              <span className="tag">{dict.requests.policyTag} v{decision.policyVersion}</span>
              <Pill tone={verdictTone(decision.verdict)}>{decision.verdict}</Pill>
              <span className="reasons">{decision.reasons.join('; ')}</span>
            </div>
          ) : null}
          <div>
            <span className="tag">{dict.requests.modelsTag}</span>
            <Mono>{formatTrace(request)}</Mono>
          </div>
          {request.balanceLamports !== null ? (
            <div>
              <span className="tag">{dict.requests.balanceTag}</span>
              <Mono>{(request.balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL</Mono>
            </div>
          ) : null}
          {request.execution ? (
            <div>
              <span className="tag">{dict.requests.signatureTag}</span>
              <a href={request.execution.explorerUrl} target="_blank" rel="noreferrer" className="mono">
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
      className="panel-requests"
      actions={<span className="version">{props.requests.length}</span>}
    >
      {props.requests.length === 0 ? (
        <Empty>{dict.requests.noRequests}</Empty>
      ) : (
        <ul className="request-list">
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
        <button type="button" className="link list-toggle" onClick={() => setShowAll(!showAll)}>
          {showAll
            ? dict.requests.showRecent
            : interpolate(dict.requests.showAll, { count: props.requests.length })}
        </button>
      ) : null}
    </Card>
  );
}
