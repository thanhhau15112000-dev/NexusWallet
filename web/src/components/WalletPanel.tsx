import { useEffect, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { LAMPORTS_PER_SOL } from '@nexus/shared';
import type { AgentState } from '../api.js';
import { Unplug } from 'lucide-react';
import { CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { WalletSettingsPopover } from './WalletSettingsPopover.js';
import { useI18n } from '../i18n/context.js';

export function WalletPanel(props: {
  state: AgentState;
  settingsOpen: boolean;
  wallet: string | null;
  hasWallet: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { dict } = useI18n();
  const { state, wallet } = props;
  const owner = state.owner;
  const boundToThisWallet = Boolean(wallet && owner === wallet);
  const [ownerLamports, setOwnerLamports] = useState<number | null>(null);
  const [ownerBalanceLoading, setOwnerBalanceLoading] = useState(false);
  const [ownerBalanceError, setOwnerBalanceError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!wallet) {
      setOwnerLamports(null);
      setOwnerBalanceLoading(false);
      setOwnerBalanceError(false);
      return;
    }

    let connection: Connection;
    let address: PublicKey;
    try {
      connection = new Connection(state.rpcUrl, 'confirmed');
      address = new PublicKey(wallet);
    } catch {
      setOwnerLamports(null);
      setOwnerBalanceLoading(false);
      setOwnerBalanceError(true);
      return;
    }
    let firstLoad = true;

    const loadBalance = async () => {
      if (firstLoad) setOwnerBalanceLoading(true);
      try {
        const lamports = await connection.getBalance(address, 'confirmed');
        if (cancelled) return;
        setOwnerLamports(lamports);
        setOwnerBalanceError(false);
      } catch {
        if (cancelled) return;
        setOwnerLamports(null);
        setOwnerBalanceError(true);
      } finally {
        if (!cancelled && firstLoad) setOwnerBalanceLoading(false);
        firstLoad = false;
      }
    };

    void loadBalance();
    const refreshTimer = window.setInterval(() => void loadBalance(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [state.rpcUrl, wallet]);

  const ownerBalance = ownerLamports === null ? null : ownerLamports / LAMPORTS_PER_SOL;

  return (
    <>
      <div className="owner-wallet-summary">
        <div className="wallet-balance-group">
          <span className="wallet-label">{dict.wallet.availableBalance}</span>
          {!wallet ? (
            <span className="owner-wallet-empty">{dict.wallet.connectToViewBalance}</span>
          ) : ownerBalanceLoading ? (
            <span className="owner-wallet-empty">{dict.wallet.loadingBalance}</span>
          ) : ownerBalanceError ? (
            <Pill tone="bad">{dict.wallet.rpcError}</Pill>
          ) : (
            <div className="wallet-value">
              <strong className={ownerBalance && ownerBalance > 0 ? 'balance' : 'balance is-low'}>
                {ownerBalance === null ? '-' : ownerBalance.toFixed(6)}
              </strong>
              <span className="wallet-token">SOL</span>
            </div>
          )}
        </div>
      </div>

      <WalletSettingsPopover
        id="owner-wallet-settings"
        label={dict.wallet.title}
        className="owner-wallet-settings-panel"
        open={props.settingsOpen}
      >
        {wallet ? (
          <div className="owner-wallet-settings-details">
            <span className="owner-wallet-connected">{dict.wallet.connected}</span>
            <div className="address-line">
              <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
              <CopyAddressButton value={wallet} label={dict.wallet.copyAddress} />
            </div>
            {boundToThisWallet ? (
              <Pill tone={state.isAdmin ? 'wallet' : 'ok'}>{state.isAdmin ? dict.wallet.admin : dict.wallet.owner}</Pill>
            ) : owner ? (
              <Pill tone="warn">{dict.wallet.bound} {shorten(owner, 4)}</Pill>
            ) : (
              <Pill tone="warn">{dict.wallet.unbound}</Pill>
            )}
            <button type="button" className="link button-with-icon" onClick={props.onDisconnect}>
              <Unplug size={14} aria-hidden="true" />
              {dict.wallet.disconnect}
            </button>
          </div>
        ) : (
          <div className="owner-wallet-settings-details">
            <Pill tone="neutral">{props.hasWallet ? dict.wallet.ready : dict.wallet.notFound}</Pill>
            {!props.hasWallet ? (
              <span className="owner-wallet-install">{dict.wallet.installPhantom}</span>
            ) : null}
            <button
              type="button"
              className="primary"
              disabled={!props.hasWallet || props.busy}
              onClick={props.onConnect}
            >
              {props.busy ? dict.wallet.connecting : dict.wallet.connectWallet}
            </button>
          </div>
        )}
      </WalletSettingsPopover>
    </>
  );
}
