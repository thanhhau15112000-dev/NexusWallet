import { ArrowDownToLine, CheckCircle2, ExternalLink, Wallet, Zap } from 'lucide-react';
import type { AgentState } from '../api.js';
import { Card } from './ui.js';

export function AgentFundingPanel(props: {
  state: AgentState;
  busy: boolean;
  onAirdrop: () => void;
  onClaimSeed: () => void;
  onDeposit: (amountSol: number) => void;
}) {
  const { agent } = props.state;

  return (
    <Card title="Agent funding" titleIcon={<Wallet size={16} />} className="agent-funding-panel">
      {agent.rpcError ? <p className="hint warn">{agent.rpcError}</p> : null}
      <div className="agent-funding-actions">
        <div className="agent-seed-row">
          {props.state.claimedInitialFunding ? (
            <div className="agent-seed-status" role="status">
              <span className="agent-seed-status-icon" aria-hidden="true">
                <CheckCircle2 size={17} />
              </span>
              <span>
                <strong>Initial seed claimed</strong>
                <small>0.1 SOL has already been credited to this agent</small>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="wallet-fund wallet-fund-primary button-with-icon"
              disabled={props.busy}
              onClick={props.onClaimSeed}
              title="Claim the one-time 0.1 SOL Devnet seed for this agent"
            >
              <Zap size={15} aria-hidden="true" />
              Claim 0.1 SOL seed
            </button>
          )}
        </div>

        <div className="agent-funding-buttons">
          <button
            type="button"
            className="wallet-fund button-with-icon"
            disabled={props.busy}
            onClick={() => props.onDeposit(0.1)}
            title="Transfer 0.1 SOL from your connected wallet to this agent wallet"
          >
            <ArrowDownToLine size={15} aria-hidden="true" />
            Deposit 0.1 SOL
          </button>

          <button
            type="button"
            className="wallet-fund secondary button-with-icon"
            disabled={props.busy}
            onClick={props.onAirdrop}
            title="Request airdrop directly from Solana Devnet RPC"
          >
            <Zap size={15} aria-hidden="true" />
            {props.busy ? 'Requesting…' : 'Airdrop 1 SOL'}
          </button>
        </div>

        <a
          href={`https://faucet.solana.com/?address=${agent.pubkey}`}
          target="_blank"
          rel="noreferrer"
          className="wallet-faucet-link"
        >
          <span className="solana-faucet-mark" aria-hidden="true">
            <img src="/solana-logo-mark.svg" alt="" />
          </span>
          Official Faucet
          <ExternalLink size={11} />
        </a>
      </div>
    </Card>
  );
}
