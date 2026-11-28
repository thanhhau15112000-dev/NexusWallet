import {
  MAX_DELIVERY_ATTEMPTS,
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
} from '@nexus/shared';
import { CheckCircle2, Clock, XCircle } from '../icons.js';
import { Card, DateTime, Empty, Mono, Notice, Pill, shorten } from '../ui.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../i18n/context.js';
import { amountOf, explorerTx } from './units.js';

function RejectedHistory(props: { rejectedList: NonNullable<TaskPaymentRecord['rejectedDeliveries']> }) {
  const { dict, interpolate } = useI18n();
  if (props.rejectedList.length === 0) return null;

  return (
    <details className="rounded-md border border-line bg-panel px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted hover:text-ink">
        {interpolate(dict.taskVault.escrows.rejectedHistory, { count: props.rejectedList.length })}
      </summary>
      <ul className="mt-2 space-y-2 border-t border-line pt-2">
        {props.rejectedList.map((item) => (
          <li key={`${item.attempt}-${item.resultHash}`} className="space-y-1 text-muted">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">
                {interpolate(dict.taskVault.escrows.attemptLabel, {
                  attempt: item.attempt,
                  max: MAX_DELIVERY_ATTEMPTS,
                })}
              </span>
              <DateTime value={item.rejectedAt} />
            </div>
            <Mono title={item.resultHash} className="block">
              {shorten(item.resultHash, 8)}
            </Mono>
            {item.rejectReason ? <p className="text-bad">{item.rejectReason}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function EscrowListCard(props: {
  task: TaskCapabilityRecord;
  payments: TaskPaymentRecord[];
  receipts: TaskReceiptRecord[];
  nowSeconds: number;
  busyAction: string | null;
  locked: boolean;
  paymentActionsLocked: boolean;
  receiptsClosable: boolean;
  reviewedOutputs: Set<string>;
  rejectReasons: Record<string, string>;
  allowedMints: { label: string; address: string }[];
  reviewKey: (payment: TaskPaymentRecord) => string;
  onToggleReviewed: (payment: TaskPaymentRecord, checked: boolean) => void;
  onRejectReasonChange: (paymentId: string, reason: string) => void;
  onAcceptPayment: (payment: TaskPaymentRecord) => void;
  onRejectOutput: (payment: TaskPaymentRecord) => void;
  onSubmitMockOutput: (paymentId: string, scenario: 'valid' | 'invalid_schema') => void;
  onRefundExpiredEscrow: (payment: TaskPaymentRecord) => void;
  onCloseReceipt: (paymentId: string, worker: string) => void;
}) {
  const { dict, interpolate } = useI18n();
  const isExpired = props.nowSeconds >= props.task.expiry;

  const checkLabel = (id: string) => {
    switch (id) {
      case 'status_ok':
        return dict.taskVault.escrows.check_status_ok;
      case 'service_match':
        return dict.taskVault.escrows.check_service_match;
      case 'content_present':
        return dict.taskVault.escrows.check_content_present;
      case 'timestamp_valid':
        return dict.taskVault.escrows.check_timestamp_valid;
      case 'request_binding':
        return dict.taskVault.escrows.check_request_binding;
      default:
        return id;
    }
  };

  const renderPaymentAction = (p: TaskPaymentRecord) => {
    const receipt = props.receipts.find((r) => r.paymentId === p.paymentId);
    const rejectedList = p.rejectedDeliveries ?? [];

    if (receipt) {
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={13} className="text-accent" />
              <Mono title={receipt.resultHash}>
                {dict.taskVault.escrows.proof} {shorten(receipt.resultHash, 4)}
              </Mono>
            </span>
            <span className="text-muted">
              {dict.taskVault.escrows.settledAt} <DateTime value={receipt.settledAt * 1000} />
            </span>
            {receipt.txSignature ? (
              <a href={explorerTx(receipt.txSignature)} target="_blank" rel="noreferrer">
                <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
              </a>
            ) : (
              <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>
            )}
            {receipt.isSimulated === false && !receipt.isClosed && props.task.isClosed ? (
              <span className="text-muted" title={dict.taskVault.escrows.receiptWorkerOnlyHint}>
                {dict.taskVault.escrows.receiptWorkerOnly}
              </span>
            ) : receipt.isSimulated === false && !receipt.isClosed && !props.receiptsClosable ? (
              <span className="text-muted" title={dict.taskVault.escrows.receiptLockedHint}>
                {dict.taskVault.escrows.receiptLocked}
              </span>
            ) : receipt.isSimulated === false && !receipt.isClosed ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                title={dict.taskVault.escrows.closeReceiptHint}
                disabled={Boolean(props.busyAction) || props.locked}
                onClick={() => props.onCloseReceipt(receipt.paymentId, receipt.worker)}
              >
                <XCircle size={13} />
                {props.busyAction === `close-receipt-${receipt.paymentId}`
                  ? dict.taskVault.escrows.closingReceipt
                  : dict.taskVault.escrows.closeReceipt}
              </Button>
            ) : receipt.isClosed ? (
              <span className="text-muted">{dict.taskVault.escrows.receiptClosed}</span>
            ) : null}
          </div>
          <RejectedHistory rejectedList={rejectedList} />
        </div>
      );
    }

    if (p.status === 'held' && isExpired && !props.task.isClosed) {
      return (
        <div className="space-y-2.5 rounded-md border border-line bg-surface-muted/40 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted">{dict.taskVault.escrows.expiredEscrowNote}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(props.busyAction) || props.locked}
              onClick={() => props.onRefundExpiredEscrow(p)}
            >
              {props.busyAction === `refund-escrow-${p.paymentId}`
                ? dict.taskVault.escrows.refundingExpiredEscrow
                : dict.taskVault.escrows.refundExpiredEscrow}
            </Button>
          </div>
          {p.delivery ? (
            <details>
              <summary className="cursor-pointer font-medium text-ink">{dict.taskVault.escrows.reviewOutput}</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded border border-line bg-panel p-2 font-mono text-[11px]">
                {JSON.stringify(p.delivery.resultPayload, null, 2)}
              </pre>
            </details>
          ) : null}
          <RejectedHistory rejectedList={rejectedList} />
        </div>
      );
    }

    if (p.status === 'held' && p.delivery) {
      const reviewed = props.reviewedOutputs.has(props.reviewKey(p));
      const verification = p.delivery.verification;
      const verificationFailed = verification?.verdict === 'fail';
      const attempt = p.delivery.attempt ?? rejectedList.length + 1;
      return (
        <div className="space-y-2.5 rounded-md border border-line bg-surface-muted/40 p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink">
              {interpolate(dict.taskVault.escrows.attemptLabel, { attempt, max: MAX_DELIVERY_ATTEMPTS })}
            </span>
            {verification ? (
              <Pill tone={verificationFailed ? 'bad' : 'ok'}>
                {verificationFailed ? dict.taskVault.escrows.verificationFail : dict.taskVault.escrows.verificationPass}
              </Pill>
            ) : null}
          </div>

          {verification ? (
            <div className="space-y-1.5 rounded-md border border-line bg-panel p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">{dict.taskVault.escrows.verificationTitle}</span>
                <DateTime value={verification.checkedAt} />
              </div>
              <ul className="space-y-1">
                {verification.checks.map((check) => (
                  <li key={check.id} className="flex items-start justify-between gap-2">
                    <span className={cn('inline-flex items-center gap-1.5', check.passed ? 'text-ink' : 'text-bad')}>
                      {check.passed ? (
                        <CheckCircle2 size={12} className="shrink-0 text-accent" />
                      ) : (
                        <XCircle size={12} className="shrink-0 text-bad" />
                      )}
                      <span className="font-medium">{checkLabel(check.id)}</span>
                    </span>
                    <span className="text-right text-muted">{check.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <details open>
            <summary className="cursor-pointer font-medium text-ink">{dict.taskVault.escrows.reviewOutput}</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded border border-line bg-panel p-2 font-mono text-[11px]">
              {JSON.stringify(p.delivery.resultPayload, null, 2)}
            </pre>
          </details>
          <Mono title={p.delivery.resultHash} className="block text-muted">
            {shorten(p.delivery.resultHash, 8)}
          </Mono>
          {verificationFailed ? (
            <Notice tone="bad" role="status">
              {dict.taskVault.escrows.verificationBlockedNote}
            </Notice>
          ) : (
            <p className="text-[11px] text-muted">{dict.taskVault.escrows.reviewLimitation}</p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label
              className={cn(
                'flex items-center gap-2',
                verificationFailed ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-ink',
              )}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={reviewed}
                disabled={Boolean(props.busyAction) || props.paymentActionsLocked || verificationFailed}
                onChange={(event) => props.onToggleReviewed(p, event.target.checked)}
              />
              <span>{dict.taskVault.escrows.reviewedConfirmation}</span>
            </label>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={Boolean(props.busyAction) || props.paymentActionsLocked || verificationFailed || !reviewed}
              onClick={() => props.onAcceptPayment(p)}
            >
              {props.busyAction === `settle-${p.paymentId}`
                ? dict.taskVault.escrows.settling
                : dict.taskVault.escrows.acceptAndSettle}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            <Input
              type="text"
              className="h-8 flex-1 text-xs"
              value={props.rejectReasons[p.paymentId] ?? ''}
              disabled={Boolean(props.busyAction) || props.paymentActionsLocked}
              onChange={(event) => props.onRejectReasonChange(p.paymentId, event.target.value)}
              placeholder={dict.taskVault.escrows.rejectReasonPlaceholder}
            />
            <Button
              type="button"
              variant="destructiveOutline"
              size="sm"
              disabled={Boolean(props.busyAction) || props.paymentActionsLocked}
              onClick={() => props.onRejectOutput(p)}
            >
              {props.busyAction === `reject-${p.paymentId}`
                ? dict.taskVault.escrows.rejectingOutput
                : dict.taskVault.escrows.rejectOutput}
            </Button>
          </div>
          <RejectedHistory rejectedList={rejectedList} />
        </div>
      );
    }

    if (p.status === 'held') {
      const exhausted = rejectedList.length >= MAX_DELIVERY_ATTEMPTS;
      return (
        <div className="space-y-2.5">
          {exhausted ? (
            <Notice tone="warn" role="status">
              {interpolate(dict.taskVault.escrows.maxAttemptsReached, { max: MAX_DELIVERY_ATTEMPTS })}
            </Notice>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(props.busyAction) || props.paymentActionsLocked}
                onClick={() => props.onSubmitMockOutput(p.paymentId, 'valid')}
              >
                {props.busyAction === `output-valid-${p.paymentId}`
                  ? dict.taskVault.escrows.submittingOutput
                  : dict.taskVault.escrows.submitValidOutput}
              </Button>
              <Button
                type="button"
                variant="destructiveOutline"
                size="sm"
                disabled={Boolean(props.busyAction) || props.paymentActionsLocked}
                onClick={() => props.onSubmitMockOutput(p.paymentId, 'invalid_schema')}
              >
                {props.busyAction === `output-invalid_schema-${p.paymentId}`
                  ? dict.taskVault.escrows.submittingOutput
                  : dict.taskVault.escrows.submitInvalidOutput}
              </Button>
            </div>
          )}
          <RejectedHistory rejectedList={rejectedList} />
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{dict.taskVault.escrows.refunded}</span>
          {p.refundTxSignature ? (
            <a href={explorerTx(p.refundTxSignature)} target="_blank" rel="noreferrer">
              <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
            </a>
          ) : null}
        </div>
        <RejectedHistory rejectedList={rejectedList} />
      </div>
    );
  };

  return (
    <Card
      title={dict.taskVault.escrows.title}
      titleIcon={<Clock size={15} />}
      actions={props.payments.length > 0 ? <Pill tone="neutral">{props.payments.length}</Pill> : null}
    >
      {props.payments.length === 0 ? (
        <Empty>{dict.taskVault.escrows.empty}</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {props.payments.map((p) => (
            <li key={p.paymentId} className="space-y-3 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono className="text-sm font-medium text-ink">{p.paymentId}</Mono>
                    <Pill tone={p.status === 'settled' ? 'ok' : p.status === 'refunded' ? 'neutral' : 'warn'}>
                      {dict.taskVault.escrowStatuses[p.status]}
                    </Pill>
                    {p.txSignature ? (
                      <a href={explorerTx(p.txSignature)} target="_blank" rel="noreferrer">
                        <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
                      </a>
                    ) : (
                      <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <span>{p.serviceId}</span>
                    <span aria-hidden="true">·</span>
                    <span title={p.worker}>
                      {dict.taskVault.escrows.colWorker} {shorten(p.worker, 4)}
                    </span>
                    {p.createdAt ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <DateTime value={p.createdAt} />
                      </>
                    ) : null}
                  </span>
                </div>
                <strong className="whitespace-nowrap text-sm font-semibold text-ink tabular-nums">
                  {amountOf(p.amountLamports, props.task, props.allowedMints)}
                </strong>
              </div>
              {renderPaymentAction(p)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
