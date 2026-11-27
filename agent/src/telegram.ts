import { randomBytes } from 'node:crypto';
import {
  formatSol,
  type PaymentRequest,
  type ResolvedAction,
  type TelegramAlertLanguage,
  type TelegramNotificationEvents,
  type TelegramNotificationSettings,
} from '@nexus/shared';
import type { AppConfig } from './config.js';
import type { AppContext, OpsLogger } from './context.js';

const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;
const SEND_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_SECONDS = 25;
const POLL_FETCH_TIMEOUT_MS = 35_000;
const POLL_ERROR_BACKOFF_MS = 3_000;

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; blocked: boolean; error: string };

export type TelegramCta = {
  label: string;
  url: string;
};

type LinkTokenEntry = {
  ownerPubkey: string;
  expiresAt: number;
};

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number | string; type?: string };
    from?: { username?: string };
    text?: string;
  };
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
};

function isPublicHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:' &&
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '[::1]'
    );
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ALERT_COPY: Record<
  TelegramAlertLanguage,
  {
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
  }
> = {
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

function formatRecipientLine(userCtx: AppContext, recipient: string): string {
  const matched = userCtx.store
    .getPolicy()
    .allowedRecipients.find((entry) => entry.address === recipient);
  return matched ? `${matched.label} (${recipient})` : recipient;
}

function formatResolvedAmount(action: ResolvedAction | null | undefined): string | null {
  if (!action) return null;
  if (action.type === 'transfer_sol') return formatSol(action.lamports);
  if (action.type === 'transfer_spl') return `${action.amount} (${action.mint})`;
  return null;
}

function formatResolvedRecipient(userCtx: AppContext, action: ResolvedAction | null | undefined): string | null {
  if (!action || action.type === 'get_balance') return null;
  return formatRecipientLine(userCtx, action.recipient);
}

export class TelegramService {
  private readonly config: AppConfig;
  private readonly getUserContext: (ownerPubkey: string) => AppContext;
  private readonly log?: OpsLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly linkTokens = new Map<string, LinkTokenEntry>();
  private botUsername: string | null;
  private pollAbort: AbortController | null = null;
  private pollTask: Promise<void> | null = null;

  constructor(deps: {
    config: AppConfig;
    getUserContext: (ownerPubkey: string) => AppContext;
    log?: OpsLogger;
    fetchImpl?: typeof fetch;
    now?: () => number;
  }) {
    this.config = deps.config;
    this.getUserContext = deps.getUserContext;
    this.log = deps.log;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.botUsername = deps.config.telegramBotUsername || null;
  }

  isConfigured(): boolean {
    return Boolean(this.config.TELEGRAM_BOT_TOKEN);
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  getWebhookSecret(): string {
    return this.config.telegramWebhookSecret;
  }

  private dashboardOrigin(): string {
    return this.config.allowedOrigins[0] ?? 'http://localhost:5173';
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.config.TELEGRAM_BOT_TOKEN}/${method}`;
  }

  private async callApi<T>(
    method: string,
    payload?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ status: number; data: TelegramApiResponse<T> }> {
    const res = await this.fetchImpl(this.apiUrl(method), {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: signal ?? AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const text = await res.text();
    let data: TelegramApiResponse<T>;
    try {
      data = JSON.parse(text) as TelegramApiResponse<T>;
    } catch {
      data = { ok: false, error_code: res.status, description: text || res.statusText };
    }
    return { status: res.status, data };
  }

  async resolveBotUsername(): Promise<string> {
    if (this.botUsername) return this.botUsername;
    if (!this.isConfigured()) {
      throw new Error('Telegram bot token is not configured');
    }
    const { data } = await this.callApi<{ username?: string }>('getMe');
    const username = data.result?.username?.replace(/^@+/, '').trim();
    if (!data.ok || !username) {
      throw new Error(data.description ?? 'Could not resolve Telegram bot username');
    }
    this.botUsername = username;
    return username;
  }

  private purgeExpiredTokens(currentTime: number): void {
    for (const [token, entry] of this.linkTokens.entries()) {
      if (entry.expiresAt <= currentTime) {
        this.linkTokens.delete(token);
      }
    }
  }

  async createLinkToken(ownerPubkey: string): Promise<{
    token: string;
    deepLink: string;
    expiresAt: string;
    botUsername: string;
  }> {
    if (!this.isConfigured()) {
      throw new Error('Telegram bot token is not configured');
    }
    const botUsername = await this.resolveBotUsername();
    const currentTime = this.now();
    this.purgeExpiredTokens(currentTime);
    for (const [existingToken, entry] of this.linkTokens.entries()) {
      if (entry.ownerPubkey === ownerPubkey) {
        this.linkTokens.delete(existingToken);
      }
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAtMs = currentTime + LINK_TOKEN_TTL_MS;
    this.linkTokens.set(token, { ownerPubkey, expiresAt: expiresAtMs });

    return {
      token,
      deepLink: `https://t.me/${botUsername}?start=${token}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      botUsername,
    };
  }

  async sendMessage(
    chatId: string,
    text: string,
    cta?: TelegramCta,
    options?: { silent?: boolean },
  ): Promise<TelegramSendResult> {
    if (!this.isConfigured()) {
      return { ok: false, blocked: false, error: 'Telegram bot token is not configured' };
    }

    const useInlineButton = Boolean(cta && isPublicHttpsUrl(cta.url));
    const finalText = cta && !useInlineButton ? `${text}\n\n${cta.label}: ${cta.url}` : text;
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: finalText,
      disable_web_page_preview: true,
    };
    if (options?.silent) {
      payload.disable_notification = true;
    }
    if (cta && useInlineButton) {
      payload.reply_markup = {
        inline_keyboard: [[{ text: cta.label, url: cta.url }]],
      };
    }

    try {
      const { status, data } = await this.callApi('sendMessage', payload);
      if (status >= 200 && status < 300 && data.ok) {
        return { ok: true };
      }
      const blocked = status === 403 || data.error_code === 403;
      const error = data.description ?? `Telegram HTTP ${status}`;
      return { ok: false, blocked, error };
    } catch (err) {
      return { ok: false, blocked: false, error: errorMessage(err) };
    }
  }

  async handleUpdate(
    raw: unknown,
  ): Promise<{ handled: boolean; action?: 'linked' | 'invalid_token' | 'help' | 'ignored' }> {
    const update = raw as TelegramUpdate | null | undefined;
    const message = update?.message;
    if (!message || typeof message.text !== 'string' || message.chat?.type !== 'private') {
      return { handled: false, action: 'ignored' };
    }
    if (message.chat.id === undefined || message.chat.id === null) {
      return { handled: false, action: 'ignored' };
    }

    const match = /^\/start(?:@\w+)?(?:\s+([A-Za-z0-9_-]{1,64}))?$/i.exec(message.text.trim());
    if (!match) {
      return { handled: false, action: 'ignored' };
    }

    const chatId = String(message.chat.id);
    const token = match[1];
    if (!token) {
      await this.sendMessage(
        chatId,
        'To connect your wallet, open the Notifications tab in nexusPay and select Connect Telegram.',
      );
      return { handled: true, action: 'help' };
    }

    const entry = this.linkTokens.get(token);
    this.linkTokens.delete(token);
    if (!entry || entry.expiresAt <= this.now()) {
      await this.sendMessage(
        chatId,
        'This connection link is invalid or has expired. Generate a new link in nexusPay and try again.',
      );
      return { handled: true, action: 'invalid_token' };
    }

    const userCtx = this.getUserContext(entry.ownerPubkey);
    const username =
      typeof message.from?.username === 'string' && message.from.username.trim()
        ? message.from.username.trim().replace(/^@+/, '')
        : null;

    userCtx.store.linkTelegram({ chatId, username });
    userCtx.audit.record('notifications.telegram_linked', null, { username });

    await this.sendMessage(
      chatId,
      'Connected to nexusPay. You will receive over-limit approval alerts here.',
    );
    return { handled: true, action: 'linked' };
  }

  private activeSettingsFor(
    userCtx: AppContext,
    event: keyof TelegramNotificationEvents,
  ): (TelegramNotificationSettings & { chatId: string }) | null {
    if (!this.isConfigured()) return null;
    const settings = userCtx.store.getNotificationSettings().telegram;
    if (!settings.enabled || !settings.events[event] || !settings.chatId) return null;
    return settings as TelegramNotificationSettings & { chatId: string };
  }

  private async deliverAlert(
    userCtx: AppContext,
    chatId: string,
    text: string,
    cta: TelegramCta | undefined,
    options: { silent?: boolean; requestId?: string },
  ): Promise<TelegramSendResult> {
    const result = await this.sendMessage(chatId, text, cta, { silent: options.silent });
    if (result.ok) {
      userCtx.store.setTelegramError(null);
    } else {
      const storedError = result.blocked
        ? 'Bot was blocked in Telegram. Unblock the bot or reconnect.'
        : result.error;
      userCtx.store.setTelegramError(storedError);
      if (options.requestId) {
        this.log?.warn(
          { requestId: options.requestId, blocked: result.blocked, error: result.error },
          'telegram.notify_failed',
        );
      }
    }
    return result;
  }

  async notifyApprovalRequired(userCtx: AppContext, request: PaymentRequest): Promise<void> {
    try {
      if (request.status !== 'pending_approval' || !request.approval) return;
      const settings = this.activeSettingsFor(userCtx, 'pendingApproval');
      if (!settings) return;

      const copy = ALERT_COPY[settings.language];
      const { payload } = request.approval;
      const amountLine =
        payload.actionType === 'transfer_sol'
          ? formatSol(payload.amount)
          : `${payload.amount} (${payload.mint})`;
      const recipientLine = formatRecipientLine(userCtx, payload.recipient);
      const reasons = request.decision?.reasons.length
        ? request.decision.reasons.join('; ')
        : copy.approvalDefaultReason;

      const text = [
        copy.approvalTitle,
        `${copy.amount}: ${amountLine}`,
        `${copy.recipient}: ${recipientLine}`,
        `${copy.reason}: ${reasons}`,
        `${copy.request}: ${request.id}`,
        `${copy.expires}: ${payload.expiresAt}`,
      ].join('\n');

      await this.deliverAlert(
        userCtx,
        settings.chatId,
        text,
        {
          label: copy.approvalCta,
          url: `${this.dashboardOrigin()}/?request=${encodeURIComponent(request.id)}`,
        },
        { silent: settings.silent, requestId: request.id },
      );
    } catch (err) {
      this.log?.warn(
        { requestId: request.id, error: errorMessage(err) },
        'telegram.notify_exception',
      );
    }
  }

  async notifyRequestDenied(userCtx: AppContext, request: PaymentRequest): Promise<void> {
    try {
      if (request.status !== 'denied') return;
      const settings = this.activeSettingsFor(userCtx, 'txDenied');
      if (!settings) return;

      const copy = ALERT_COPY[settings.language];
      const amountLine = formatResolvedAmount(request.decision?.resolved);
      const recipientLine = formatResolvedRecipient(userCtx, request.decision?.resolved);
      const reason =
        request.error?.message ||
        request.decision?.reasons.join('; ') ||
        copy.deniedDefaultReason;

      const lines = [copy.deniedTitle];
      if (amountLine) lines.push(`${copy.amount}: ${amountLine}`);
      if (recipientLine) lines.push(`${copy.recipient}: ${recipientLine}`);
      if (!amountLine && request.prompt) lines.push(`${copy.command}: ${request.prompt.slice(0, 120)}`);
      lines.push(`${copy.reason}: ${reason}`);
      lines.push(`${copy.request}: ${request.id}`);

      await this.deliverAlert(
        userCtx,
        settings.chatId,
        lines.join('\n'),
        { label: copy.openDashboardCta, url: this.dashboardOrigin() },
        { silent: settings.silent, requestId: request.id },
      );
    } catch (err) {
      this.log?.warn(
        { requestId: request.id, error: errorMessage(err) },
        'telegram.notify_exception',
      );
    }
  }

  async notifyTransactionConfirmed(userCtx: AppContext, request: PaymentRequest): Promise<void> {
    try {
      if (request.status !== 'confirmed' || !request.execution) return;
      if (request.decision?.resolved?.type === 'get_balance') return;
      const settings = this.activeSettingsFor(userCtx, 'txConfirmed');
      if (!settings) return;

      const copy = ALERT_COPY[settings.language];
      const amountLine = formatResolvedAmount(request.decision?.resolved);
      const recipientLine = formatResolvedRecipient(userCtx, request.decision?.resolved);
      const sig = request.execution.signature;
      const shortSig = sig.length > 16 ? `${sig.slice(0, 8)}...${sig.slice(-8)}` : sig;

      const lines = [copy.confirmedTitle];
      if (amountLine) lines.push(`${copy.amount}: ${amountLine}`);
      if (recipientLine) lines.push(`${copy.recipient}: ${recipientLine}`);
      lines.push(`${copy.signature}: ${shortSig}`);
      lines.push(`${copy.request}: ${request.id}`);

      await this.deliverAlert(
        userCtx,
        settings.chatId,
        lines.join('\n'),
        {
          label: copy.confirmedCta,
          url: request.execution.explorerUrl || this.dashboardOrigin(),
        },
        { silent: settings.silent, requestId: request.id },
      );
    } catch (err) {
      this.log?.warn(
        { requestId: request.id, error: errorMessage(err) },
        'telegram.notify_exception',
      );
    }
  }

  async notifyTransactionFailed(userCtx: AppContext, request: PaymentRequest): Promise<void> {
    try {
      if (request.status !== 'failed') return;
      const settings = this.activeSettingsFor(userCtx, 'txFailed');
      if (!settings) return;

      const copy = ALERT_COPY[settings.language];
      const amountLine = formatResolvedAmount(request.decision?.resolved);
      const recipientLine = formatResolvedRecipient(userCtx, request.decision?.resolved);
      const reason = request.error?.message || copy.failedDefaultReason;

      const lines = [copy.failedTitle];
      if (amountLine) lines.push(`${copy.amount}: ${amountLine}`);
      if (recipientLine) lines.push(`${copy.recipient}: ${recipientLine}`);
      lines.push(`${copy.reason}: ${reason}`);
      lines.push(`${copy.request}: ${request.id}`);

      await this.deliverAlert(
        userCtx,
        settings.chatId,
        lines.join('\n'),
        { label: copy.openDashboardCta, url: this.dashboardOrigin() },
        { silent: settings.silent, requestId: request.id },
      );
    } catch (err) {
      this.log?.warn(
        { requestId: request.id, error: errorMessage(err) },
        'telegram.notify_exception',
      );
    }
  }

  async notifyApprovalExpired(userCtx: AppContext, request: PaymentRequest): Promise<void> {
    try {
      if (request.status !== 'expired' || !request.approval) return;
      const settings = this.activeSettingsFor(userCtx, 'approvalExpired');
      if (!settings) return;

      const copy = ALERT_COPY[settings.language];
      const { payload } = request.approval;
      const amountLine =
        payload.actionType === 'transfer_sol'
          ? formatSol(payload.amount)
          : `${payload.amount} (${payload.mint})`;
      const recipientLine = formatRecipientLine(userCtx, payload.recipient);

      const text = [
        copy.expiredTitle,
        `${copy.amount}: ${amountLine}`,
        `${copy.recipient}: ${recipientLine}`,
        `${copy.request}: ${request.id}`,
        `${copy.expiredAt}: ${payload.expiresAt}`,
      ].join('\n');

      await this.deliverAlert(
        userCtx,
        settings.chatId,
        text,
        { label: copy.openDashboardCta, url: this.dashboardOrigin() },
        { silent: settings.silent, requestId: request.id },
      );
    } catch (err) {
      this.log?.warn(
        { requestId: request.id, error: errorMessage(err) },
        'telegram.notify_exception',
      );
    }
  }

  async sendTestNotification(userCtx: AppContext): Promise<TelegramSendResult> {
    const settings = userCtx.store.getNotificationSettings().telegram;
    if (!settings.chatId) {
      return { ok: false, blocked: false, error: 'Telegram is not connected' };
    }
    const copy = ALERT_COPY[settings.language];
    return this.deliverAlert(
      userCtx,
      settings.chatId,
      copy.testBody,
      { label: copy.openDashboardCta, url: this.dashboardOrigin() },
      { silent: settings.silent },
    );
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) return;

    try {
      await this.resolveBotUsername();
    } catch (err) {
      this.log?.warn({ error: errorMessage(err) }, 'telegram.get_me_failed');
    }

    if (this.config.DEPLOYMENT_MODE === 'hosted') {
      const webhookUrl = `${this.dashboardOrigin()}/api/webhooks/telegram`;
      try {
        const { status, data } = await this.callApi('setWebhook', {
          url: webhookUrl,
          secret_token: this.config.telegramWebhookSecret,
          allowed_updates: ['message'],
        });
        if (status < 200 || status >= 300 || !data.ok) {
          this.log?.warn(
            { status, error: data.description ?? 'setWebhook failed' },
            'telegram.set_webhook_failed',
          );
        }
      } catch (err) {
        this.log?.warn({ error: errorMessage(err) }, 'telegram.set_webhook_failed');
      }
      return;
    }

    if (this.pollAbort) return;
    try {
      await this.callApi('deleteWebhook', { drop_pending_updates: false });
    } catch (err) {
      this.log?.warn({ error: errorMessage(err) }, 'telegram.delete_webhook_failed');
    }

    const controller = new AbortController();
    this.pollAbort = controller;
    this.pollTask = this.runPollingLoop(controller.signal);
  }

  private async runPollingLoop(signal: AbortSignal): Promise<void> {
    let offset = 0;
    while (!signal.aborted) {
      try {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS)]);
        const { status, data } = await this.callApi<TelegramUpdate[]>(
          'getUpdates',
          {
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message'],
          },
          combined,
        );
        if (signal.aborted) break;
        if (status >= 200 && status < 300 && data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            if (typeof update.update_id === 'number') {
              offset = Math.max(offset, update.update_id + 1);
            }
            await this.handleUpdate(update);
          }
          continue;
        }
        this.log?.warn(
          { status, error: data.description ?? 'getUpdates failed' },
          'telegram.poll_failed',
        );
      } catch (err) {
        if (signal.aborted) break;
        this.log?.warn({ error: errorMessage(err) }, 'telegram.poll_error');
      }

      await delayWithAbort(POLL_ERROR_BACKOFF_MS, signal);
    }
  }

  stop(): void {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pollTask = null;
  }
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
