import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { LAMPORTS_PER_SOL } from '@nexus/shared';
import { Bot, Lock, Settings, ShieldCheck, Unlock, Wallet } from './icons.js';
import { api, type AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { WalletSettingsPopover } from './WalletSettingsPopover.js';
import { useI18n } from '../i18n/context.js';

export function AgentPanel(props: {
  state: AgentState;
  ownerWallet: ReactNode;
  ownerWalletSettingsOpen: boolean;
  onToggleOwnerWalletSettings: () => void;
  onCloseOwnerWalletSettings: () => void;
  onRefresh?: () => void | Promise<void>;
  onToast?: (toast: { tone: 'ok' | 'warn' | 'bad'; text: string }) => void;
}) {
  const { dict } = useI18n();
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingFreeze, setConfirmingFreeze] = useState(false);
  const { agent } = props.state;
  const balance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const funded = balance !== null && balance > 0;
  const funderBalance =
    props.state.masterFunder?.lamports !== null && props.state.masterFunder?.lamports !== undefined
      ? props.state.masterFunder.lamports / LAMPORTS_PER_SOL
      : null;

  const handleFreeze = async () => {
    setBusy(true);
    try {
      await api.freeze();
      setConfirmingFreeze(false);
      props.onToast?.({ tone: 'warn', text: dict.toasts.agentFrozen });
      await props.onRefresh?.();
    } catch (err) {
      props.onToast?.({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleUnfreeze = async () => {
    setBusy(true);
    try {
      await api.unfreeze();
      props.onToast?.({ tone: 'ok', text: dict.toasts.agentUnfrozen });
      await props.onRefresh?.();
    } catch (err) {
      props.onToast?.({ tone: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!agentSettingsOpen && !props.ownerWalletSettingsOpen) return;

    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.wallet-settings-panel, .wallet-section-gear')) return;
      setAgentSettingsOpen(false);
      props.onCloseOwnerWalletSettings();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setAgentSettingsOpen(false);
      props.onCloseOwnerWalletSettings();
    };

    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    window.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer);
      window.removeEventListener('keydown', dismissOnEscape);
    };
  }, [agentSettingsOpen, props.ownerWalletSettingsOpen, props.onCloseOwnerWalletSettings]);

  return (
    <Card
      title={dict.agent.title}
      titleIcon={<Bot size={16} />}
      titleAction={
        <button
          type="button"
          className="wallet-section-gear"
          aria-label="Agent wallet settings"
          aria-expanded={agentSettingsOpen}
          aria-controls="agent-wallet-settings"
          onClick={() => {
            props.onCloseOwnerWalletSettings();
            setAgentSettingsOpen((open) => !open);
          }}
        >
          <Settings size={15} />
        </button>
      }
      className="panel-agent wallet-hero"
      actions={
        <div className="wallet-hero-header-actions">
          <div className="owner-wallet-heading">
            <Wallet size={15} aria-hidden="true" />
            <span>{dict.wallet.title}</span>
          </div>
          {props.state.isAdmin ? (
            <Pill tone="wallet">
              <ShieldCheck size={12} style={{ display: 'inline', marginRight: 4 }} />
              {dict.wallet.admin}
            </Pill>
          ) : null}
          <button
            type="button"
            className="wallet-section-gear"
            aria-label="Owner wallet settings"
            aria-expanded={props.ownerWalletSettingsOpen}
            aria-controls="owner-wallet-settings"
            onClick={() => {
              setAgentSettingsOpen(false);
              props.onToggleOwnerWalletSettings();
            }}
          >
            <Settings size={15} />
          </button>
        </div>
      }
    >
      <div className="wallet-hero-content">
        <div className="wallet-hero-main">
          <div className="wallet-balance-group">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="wallet-label">{dict.agent.availableBalance}</span>
              {agent.frozen ? <Pill tone="bad">{dict.agent.frozenStatus}</Pill> : null}
            </div>
            {agent.rpcError ? (
              <Pill tone="bad">{dict.agent.rpcError}</Pill>
            ) : (
              <div className="wallet-value">
                <strong className={funded ? 'balance' : 'balance is-low'}>
                  {balance === null ? '-' : balance.toFixed(6)}
                </strong>
                <span className="wallet-token">SOL</span>
              </div>
            )}
          </div>
          <div className="agent-freeze-controls" style={{ marginTop: 10 }}>
            {agent.frozen ? (
              <button
                type="button"
                className="wallet-fund button-with-icon"
                disabled={busy}
                onClick={() => void handleUnfreeze()}
              >
                <Unlock size={14} aria-hidden="true" />
                {dict.agent.unfreezeBtn}
              </button>
            ) : confirmingFreeze ? (
              <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <button
                  type="button"
                  className="wallet-fund button-with-icon"
                  style={{ backgroundColor: '#ef4444', color: '#ffffff', borderColor: '#ef4444' }}
                  disabled={busy}
                  onClick={() => void handleFreeze()}
                >
                  <Lock size={14} aria-hidden="true" />
                  {dict.agent.confirmFreezeBtn}
                </button>
                <button
                  type="button"
                  className="wallet-fund secondary"
                  disabled={busy}
                  onClick={() => setConfirmingFreeze(false)}
                >
                  {dict.agent.cancelFreezeBtn}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="wallet-fund secondary button-with-icon"
                disabled={busy}
                onClick={() => setConfirmingFreeze(true)}
              >
                <Lock size={14} aria-hidden="true" />
                {dict.agent.freezeBtn}
              </button>
            )}
          </div>
          {props.state.isAdmin && funderBalance !== null ? (
            <div className="master-funder-balance">
              {dict.agent.masterFunder}: <strong>{funderBalance.toFixed(4)} SOL</strong>
            </div>
          ) : null}
          <WalletSettingsPopover
            id="agent-wallet-settings"
            label="Agent wallet settings"
            className="agent-wallet-settings-panel"
            open={agentSettingsOpen}
          >
            <div className="agent-meta">
              <div>
                <span className="wallet-label">{dict.agent.dedicatedAddress}</span>
                <div className="address-line">
                  <a href={agent.explorerUrl} target="_blank" rel="noreferrer" className="mono">
                    {shorten(agent.pubkey, 6)}
                  </a>
                  <CopyAddressButton value={agent.pubkey} label={dict.agent.copyAddress} />
                </div>
              </div>
              <div>
                <span className="wallet-label">{dict.agent.agentId}</span>
                <Mono title={agent.agentId}>{agent.agentId}</Mono>
              </div>
            </div>
          </WalletSettingsPopover>
        </div>
        <div className="wallet-hero-owner">{props.ownerWallet}</div>
      </div>
    </Card>
  );
}
