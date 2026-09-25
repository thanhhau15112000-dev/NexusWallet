import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { LAMPORTS_PER_SOL, type PaymentRequest, type RequestStatus } from '@nexus/shared';
import { Card, Empty, Mono, Pill, shorten } from './ui.js';

const TONE: Record<RequestStatus, string> = {
  planned: 'neutral',
  auto_approved: 'ok',
  pending_approval: 'warn',
  approved: 'ok',
  confirmed: 'ok',
  failed: 'bad',
  denied: 'bad',
  expired: 'bad',
};

const LABEL: Record<RequestStatus, string> = {
  planned: 'Queued',
  auto_approved: 'Auto',
  pending_approval: 'Approval',
  approved: 'Approved',
  confirmed: 'Confirmed',
  failed: 'Failed',
  denied: 'Denied',
  expired: 'Expired',
};

function verdictTone(verdict: string): string {
  if (verdict === 'allow') return 'ok';
  if (verdict === 'require_approval') return 'warn';
  return 'bad';
}

function describeAction(request: PaymentRequest): string {
  const action = request.plan?.action;
  if (!action) return '-';
  switch (action.type) {
    case 'transfer_sol':
      return `${action.amountSol} SOL → ${shorten(action.recipient, 6)}`;
    case 'transfer_spl':
      return `${action.amount} ${shorten(action.mint, 4)} → ${shorten(action.recipient, 6)}`;
    case 'get_balance':
      return 'Balance';
    case 'request_manual_approval':
      return 'Manual approval';
  }
}

function formatTrace(request: PaymentRequest): string {
  const trace = request.modelTrace;
  if (!trace) return '-';
  return `${trace.stage1.name}:${trace.stage1.model} ${trace.stage1.ms}ms → ${trace.stage2.name}:${trace.stage2.model} ${trace.stage2.ms}ms`;
}

function RequestRow(props: {
  request: PaymentRequest;
  canApprove: boolean;
  busy: boolean;
  onApprove: (request: PaymentRequest) => void;
}) {
  const { request } = props;
  const decision = request.decision;

  return (
    <li className="request">
      <div className="request-head">
        <Pill tone={TONE[request.status]}>{LABEL[request.status]}</Pill>
        <span className="prompt">{request.prompt}</span>
        <Mono title={request.id}>{shorten(request.id, 5)}</Mono>
      </div>

      <div className="request-summary">
        <Mono>{describeAction(request)}</Mono>
        {request.execution ? (
          <a href={request.execution.explorerUrl} target="_blank" rel="noreferrer" className="link">
            Explorer ↗
          </a>
        ) : null}
      </div>

      {request.error ? <p className="request-error">{request.error.message}</p> : null}

      {request.status === 'pending_approval' && request.approval ? (
        <div className="approval">
          <div className="approval-bar">
            <button
              type="button"
              className="primary button-with-icon"
              disabled={!props.canApprove || props.busy}
              onClick={() => props.onApprove(request)}
            >
              {props.busy ? 'Waiting for wallet' : 'Approve'}
              <ShieldCheck size={15} aria-hidden="true" />
            </button>
            <span className="hint">
              Expires {new Date(request.approval.payload.expiresAt).toLocaleTimeString()}
            </span>
          </div>
          {!props.canApprove ? <p className="hint warn">Connect owner wallet</p> : null}
          <details className="request-details">
            <summary>Message</summary>
            <pre>{request.approval.message}</pre>
          </details>
        </div>
      ) : null}

      {request.approval?.signature ? (
        <p className="hint">
          Approved <Mono>{shorten(request.approval.signerPubkey ?? '', 6)}</Mono>{' '}
          {new Date(request.approval.signedAt ?? '').toLocaleTimeString()}
        </p>
      ) : null}

      <details className="request-details">
        <summary>Details</summary>
        <div className="detail-grid">
          {decision ? (
            <div>
              <span className="tag">Policy v{decision.policyVersion}</span>
              <Pill tone={verdictTone(decision.verdict)}>{decision.verdict}</Pill>
              <span className="reasons">{decision.reasons.join('; ')}</span>
            </div>
          ) : null}
          <div>
            <span className="tag">Models</span>
            <Mono>{formatTrace(request)}</Mono>
          </div>
          {request.balanceLamports !== null ? (
            <div>
              <span className="tag">Balance</span>
              <Mono>{(request.balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL</Mono>
            </div>
          ) : null}
          {request.execution ? (
            <div>
              <span className="tag">Signature</span>
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
  onApprove: (request: PaymentRequest) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const canApprove = Boolean(props.wallet && props.wallet === props.owner);
  const recentRequests = props.requests.slice(0, 6);
  const visibleRequests = showAll
    ? props.requests
    : [
        ...recentRequests,
        ...props.requests.filter(
          (request) =>
            request.status === 'pending_approval' &&
            !recentRequests.some((recent) => recent.id === request.id),
        ),
      ];

  return (
    <Card
      title="Requests"
      className="panel-requests"
      actions={<span className="version">{props.requests.length}</span>}
    >
      {props.requests.length === 0 ? (
        <Empty>No requests</Empty>
      ) : (
        <ul className="request-list">
          {visibleRequests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              canApprove={canApprove}
              busy={props.busyId === request.id}
              onApprove={props.onApprove}
            />
          ))}
        </ul>
      )}
      {props.requests.length > 6 ? (
        <button type="button" className="link list-toggle" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show recent' : `Show all ${props.requests.length}`}
        </button>
      ) : null}
    </Card>
  );
}
