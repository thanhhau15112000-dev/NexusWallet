import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, type PaymentRequest } from '@nexus/shared';
import { Bot, CheckCircle2, Lock, ShieldCheck, Unlock, Wallet } from './icons.js';
import { api, type AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
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
  const dailyCap = policy.maxSolPerDay ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ShadcnCard className="border-obsidian-line bg-obsidian text-obsidian-ink shadow-sm">
          <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-obsidian-muted">
                <Bot size={14} className="text-signal" aria-hidden="true" />
                {dict.overview.agentBalance}
              </span>
              {agent.frozen ? <Pill tone="bad">{dict.agent.frozenStatus}</Pill> : null}
            </div>
            {agent.rpcError ? (
              <div><Pill tone="bad">{dict.agent.rpcError}</Pill></div>
            ) : (
              <div className="flex items-baseline gap-1.5 text-3xl font-semibold tracking-tight text-obsidian-ink tabular-nums">
                <span>{formatSol(agentBalance)}</span>
                <span className="font-mono text-xs font-semibold text-signal">SOL</span>
              </div>
            )}
            <div className="flex items-center gap-1 border-t border-obsidian-line pt-2.5 text-xs text-obsidian-muted">
              <a
                href={agent.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-signal hover:underline"
              >
                {shorten(agent.pubkey, 6)}
              </a>
              <CopyAddressButton inverted value={agent.pubkey} label={dict.agent.copyAddress} />
            </div>
          </CardContent>
        </ShadcnCard>

        <ShadcnCard>
          <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
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
              <div className="flex items-baseline gap-1.5 text-2xl font-semibold tracking-tight text-ink tabular-nums">
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

        <ShadcnCard>
          <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
                <ShieldCheck size={14} aria-hidden="true" />
                {dict.overview.spendingLimits}
              </span>
              <Button type="button" variant="link" size="sm" className="text-xs" onClick={() => props.onOpenTab('policy')}>
                {dict.overview.editPolicy}
              </Button>
            </div>
            <div className="flex items-baseline gap-1.5 text-2xl font-semibold tracking-tight text-ink tabular-nums">
              <span>{policy.maxSolPerTx}</span>
              <span className="text-xs font-medium text-muted">SOL / tx</span>
            </div>
            <div className="space-y-0.5 border-t border-line pt-2.5 text-[11px] text-muted tabular-nums">
              <div className="flex items-center justify-between gap-2">
                <span>{dict.overview.perDay}: {dailyCap === null ? dict.overview.unlimited : `${dailyCap} SOL`}</span>
                <span>{interpolate(dict.overview.recipientsCount, { count: policy.allowedRecipients.length })}</span>
              </div>
              {state.usage ? (
                <div>{interpolate(dict.overview.spent24h, { amount: formatSol(state.usage.spentSol24h) })}</div>
              ) : null}
            </div>
          </CardContent>
        </ShadcnCard>

        <ShadcnCard className={cn(pending > 0 && 'border-warn-line bg-warn-soft/30')}>
          <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
              <CheckCircle2 size={14} className={pending > 0 ? 'text-warn' : undefined} aria-hidden="true" />
              {dict.overview.pendingApprovals}
            </span>
            <div className="text-2xl font-semibold tracking-tight text-ink tabular-nums">{pending}</div>
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
