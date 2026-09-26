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

  return (
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
  );
}
