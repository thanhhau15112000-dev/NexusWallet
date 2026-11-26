import { useEffect, useState, type ReactNode } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, type PaymentRequest } from '@nexus/shared';
import { Bot, CheckCircle2, Lock, ShieldCheck, Unlock, Wallet } from './icons.js';
import { api, type AgentState } from '../api.js';
import { Card, CopyAddressButton, DateTime, Mono, Pill, shorten } from './ui.js';
import { Button } from './ui/button.js';
import { Card as ShadcnCard, CardContent } from './ui/card.js';
import { AgentFundingPanel } from './AgentFundingPanel.js';
import { cn } from '../lib/utils.js';
import { useI18n } from '../i18n/context.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

/** Polls the connected owner wallet's balance straight from the RPC every 6 seconds. */
function useOwnerBalance(rpcUrl: string, wallet: string | null) {
  const [lamports, setLamports] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLamports(null);
    setError(false);
    if (!wallet) {
      setLoading(false);
      return;
    }

    let connection: Connection;
    let address: PublicKey;
    try {
      connection = new Connection(rpcUrl, 'confirmed');
      address = new PublicKey(wallet);
    } catch {
      setLoading(false);
      setError(true);
      return;
    }

    let firstLoad = true;
    const load = async () => {
      if (firstLoad) setLoading(true);
      try {
        const next = await connection.getBalance(address, 'confirmed');
        if (cancelled) return;
        setLamports(next);
        setError(false);
      } catch {
        if (cancelled) return;
        setLamports(null);
        setError(true);
      } finally {
        if (!cancelled && firstLoad) setLoading(false);
        firstLoad = false;
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [rpcUrl, wallet]);

  return { balance: lamports === null ? null : lamports / LAMPORTS_PER_SOL, loading, error };
}

function formatSol(value: number | null | undefined, digits = 4): string {
  return value === null || value === undefined ? '-' : value.toFixed(digits);
}

function AgentControlCard(props: {
  state: AgentState;
  onRefresh: () => Promise<void>;
  onToast: (toast: Toast) => void;
}) {
  const { dict } = useI18n();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { agent } = props.state;

  const run = async (action: 'freeze' | 'unfreeze') => {
    setBusy(true);
    try {
      if (action === 'freeze') {
        await api.freeze();
        setConfirming(false);
        props.onToast({ tone: 'warn', text: dict.toasts.agentFrozen });
      } else {
        await api.unfreeze();
        props.onToast({ tone: 'ok', text: dict.toasts.agentUnfrozen });
      }
      await props.onRefresh();
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={dict.overview.agentControl}
      titleIcon={<Bot size={15} />}
      className={agent.frozen ? 'border-bad-line bg-bad-soft/20' : undefined}
      actions={
        agent.frozen ? (
          <Pill tone="bad">{dict.agent.frozenStatus}</Pill>
        ) : (
          <Pill tone="ok">{dict.overview.agentActive}</Pill>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {agent.frozen ? (
          <Button type="button" variant="default" size="sm" disabled={busy} onClick={() => void run('unfreeze')}>
            <Unlock size={13} aria-hidden="true" />
            {dict.agent.unfreezeBtn}
          </Button>
        ) : confirming ? (
          <>
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void run('freeze')}>
              <Lock size={13} aria-hidden="true" />
              {dict.agent.confirmFreezeBtn}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              {dict.agent.cancelFreezeBtn}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="destructiveOutline"
            size="sm"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            <Lock size={13} aria-hidden="true" />
            {dict.agent.freezeBtn}
          </Button>
        )}
      </div>
    </Card>
  );
}

const LIST_PREVIEW = 5;

function SectionLabel(props: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted">
      <span>{props.children}</span>
      {props.count !== undefined ? <span className="tabular-nums">{props.count}</span> : null}
    </div>
  );
}

/** The whole spending policy at a glance: SOL limits with 24h usage, allowed recipients, allowed tokens. */
function PolicySummaryCard(props: { state: AgentState; onEdit: () => void }) {
  const { dict, interpolate } = useI18n();
  const { policy, usage } = props.state;
  const dailyCap = policy.maxSolPerDay ?? null;
  const spent = usage?.spentSol24h ?? 0;
  const usedRatio = dailyCap ? Math.min(1, spent / dailyCap) : 0;
  const recipients = policy.allowedRecipients;
  const mints = policy.allowedMints;

  return (
    <Card
      title={dict.overview.policyTitle}
      titleIcon={<ShieldCheck size={15} />}
      actions={
        <Button type="button" variant="link" size="sm" className="text-xs" onClick={props.onEdit}>
          {dict.overview.editPolicy}
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-3 lg:gap-0 lg:divide-x lg:divide-line">
        <section className="space-y-3 lg:pr-5">
          <SectionLabel>{dict.overview.solLimits}</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted">{dict.overview.perTx}</div>
              <div className="mt-0.5 text-xl font-semibold [font-stretch:112%] text-ink tabular-nums">
                {policy.maxSolPerTx} <span className="text-xs font-medium text-muted">SOL</span>
              </div>
            </div>
            <div>
              <div className="text-xs text-muted">{dict.overview.perDay}</div>
              <div className="mt-0.5 text-xl font-semibold [font-stretch:112%] text-ink tabular-nums">
                {dailyCap === null ? (
                  <span className="text-sm font-medium text-muted">{dict.overview.unlimited}</span>
                ) : (
                  <>
                    {dailyCap} <span className="text-xs font-medium text-muted">SOL</span>
                  </>
                )}
              </div>
            </div>
          </div>
          {dailyCap !== null ? (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={dailyCap}
              aria-valuenow={spent}
              aria-label={dict.overview.perDay}
            >
              <div
                className={cn('h-full rounded-full', usedRatio >= 0.8 ? 'bg-apricot' : 'bg-accent')}
                style={{ width: `${usedRatio * 100}%` }}
              />
            </div>
          ) : null}
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted tabular-nums">
            <span>{interpolate(dict.overview.spent24h, { amount: formatSol(spent) })}</span>
            {usage?.remainingSol24h != null ? (
              <span>{interpolate(dict.overview.remaining24h, { amount: formatSol(usage.remainingSol24h) })}</span>
            ) : null}
          </div>
        </section>

        <section className="space-y-2 lg:px-5">
          <SectionLabel count={recipients.length}>{dict.overview.recipientsTitle}</SectionLabel>
          {recipients.length === 0 ? (
            <p className="text-xs text-bad">{dict.overview.noRecipients}</p>
          ) : (
            <ul className="space-y-1.5">
              {recipients.slice(0, LIST_PREVIEW).map((entry) => (
                <li key={entry.address} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-ink">{entry.label}</span>
                  <Mono className="text-muted" title={entry.address}>{shorten(entry.address, 4)}</Mono>
                </li>
              ))}
              {recipients.length > LIST_PREVIEW ? (
                <li className="text-xs text-muted">
                  {interpolate(dict.overview.moreItems, { count: recipients.length - LIST_PREVIEW })}
                </li>
              ) : null}
            </ul>
          )}
        </section>

        <section className="space-y-2 lg:pl-5">
          <SectionLabel count={mints.length}>{dict.overview.tokensTitle}</SectionLabel>
          {mints.length === 0 ? (
            <p className="text-xs text-muted">{dict.overview.noTokens}</p>
          ) : (
            <ul className="space-y-1.5">
              {mints.slice(0, LIST_PREVIEW).map((entry) => (
                <li key={entry.address} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-ink" title={entry.address}>{entry.label}</span>
                  <Mono className="text-muted">
                    {interpolate(dict.overview.perTxCap, { amount: policy.maxTokenAmountByMint[entry.address] ?? 0 })}
                  </Mono>
                </li>
              ))}
              {mints.length > LIST_PREVIEW ? (
                <li className="text-xs text-muted">
                  {interpolate(dict.overview.moreItems, { count: mints.length - LIST_PREVIEW })}
                </li>
              ) : null}
            </ul>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 border-t border-line pt-3 text-xs text-muted">
        <span>{interpolate(dict.overview.policyVersion, { version: policy.version })}</span>
        <span aria-hidden="true">·</span>
        <span>
          {dict.overview.policyUpdated} <DateTime value={policy.updatedAt} />
        </span>
      </div>
    </Card>
  );
}

export function OverviewPanel(props: {
  state: AgentState;
  wallet: string | null;
  requests: PaymentRequest[];
  fundingBusy: boolean;
  onAirdrop: () => void;
  onClaimSeed: () => void;
  onDeposit: (amountSol: number) => void;
  onRefresh: () => Promise<void>;
  onToast: (toast: Toast) => void;
  onOpenTab: (tab: 'policy' | 'approvals') => void;
  onOpenMcp?: () => void;
}) {
  const { dict, interpolate } = useI18n();
  const { state, wallet } = props;
  const { agent, policy } = state;
  const owner = useOwnerBalance(state.rpcUrl, wallet);
  const agentBalance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const pending = props.requests.filter((request) => request.status === 'pending_approval').length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ShadcnCard className="border-accent-line bg-accent-soft">
          <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-strong">
                <Bot size={14} className="text-accent" aria-hidden="true" />
                {dict.overview.agentBalance}
              </span>
              {agent.frozen ? <Pill tone="bad">{dict.agent.frozenStatus}</Pill> : null}
            </div>
            {agent.rpcError ? (
              <div><Pill tone="bad">{dict.agent.rpcError}</Pill></div>
            ) : (
              <div className="flex items-baseline gap-1.5 text-3xl font-semibold [font-stretch:112%] text-accent-strong tabular-nums">
                <span>{formatSol(agentBalance)}</span>
                <span className="text-sm font-medium text-accent">SOL</span>
              </div>
            )}
            <div className="flex items-center gap-1 border-t border-accent-line pt-2.5 text-xs text-muted">
              <a
                href={agent.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-accent-hover hover:underline"
              >
                {shorten(agent.pubkey, 6)}
              </a>
              <CopyAddressButton value={agent.pubkey} label={dict.agent.copyAddress} />
            </div>
          </CardContent>
        </ShadcnCard>

        <ShadcnCard>
          <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <Wallet size={14} aria-hidden="true" />
              {dict.overview.ownerBalance}
            </span>
            {!wallet ? (
              <p className="text-xs text-muted">{dict.wallet.connectToViewBalance}</p>
            ) : owner.loading ? (
              <p className="text-xs text-muted">{dict.wallet.loadingBalance}</p>
            ) : owner.error ? (
              <div><Pill tone="bad">{dict.wallet.rpcError}</Pill></div>
            ) : (
              <div className="flex items-baseline gap-1.5 text-2xl font-semibold [font-stretch:112%] text-ink tabular-nums">
                <span>{formatSol(owner.balance)}</span>
                <span className="text-xs font-medium text-muted">SOL</span>
              </div>
            )}
            <div className="flex min-h-[26px] items-center gap-1 border-t border-line pt-2.5 text-xs text-muted">
              {wallet ? (
                <>
                  <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
                  <CopyAddressButton value={wallet} label={dict.wallet.copyAddress} />
                </>
              ) : (
                <span>-</span>
              )}
            </div>
          </CardContent>
        </ShadcnCard>

        <ShadcnCard className={cn(pending > 0 && 'border-warn-line bg-warn-soft/30')}>
          <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <CheckCircle2 size={14} className={pending > 0 ? 'text-warn' : undefined} aria-hidden="true" />
              {dict.overview.pendingApprovals}
            </span>
            <div className="text-2xl font-semibold [font-stretch:112%] text-ink tabular-nums">{pending}</div>
            <div className="flex min-h-[26px] items-center border-t border-line pt-2.5">
              {pending > 0 ? (
                <Button type="button" variant="default" size="sm" className="h-7 px-2.5 text-xs" onClick={() => props.onOpenTab('approvals')}>
                  {dict.overview.review}
                </Button>
              ) : (
                <span className="text-xs text-muted">{dict.overview.noPending}</span>
              )}
            </div>
          </CardContent>
        </ShadcnCard>
      </div>

      <PolicySummaryCard state={state} onEdit={() => props.onOpenTab('policy')} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgentControlCard state={state} onRefresh={props.onRefresh} onToast={props.onToast} />
        <AgentFundingPanel
          state={state}
          busy={props.fundingBusy}
          onAirdrop={props.onAirdrop}
          onClaimSeed={props.onClaimSeed}
          onDeposit={props.onDeposit}
        />
      </div>
    </div>
  );
}
