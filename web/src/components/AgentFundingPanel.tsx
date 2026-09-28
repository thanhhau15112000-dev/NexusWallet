import { ArrowDownToLine, CheckCircle2, ExternalLink, Wallet, Zap } from './icons.js';
import type { AgentState } from '../api.js';
import { Card } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function AgentFundingPanel(props: {
  state: AgentState;
  busy: boolean;
  onAirdrop: () => void;
  onClaimSeed: () => void;
  onDeposit: (amountSol: number) => void;
}) {
  const { dict } = useI18n();
  const { agent } = props.state;

  return (
    <Card title={dict.funding.title} titleIcon={<Wallet size={16} />} className="agent-funding-panel">
      {agent.rpcError ? <p className="hint warn">{agent.rpcError}</p> : null}

      {props.state.claimedInitialFunding ? (
        <div className="agent-seed-status" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <span>
            <strong>{dict.funding.initialSeedClaimed}</strong>
            <small>{dict.funding.seedCredited}</small>
          </span>
        </div>
      ) : (
        <button
          type="button"
          className="primary button-with-icon"
          disabled={props.busy}
          onClick={props.onClaimSeed}
          title={dict.funding.claimSeedTitle}
        >
          <Zap size={15} aria-hidden="true" />
          {dict.funding.claimSeed}
        </button>
      )}

      <div className="button-row">
        <button
          type="button"
          className="button-with-icon"
          disabled={props.busy}
          onClick={() => props.onDeposit(0.1)}
          title={dict.funding.depositTitle}
        >
          <ArrowDownToLine size={15} aria-hidden="true" />
          {dict.funding.deposit}
        </button>
        <button
          type="button"
          className="button-with-icon"
          disabled={props.busy}
          onClick={props.onAirdrop}
          title={dict.funding.airdropTitle}
        >
          <Zap size={15} aria-hidden="true" />
          {props.busy ? dict.funding.airdropRequesting : dict.funding.airdrop}
        </button>
        <a
          href={`https://faucet.solana.com/?address=${agent.pubkey}`}
          target="_blank"
          rel="noreferrer"
          className="button-link"
        >
          {dict.funding.officialFaucet}
          <ExternalLink size={12} />
        </a>
      </div>
    </Card>
  );
}
