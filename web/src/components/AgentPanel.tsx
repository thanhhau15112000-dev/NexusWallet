import { LAMPORTS_PER_SOL } from '@nexus/shared';
import { Bot, Droplet, ExternalLink, ShieldCheck } from 'lucide-react';
import type { AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';

export function AgentPanel(props: {
  state: AgentState;
  busy: boolean;
  onAirdrop: () => void;
  onClaimSeed?: () => void;
  onDeposit?: (amountSol: number) => void;
}) {
  const { agent } = props.state;
  const balance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const funded = balance !== null && balance > 0;
  const funderBalance =
    props.state.masterFunder?.lamports !== null && props.state.masterFunder?.lamports !== undefined
      ? props.state.masterFunder.lamports / LAMPORTS_PER_SOL
      : null;

  return (
    <Card
      title="Agent wallet"
      titleIcon={<Bot size={16} />}
      className="panel-agent wallet-hero"
      actions={
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {props.state.isAdmin ? (
            <Pill tone="wallet">
              <ShieldCheck size={12} style={{ display: 'inline', marginRight: 4 }} />
              Admin
            </Pill>
          ) : null}
          <Pill tone="wallet">{props.state.cluster}</Pill>
        </div>
      }
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

          {props.state.isAdmin && funderBalance !== null ? (
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-muted, #888)' }}>
              Master Funder: <strong>{funderBalance.toFixed(4)} SOL</strong>
            </div>
          ) : null}
        </div>

        <div className="wallet-hero-side">
          <div className="agent-meta">
            <div>
              <span className="wallet-label">Dedicated Agent Address</span>
              <div className="address-line">
                <a href={agent.explorerUrl} target="_blank" rel="noreferrer" className="mono">
                  {shorten(agent.pubkey, 6)}
                </a>
                <CopyAddressButton value={agent.pubkey} label="Copy agent wallet address" />
              </div>
            </div>
            <div>
              <span className="wallet-label">Agent ID</span>
              <Mono title={agent.agentId}>{agent.agentId}</Mono>
            </div>
          </div>

          {agent.rpcError ? <p className="hint warn">{agent.rpcError}</p> : null}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
            <button
              type="button"
              className="wallet-fund"
              disabled={props.busy || props.state.claimedInitialFunding}
              onClick={props.onClaimSeed}
              title={
                props.state.claimedInitialFunding
                  ? 'Initial seed has already been claimed for this agent'
                  : 'Claim 0.1 Devnet SOL from system master funder'
              }
            >
              {props.state.claimedInitialFunding ? 'Seed Claimed (0.1 SOL)' : 'Claim 0.1 SOL (Seed)'}
            </button>

            <button
              type="button"
              className="wallet-fund"
              disabled={props.busy}
              onClick={() => props.onDeposit?.(0.1)}
              title="Transfer 0.1 SOL from your Phantom wallet to this agent wallet"
            >
              Deposit 0.1 SOL
            </button>

            <button
              type="button"
              className="wallet-fund secondary"
              disabled={props.busy}
              onClick={props.onAirdrop}
              title="Request airdrop directly from Solana Devnet RPC"
            >
              {props.busy ? 'Requesting...' : 'Airdrop 1 SOL'}
            </button>
          </div>

          <div style={{ marginTop: '8px' }}>
            <a
              href={`https://faucet.solana.com/?address=${agent.pubkey}`}
              target="_blank"
              rel="noreferrer"
              className="link mono"
              style={{
                fontSize: '12px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                textDecoration: 'none',
              }}
            >
              <Droplet size={13} />
              Solana Official Faucet
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>
    </Card>
  );
}
