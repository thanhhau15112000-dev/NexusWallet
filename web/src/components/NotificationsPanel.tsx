import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Copy, ExternalLink, RefreshCw, Send, Unplug } from './icons.js';
import {
  api,
  type TelegramLinkTokenResponse,
  type TelegramNotificationState,
} from '../api.js';
import { useI18n } from '../i18n/context.js';
import { cn } from '../lib/utils.js';
import { Card, DateTime, Notice, Pill } from './ui.js';
import { Button } from './ui/button.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function ToggleRow(props: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg border border-line bg-panel px-3.5 py-3',
        props.disabled ? 'opacity-60' : null,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={props.id} className="block cursor-pointer text-sm font-medium text-ink">
          {props.label}
        </label>
        <p className="text-xs text-muted">{props.hint}</p>
      </div>
      <button
        id={props.id}
        type="button"
        role="switch"
        aria-checked={props.checked}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed',
          props.checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-muted',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white transition-transform',
            props.checked ? 'translate-x-5.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

export function NotificationsPanel(props: {
  active: boolean;
  onToast: (toast: Toast) => void;
}) {
  const { dict, interpolate } = useI18n();
  const [data, setData] = useState<TelegramNotificationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<TelegramLinkTokenResponse | null>(null);
  const [copied, setCopied] = useState<'command' | 'link' | null>(null);
  const [busyAction, setBusyAction] = useState<'link' | 'test' | 'unlink' | 'save' | null>(null);

  const [enabled, setEnabled] = useState(true);
  const [pendingApproval, setPendingApproval] = useState(true);
  const [dirty, setDirty] = useState(false);

  const syncFromState = useCallback(
    (next: TelegramNotificationState, preserveDraft: boolean) => {
      setData(next);
      if (!preserveDraft) {
        setEnabled(next.settings.enabled);
        setPendingApproval(next.settings.events.pendingApproval);
      }
      if (next.settings.chatId) {
        setLinkToken(null);
      }
    },
    [],
  );

  const load = useCallback(
    async (preserveDraft = false) => {
      try {
        const next = await api.telegramNotifications();
        syncFromState(next, preserveDraft);
        setLoadError(null);
        return next;
      } catch (err) {
        setLoadError(errorText(err, dict.notifications.loadFailed));
        return null;
      } finally {
        setLoading(false);
      }
    },
    [dict.notifications.loadFailed, syncFromState],
  );

  useEffect(() => {
    if (!props.active) return;
    void load(dirty);
  }, [props.active, load, dirty]);

  // Poll until the user confirms /start <token> in Telegram or the link expires.
  useEffect(() => {
    if (!props.active || !linkToken) return;
    const expiresAtMs = new Date(linkToken.expiresAt).getTime();
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (Date.now() >= expiresAtMs) {
        if (!cancelled) {
          setLinkToken(null);
          props.onToast({ tone: 'warn', text: dict.notifications.linkExpired });
        }
        return;
      }
      void api
        .telegramNotifications()
        .then((next) => {
          if (cancelled) return;
          if (next.settings.chatId) {
            syncFromState(next, dirty);
            setLinkToken(null);
            props.onToast({ tone: 'ok', text: dict.notifications.connectedToast });
          }
        })
        .catch(() => undefined);
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.active, linkToken, dirty, dict.notifications.connectedToast, dict.notifications.linkExpired, props, syncFromState]);

  const startConnect = async () => {
    setBusyAction('link');
    try {
      const nextLink = await api.createTelegramLinkToken();
      setLinkToken(nextLink);
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.notifications.linkFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const copyText = async (target: 'command' | 'link', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(target);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      props.onToast({ tone: 'bad', text: dict.mcp.clipboardUnavailable });
    }
  };

  const sendTest = async () => {
    setBusyAction('test');
    try {
      await api.sendTelegramTest();
      await load(dirty);
      props.onToast({ tone: 'ok', text: dict.notifications.testSent });
    } catch (err) {
      await load(dirty);
      props.onToast({ tone: 'bad', text: errorText(err, dict.notifications.testFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const disconnect = async () => {
    setBusyAction('unlink');
    try {
      const res = await api.unlinkTelegram();
      if (data) {
        syncFromState({ ...data, settings: res.settings }, dirty);
      } else {
        await load(dirty);
      }
      setLinkToken(null);
      props.onToast({ tone: 'warn', text: dict.notifications.disconnectedToast });
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.notifications.disconnectFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const saveSettings = async () => {
    setBusyAction('save');
    try {
      const res = await api.updateTelegramNotifications({
        enabled,
        events: { pendingApproval },
      });
      setDirty(false);
      if (data) {
        syncFromState({ ...data, settings: res.settings }, false);
      } else {
        await load(false);
      }
      props.onToast({ tone: 'ok', text: dict.notifications.savedToast });
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.notifications.saveFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const settings = data?.settings;
  const linked = Boolean(settings?.chatId);
  const botConfigured = Boolean(data?.botConfigured);
  const startCommand = linkToken
    ? linkToken.startCommand || `/start ${new URL(linkToken.deepLink).searchParams.get('start') ?? ''}`
    : null;

  const statusBadge = !data ? null : !botConfigured ? (
    <Pill tone="warn">{dict.notifications.statusUnconfigured}</Pill>
  ) : linked ? (
    <Pill tone="ok">{dict.notifications.statusConnected}</Pill>
  ) : (
    <Pill tone="neutral">{dict.notifications.statusNotConnected}</Pill>
  );

  return (
    <div className="space-y-4">
      <Card
        title={dict.notifications.connectionTitle}
        titleIcon={<Bell size={15} />}
        actions={statusBadge}
      >
        {loading ? (
          <p className="text-xs text-muted">{dict.notifications.loading}</p>
        ) : loadError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Notice tone="bad">{loadError}</Notice>
            <Button type="button" variant="outline" size="sm" onClick={() => void load(dirty)}>
              <RefreshCw size={13} aria-hidden="true" />
              {dict.notifications.retry}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {!botConfigured ? (
              <Notice tone="warn">{dict.notifications.botNotConfiguredNote}</Notice>
            ) : null}

            {linked && settings ? (
              <div className="space-y-3">
                <div className="grid gap-3 rounded-lg border border-line bg-surface-muted/50 p-3.5 sm:grid-cols-2">
                  <div>
                    <div className="text-xs font-medium text-muted">{dict.notifications.accountLabel}</div>
                    <div className="mt-1 text-sm font-semibold text-ink">
                      {settings.username ? `@${settings.username}` : dict.notifications.noUsername}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-muted">{dict.notifications.linkedAtLabel}</div>
                    <div className="mt-1 text-sm text-ink">
                      <DateTime value={settings.linkedAt} />
                    </div>
                  </div>
                </div>

                {settings.lastError ? (
                  <Notice tone="bad">
                    {interpolate(dict.notifications.deliveryError, { error: settings.lastError })}
                  </Notice>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={!botConfigured || busyAction !== null}
                    onClick={() => void sendTest()}
                  >
                    <Send size={13} aria-hidden="true" />
                    {busyAction === 'test' ? dict.notifications.sendingTest : dict.notifications.sendTest}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!botConfigured || busyAction !== null}
                    onClick={() => void startConnect()}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    {dict.notifications.reconnect}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => void disconnect()}
                  >
                    <Unplug size={13} aria-hidden="true" />
                    {busyAction === 'unlink' ? dict.notifications.disconnecting : dict.notifications.disconnect}
                  </Button>
                </div>
              </div>
            ) : null}

            {!linked && botConfigured && !linkToken ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted/40 p-3.5">
                <p className="text-xs text-muted">{dict.notifications.connectPrompt}</p>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={busyAction !== null}
                  onClick={() => void startConnect()}
                >
                  {busyAction === 'link' ? dict.notifications.generatingLink : dict.notifications.connectBtn}
                </Button>
              </div>
            ) : null}

            {linkToken && startCommand ? (
              <div className="space-y-3 rounded-lg border border-accent-line bg-accent-soft/40 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-accent-strong">
                    {interpolate(dict.notifications.linkReadyTitle, { bot: `@${linkToken.botUsername}` })}
                  </span>
                  <span className="text-xs text-muted">
                    {dict.notifications.expiresAtLabel}{' '}
                    <DateTime value={linkToken.expiresAt} />
                  </span>
                </div>
                <p className="text-xs text-ink">{dict.notifications.linkInstructions}</p>
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel px-3 py-2">
                    <code className="truncate font-mono text-xs text-ink">{startCommand}</code>
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      onClick={() => void copyText('command', startCommand)}
                    >
                      {copied === 'command' ? (
                        <Check size={13} aria-hidden="true" />
                      ) : (
                        <Copy size={13} aria-hidden="true" />
                      )}
                      {copied === 'command' ? dict.mcp.copied : dict.notifications.copyCommand}
                    </Button>
                  </div>
                  <p className="text-xs text-muted">
                    {interpolate(dict.notifications.commandHint, { bot: `@${linkToken.botUsername}` })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <a href={linkToken.deepLink} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} aria-hidden="true" />
                      {dict.notifications.openTelegram}
                    </a>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <a
                      href={`https://web.telegram.org/a/#@${linkToken.botUsername}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={13} aria-hidden="true" />
                      {dict.notifications.openTelegramWeb}
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyText('link', linkToken.deepLink)}
                  >
                    {copied === 'link' ? (
                      <Check size={13} className="text-accent" aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    {copied === 'link' ? dict.mcp.copied : dict.notifications.copyLink}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setLinkToken(null)}
                  >
                    {dict.notifications.cancelLink}
                  </Button>
                </div>
                <p className="text-xs text-muted">{dict.notifications.waitingForStart}</p>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Card
        title={dict.notifications.settingsTitle}
        actions={
          dirty ? (
            <span className="text-xs font-medium text-warn">{dict.notifications.unsaved}</span>
          ) : null
        }
      >
        <div className="space-y-2.5">
          <ToggleRow
            id="telegram-enabled-switch"
            label={dict.notifications.masterToggleLabel}
            hint={dict.notifications.masterToggleHint}
            checked={enabled}
            disabled={loading || busyAction !== null}
            onChange={(next) => {
              setEnabled(next);
              setDirty(true);
            }}
          />
          <ToggleRow
            id="telegram-pending-approval-switch"
            label={dict.notifications.pendingApprovalLabel}
            hint={dict.notifications.pendingApprovalHint}
            checked={pendingApproval}
            disabled={loading || !enabled || busyAction !== null}
            onChange={(next) => {
              setPendingApproval(next);
              setDirty(true);
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted">{dict.notifications.securityNote}</p>
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!dirty || loading || busyAction !== null}
            onClick={() => void saveSettings()}
          >
            {busyAction === 'save' ? dict.notifications.saving : dict.notifications.save}
          </Button>
        </div>
      </Card>
    </div>
  );
}
