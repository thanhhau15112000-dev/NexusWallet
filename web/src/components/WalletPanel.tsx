import type { AgentState } from '../api.js';
import { Wallet } from 'lucide-react';
import { PHANTOM_INSTALL_URL } from '../phantom.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function WalletPanel(props: {
  state: AgentState;
  wallet: string | null;
  hasPhantom: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { dict } = useI18n();
  const { state, wallet } = props;
  const owner = state.owner;
  const boundToThisWallet = Boolean(wallet && owner === wallet);

  return (
    <Card
      title={dict.wallet.title}
      titleIcon={<Wallet size={16} />}
      className="panel-owner"
      actions={
        wallet ? (
          <button type="button" className="link" onClick={props.onDisconnect}>
            {dict.wallet.disconnect}
          </button>
        ) : (
          <Pill tone="neutral">
            {props.hasPhantom ? dict.wallet.ready : dict.wallet.notFound}
          </Pill>
        )
      }
    >
      {!props.hasPhantom ? (
        <p className="inline-alert">
          <a href={PHANTOM_INSTALL_URL} target="_blank" rel="noreferrer">
            {dict.wallet.installPhantom}
          </a>
        </p>
      ) : null}

      {wallet ? (
        <div className="wallet-summary">
          <div>
            <span className="eyebrow">{dict.wallet.connected}</span>
            <div className="address-line">
              <Mono title={wallet}>{shorten(wallet, 6)}</Mono>
              <CopyAddressButton value={wallet} label={dict.wallet.copyAddress} />
            </div>
          </div>
          {boundToThisWallet ? (
            <Pill tone={state.isAdmin ? 'wallet' : 'ok'}>{state.isAdmin ? dict.wallet.admin : dict.wallet.owner}</Pill>
          ) : owner ? (
            <Pill tone="warn">{dict.wallet.bound} {shorten(owner, 4)}</Pill>
          ) : (
            <Pill tone="warn">{dict.wallet.unbound}</Pill>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="primary"
          disabled={!props.hasPhantom || props.busy}
          onClick={props.onConnect}
        >
          {props.busy ? dict.wallet.connecting : dict.wallet.connectWallet}
        </button>
      )}
    </Card>
  );
}
