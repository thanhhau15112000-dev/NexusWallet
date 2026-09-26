import type { AgentState } from '../api.js';
import { Unplug } from 'lucide-react';
import { CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { WalletSettingsPopover } from './WalletSettingsPopover.js';

export function WalletPanel(props: {
  state: AgentState;
  settingsOpen: boolean;
  wallet: string | null;
  hasWallet: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { state, wallet } = props;
  const owner = state.owner;
  const boundToThisWallet = Boolean(wallet && owner === wallet);

  return (
    <WalletSettingsPopover
      id="owner-wallet-settings"
      label="Owner wallet settings"
      className="owner-wallet-settings-panel"
      open={props.settingsOpen}
    >
      {wallet ? (
        <div className="owner-wallet-settings-details">
          <span className="owner-wallet-connected">Connected</span>
          <div className="address-line">
            <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
            <CopyAddressButton value={wallet} label="Copy owner wallet address" />
          </div>
          {boundToThisWallet ? (
            <Pill tone={state.isAdmin ? 'wallet' : 'ok'}>{state.isAdmin ? 'Admin' : 'Owner'}</Pill>
          ) : owner ? (
            <Pill tone="warn">Bound {shorten(owner, 4)}</Pill>
          ) : (
            <Pill tone="warn">Unbound</Pill>
          )}
          <button type="button" className="link button-with-icon" onClick={props.onDisconnect}>
            <Unplug size={14} aria-hidden="true" />
            Disconnect
          </button>
        </div>
      ) : (
        <div className="owner-wallet-settings-details">
          <Pill tone="neutral">{props.hasWallet ? 'Ready' : 'Not found'}</Pill>
          {!props.hasWallet ? (
            <span className="owner-wallet-install">Install a compatible Solana wallet</span>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={!props.hasWallet || props.busy}
            onClick={props.onConnect}
          >
            {props.busy ? 'Connecting' : 'Connect wallet'}
          </button>
        </div>
      )}
    </WalletSettingsPopover>
  );
}
