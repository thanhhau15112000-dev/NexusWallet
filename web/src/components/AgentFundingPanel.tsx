import { ArrowDownToLine, ExternalLink } from './icons.js';
import { useId } from 'react';
import type { AgentState } from '../api.js';
import { Button } from './ui/button.js';
import { Notice } from './ui.js';
import { useI18n } from '../i18n/context.js';

/** Solana logomark in its brand gradient; used only on the link to Solana's official faucet. */
function SolanaMark() {
  const id = useId();
  return (
    <svg viewBox="0 0 397.7 311.7" width={14} height={11} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="360.88" y1="351.46" x2="141.21" y2="-69.29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill={`url(#${id})`}>
        <path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </g>
    </svg>
  );
}

/** Funding actions for the agent wallet: deposit from the owner wallet, or Solana's faucet. */
export function AgentFundingActions(props: {
  state: AgentState;
  busy: boolean;
  onDeposit: (amountSol: number) => void;
}) {
  const { dict } = useI18n();
  const { agent } = props.state;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {agent.rpcError ? (
        <Notice tone="warn" className="w-full">
          {agent.rpcError}
        </Notice>
      ) : null}

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
        size="sm"
        asChild
        className="border border-white/10 bg-black text-white shadow-2xs hover:bg-[#14161a]"
      >
        <a href={`https://faucet.solana.com/?address=${agent.pubkey}`} target="_blank" rel="noreferrer">
          <SolanaMark />
          {dict.funding.officialFaucet}
          <ExternalLink size={12} className="opacity-60" aria-hidden="true" />
        </a>
      </Button>
    </div>
  );
}
