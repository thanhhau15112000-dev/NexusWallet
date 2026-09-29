import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, type PaymentRequest } from '@nexus/shared';
import { ArrowRight, Bot, CheckCircle2, Lock, Plug, ShieldCheck, Unlock, Wallet } from './icons.js';
import { api, type AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { AgentFundingPanel } from './AgentFundingPanel.js';
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
  const funderBalance =
    props.state.masterFunder?.lamports !== null && props.state.masterFunder?.lamports !== undefined
      ? props.state.masterFunder.lamports / LAMPORTS_PER_SOL
      : null;

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
      titleIcon={<Bot size={16} />}
      className={agent.frozen ? 'agent-control is-frozen' : 'agent-control'}
      actions={
        agent.frozen ? (
          <Pill tone="bad">{dict.agent.frozenStatus}</Pill>
        ) : (
          <Pill tone="ok">{dict.overview.agentActive}</Pill>
        )
      }
    >
      <p className="card-desc">{agent.frozen ? dict.overview.frozenDesc : dict.overview.activeDesc}</p>

      <div className="button-row">
        {agent.frozen ? (
          <button type="button" className="primary button-with-icon" disabled={busy} onClick={() => void run('unfreeze')}>
            <Unlock size={14} aria-hidden="true" />
            {dict.agent.unfreezeBtn}
          </button>
        ) : confirming ? (
          <>
            <button type="button" className="danger-solid button-with-icon" disabled={busy} onClick={() => void run('freeze')}>
              <Lock size={14} aria-hidden="true" />
              {dict.agent.confirmFreezeBtn}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              {dict.agent.cancelFreezeBtn}
            </button>
          </>
        ) : (
          <button type="button" className="danger-outline button-with-icon" disabled={busy} onClick={() => setConfirming(true)}>
            <Lock size={14} aria-hidden="true" />
            {dict.agent.freezeBtn}
          </button>
        )}
      </div>

      <dl className="kv-list">
        <div>
          <dt>{dict.agent.agentId}</dt>
          <dd>
            <Mono title={agent.agentId}>{agent.agentId}</Mono>
          </dd>
        </div>
        {props.state.isAdmin && funderBalance !== null ? (
          <div>
            <dt>{dict.agent.masterFunder}</dt>
            <dd>{funderBalance.toFixed(4)} SOL</dd>
          </div>
        ) : null}
      </dl>
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
  onOpenMcp: () => void;
}) {
  const { dict, interpolate } = useI18n();
  const { state, wallet } = props;
  const { agent, policy } = state;
  const owner = useOwnerBalance(state.rpcUrl, wallet);
  const agentBalance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const pending = props.requests.filter((request) => request.status === 'pending_approval').length;
  const dailyCap = policy.maxSolPerDay ?? null;

  return (
    <div className="page-stack">
      <div className="stat-grid">
        <section className="stat stat-hero">
          <div className="stat-head">
            <span className="stat-title">
              <Bot size={15} aria-hidden="true" />
              {dict.overview.agentBalance}
            </span>
            {agent.frozen ? <Pill tone="bad">{dict.agent.frozenStatus}</Pill> : null}
          </div>
          {agent.rpcError ? (
            <Pill tone="bad">{dict.agent.rpcError}</Pill>
          ) : (
            <div className="stat-value">
              {formatSol(agentBalance)}
              <span className="stat-unit">SOL</span>
            </div>
          )}
          <div className="stat-foot address-line">
            <a href={agent.explorerUrl} target="_blank" rel="noreferrer" className="mono">
              {shorten(agent.pubkey, 6)}
            </a>
            <CopyAddressButton value={agent.pubkey} label={dict.agent.copyAddress} />
          </div>
        </section>

        <section className="stat">
          <div className="stat-head">
            <span className="stat-title">
              <Wallet size={15} aria-hidden="true" />
              {dict.overview.ownerBalance}
            </span>
          </div>
          {!wallet ? (
            <p className="stat-empty">{dict.wallet.connectToViewBalance}</p>
          ) : owner.loading ? (
            <p className="stat-empty">{dict.wallet.loadingBalance}</p>
          ) : owner.error ? (
            <Pill tone="bad">{dict.wallet.rpcError}</Pill>
          ) : (
            <div className="stat-value">
              {formatSol(owner.balance)}
              <span className="stat-unit">SOL</span>
            </div>
          )}
          {wallet ? (
            <div className="stat-foot address-line">
              <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
              <CopyAddressButton value={wallet} label={dict.wallet.copyAddress} />
            </div>
          ) : null}
        </section>

        <section className="stat">
          <div className="stat-head">
            <span className="stat-title">
              <ShieldCheck size={15} aria-hidden="true" />
              {dict.overview.spendingLimits}
            </span>
            <button type="button" className="link" onClick={() => props.onOpenTab('policy')}>
              {dict.overview.editPolicy}
            </button>
          </div>
          <div className="stat-value">
            {policy.maxSolPerTx}
            <span className="stat-unit">SOL {dict.overview.perTx.toLowerCase()}</span>
          </div>
          <div className="stat-foot stat-lines">
            <span>
              {dict.overview.perDay}: {dailyCap === null ? dict.overview.unlimited : `${dailyCap} SOL`}
            </span>
            {state.usage ? (
              <span>{interpolate(dict.overview.spent24h, { amount: formatSol(state.usage.spentSol24h) })}</span>
            ) : null}
            <span>{interpolate(dict.overview.recipientsCount, { count: policy.allowedRecipients.length })}</span>
          </div>
        </section>

        <section className={pending > 0 ? 'stat is-attention' : 'stat'}>
          <div className="stat-head">
            <span className="stat-title">
              <CheckCircle2 size={15} aria-hidden="true" />
              {dict.overview.pendingApprovals}
            </span>
          </div>
          <div className="stat-value">{pending}</div>
          <div className="stat-foot">
            {pending > 0 ? (
              <button type="button" className="primary" onClick={() => props.onOpenTab('approvals')}>
                {dict.overview.review}
              </button>
            ) : (
              <span className="muted">{dict.overview.noPending}</span>
            )}
          </div>
        </section>
      </div>

      <div className="split-grid">
        <AgentControlCard state={state} onRefresh={props.onRefresh} onToast={props.onToast} />
        <div className="overview-side">
          <AgentFundingPanel
            state={state}
            busy={props.fundingBusy}
            onAirdrop={props.onAirdrop}
            onClaimSeed={props.onClaimSeed}
            onDeposit={props.onDeposit}
          />
          <section className="mcp-promo">
            <span className="mcp-promo-icon" aria-hidden="true">
              <Plug size={20} />
            </span>
            <div className="mcp-promo-text">
              <h3>{dict.overview.mcpPromoTitle}</h3>
              <p>{dict.overview.mcpPromoDesc}</p>
            </div>
            <button type="button" className="mcp-promo-cta button-with-icon" onClick={props.onOpenMcp}>
              {dict.overview.mcpPromoCta}
              <ArrowRight size={14} aria-hidden="true" />
            </button>
          </section>
        </div>
      </div>

    </div>
  );
}
