import { LAMPORTS_PER_SOL } from '@nexus/shared';
import type { AgentState } from '../api.js';
import { Card, Mono, Pill, shorten } from './ui.js';

export function AgentPanel(props: {
  state: AgentState;
  busy: boolean;
  onAirdrop: () => void;
}) {
  const { agent } = props.state;
  const balance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const funded = balance !== null && balance > 0;

  return (
    <Card
      title="Agent wallet"
      className="panel-agent wallet-hero"
      actions={<Pill tone="wallet">{props.state.cluster}</Pill>}
    >
      <div className="wallet-hero-content">
        <div className="wallet-hero-main">
          <span className="wallet-label">Available balance</span>
          {agent.rpcError ? (
            <Pill tone="bad">RPC error</Pill>
          ) : (
            <div className="wallet-value">
              <strong className={funded ? 'balance' : 'balance is-low'}>
                {balance === null ? '-' : balance.toFixed(6)}
              </strong>
              <span className="wallet-token">SOL</span>
            </div>
          )}
        </div>

        <div className="wallet-hero-side">
          <div className="agent-meta">
            <div>
              <span className="wallet-label">Address</span>
              <a href={agent.explorerUrl} target="_blank" rel="noreferrer" className="mono">
                {shorten(agent.pubkey, 6)}
              </a>
            </div>
            <div>
              <span className="wallet-label">Agent</span>
              <Mono title={agent.agentId}>{agent.agentId}</Mono>
            </div>
          </div>

          {agent.rpcError ? <p className="hint warn">{agent.rpcError}</p> : null}

          <button
            type="button"
            className="wallet-fund"
            disabled={props.busy}
            onClick={props.onAirdrop}
          >
            {props.busy ? 'Requesting' : 'Airdrop 1 SOL'}
          </button>
        </div>
      </div>
    </Card>
  );
}
