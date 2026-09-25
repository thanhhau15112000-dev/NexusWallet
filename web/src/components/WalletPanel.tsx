import type { AgentState } from '../api.js';
import { Wallet } from 'lucide-react';
import { PHANTOM_INSTALL_URL } from '../phantom.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';

export function WalletPanel(props: {
  state: AgentState;
  wallet: string | null;
  hasPhantom: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { state, wallet } = props;
  const owner = state.owner;
  const boundToThisWallet = Boolean(wallet && owner === wallet);

  return (
    <Card
      title="Owner wallet"
      titleIcon={<Wallet size={16} />}
      className="panel-owner"
      actions={
        wallet ? (
          <button type="button" className="link" onClick={props.onDisconnect}>
            Disconnect
          </button>
        ) : (
          <Pill tone="neutral">
            {props.hasPhantom ? 'Ready' : 'Not found'}
          </Pill>
        )
      }
    >
      {!props.hasPhantom ? (
        <p className="inline-alert">
          <a href={PHANTOM_INSTALL_URL} target="_blank" rel="noreferrer">
            Install Phantom
          </a>
        </p>
      ) : null}

      {wallet ? (
        <div className="wallet-summary">
          <div>
            <span className="eyebrow">Connected</span>
            <div className="address-line">
              <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
              <CopyAddressButton value={wallet} label="Copy owner wallet address" />
            </div>
          </div>
          {boundToThisWallet ? (
            <Pill tone={state.isAdmin ? 'wallet' : 'ok'}>{state.isAdmin ? 'Admin' : 'Owner'}</Pill>
          ) : owner ? (
            <Pill tone="warn">Bound {shorten(owner, 4)}</Pill>
          ) : (
            <Pill tone="warn">Unbound</Pill>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={!props.hasPhantom || props.busy}
          onClick={props.onConnect}
        >
          {props.busy ? 'Connecting' : 'Connect wallet'}
        </button>
      )}
    </Card>
  );
}
