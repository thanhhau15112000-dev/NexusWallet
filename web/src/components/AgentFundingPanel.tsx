import { ArrowDownToLine, CheckCircle2, ExternalLink, Wallet, Zap } from './icons.js';
import type { AgentState } from '../api.js';
import { Card } from './ui.js';
import { Button } from './ui/button.js';
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
    <Card title={dict.funding.title} titleIcon={<Wallet size={15} />}>
      {agent.rpcError ? (
        <p className="rounded-md border border-warn-line bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          {agent.rpcError}
        </p>
      ) : null}

      {props.state.claimedInitialFunding ? (
        <div className="flex items-center gap-2 rounded-md border border-accent-line bg-accent-soft/70 px-3 py-2 text-xs text-accent" role="status">
          <CheckCircle2 size={15} className="shrink-0" aria-hidden="true" />
          <span className="font-medium">{dict.funding.initialSeedClaimed}</span>
        </div>
      ) : (
        <Button
          type="button"
          variant="default"
          size="sm"
          disabled={props.busy}
          onClick={props.onClaimSeed}
          title={dict.funding.claimSeedTitle}
        >
          <Zap size={13} aria-hidden="true" />
          {dict.funding.claimSeed}
        </Button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={() => props.onDeposit(0.1)}
          title={dict.funding.depositTitle}
        >
          <ArrowDownToLine size={13} aria-hidden="true" />
          {dict.funding.deposit}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.busy}
          onClick={props.onAirdrop}
          title={dict.funding.airdropTitle}
        >
          <Zap size={13} aria-hidden="true" />
          {props.busy ? dict.funding.airdropRequesting : dict.funding.airdrop}
        </Button>
        <Button type="button" variant="ghost" size="sm" asChild>
          <a
            href={`https://faucet.solana.com/?address=${agent.pubkey}`}
            target="_blank"
            rel="noreferrer"
          >
            {dict.funding.officialFaucet}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </Button>
      </div>
    </Card>
  );
}
