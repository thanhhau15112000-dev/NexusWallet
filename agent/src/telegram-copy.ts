import {
  formatSol,
  type ResolvedAction,
  type TelegramAlertLanguage,
} from '@nexus/shared';
import type { AppContext } from './context.js';

export type TelegramAlertCopy = {
  approvalTitle: string;
  approvalDefaultReason: string;
  approvalCta: string;
  deniedTitle: string;
  deniedDefaultReason: string;
  confirmedTitle: string;
  confirmedCta: string;
  failedTitle: string;
  failedDefaultReason: string;
  expiredTitle: string;
  testBody: string;
  openDashboardCta: string;
  amount: string;
  recipient: string;
  reason: string;
  request: string;
  expires: string;
  expiredAt: string;
  command: string;
  signature: string;
};

export const ALERT_COPY: Record<TelegramAlertLanguage, TelegramAlertCopy> = {
  en: {
    approvalTitle: 'nexusPay: Approval required',
    approvalDefaultReason: 'Owner approval required',
    approvalCta: 'Review & approve in nexusPay',
    deniedTitle: 'nexusPay: Transfer blocked',
    deniedDefaultReason: 'Blocked by policy',
    confirmedTitle: 'nexusPay: Transfer confirmed',
    confirmedCta: 'View on Solana Explorer',
    failedTitle: 'nexusPay: Transfer failed',
    failedDefaultReason: 'Transaction execution failed',
    expiredTitle: 'nexusPay: Approval expired',
    testBody: 'nexusPay test notification: configured alerts will be delivered to this chat.',
    openDashboardCta: 'Open nexusPay',
    amount: 'Amount',
    recipient: 'Recipient',
    reason: 'Reason',
    request: 'Request',
    expires: 'Expires',
    expiredAt: 'Expired at',
    command: 'Command',
    signature: 'Signature',
  },
  vi: {
    approvalTitle: 'nexusPay: Cần duyệt giao dịch',
    approvalDefaultReason: 'Cần chủ ví ký duyệt',
    approvalCta: 'Xem & duyệt trên nexusPay',
    deniedTitle: 'nexusPay: Giao dịch bị chặn',
    deniedDefaultReason: 'Bị từ chối bởi chính sách',
    confirmedTitle: 'nexusPay: Giao dịch thành công',
    confirmedCta: 'Xem trên Solana Explorer',
    failedTitle: 'nexusPay: Giao dịch thất bại',
    failedDefaultReason: 'Thực thi giao dịch thất bại',
    expiredTitle: 'nexusPay: Yêu cầu duyệt hết hạn',
    testBody: 'Tin nhắn thử nghiệm từ nexusPay: các cảnh báo đã bật sẽ được gửi về đây.',
    openDashboardCta: 'Mở nexusPay',
    amount: 'Số tiền',
    recipient: 'Người nhận',
    reason: 'Lý do',
    request: 'Mã yêu cầu',
    expires: 'Hết hạn',
    expiredAt: 'Hết hạn lúc',
    command: 'Lệnh',
    signature: 'Chữ ký',
  },
};

export function formatRecipientLine(userCtx: AppContext, recipient: string): string {
  const matched = userCtx.store
    .getPolicy()
    .allowedRecipients.find((entry) => entry.address === recipient);
  return matched ? `${matched.label} (${recipient})` : recipient;
}

export function formatResolvedAmount(action: ResolvedAction | null | undefined): string | null {
  if (!action) return null;
  if (action.type === 'transfer_sol') return formatSol(action.lamports);
  if (action.type === 'transfer_spl') return `${action.amount} (${action.mint})`;
  return null;
}

export function formatResolvedRecipient(userCtx: AppContext, action: ResolvedAction | null | undefined): string | null {
  if (!action || action.type === 'get_balance') return null;
  return formatRecipientLine(userCtx, action.recipient);
}
