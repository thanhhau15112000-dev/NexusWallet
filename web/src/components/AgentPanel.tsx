import { LAMPORTS_PER_SOL } from '@nexus/shared';
import { Bot, Droplet, ExternalLink, ShieldCheck } from 'lucide-react';
import type { AgentState } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function AgentPanel(props: {
  state: AgentState;
  busy: boolean;
  onAirdrop: () => void;
  onClaimSeed?: () => void;
  onDeposit?: (amountSol: number) => void;
}) {
  const { dict } = useI18n();
  const { agent } = props.state;
  const balance = agent.lamports === null ? null : agent.lamports / LAMPORTS_PER_SOL;
  const funded = balance !== null && balance > 0;
  const funderBalance =
    props.state.masterFunder?.lamports !== null && props.state.masterFunder?.lamports !== undefined
      ? props.state.masterFunder.lamports / LAMPORTS_PER_SOL
      : null;

  return (
    <Card
      title={dict.agent.title}
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
          <span className="wallet-label">{dict.agent.availableBalance}</span>
          {agent.rpcError ? (
            <Pill tone="bad">{dict.agent.rpcError}</Pill>
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
              {dict.agent.masterFunder}: <strong>{funderBalance.toFixed(4)} SOL</strong>
            </div>
          ) : null}
        </div>

        <div className="wallet-hero-side">
          <div className="agent-meta">
            <div>
              <span className="wallet-label">{dict.agent.dedicatedAddress}</span>
              <div className="address-line">
                <a href={agent.explorerUrl} target="_blank" rel="noreferrer" className="mono">
                  {shorten(agent.pubkey, 6)}
                </a>
                <CopyAddressButton value={agent.pubkey} label={dict.agent.copyAddress} />
              </div>
            </div>
            <div>
              <span className="wallet-label">{dict.agent.agentId}</span>
              <Mono title={agent.agentId}>{agent.agentId}</Mono>
            </div>
          </div>

          {agent.rpcError ? <p className="hint warn">{agent.rpcError}</p> : null}

          <div className="wallet-actions">
            <button
              type="button"
              className="wallet-fund"
              disabled={props.busy || props.state.claimedInitialFunding}
              onClick={props.onClaimSeed}
              title={
                props.state.claimedInitialFunding
                  ? dict.agent.claimSeedDoneTitle
                  : dict.agent.claimSeedTitle
              }
            >
              {props.state.claimedInitialFunding ? dict.agent.seedClaimed : dict.agent.claimSeed}
            </button>

            <button
              type="button"
              className="wallet-fund"
              disabled={props.busy}
              onClick={() => props.onDeposit?.(0.1)}
              title={dict.agent.depositTitle}
            >
              {dict.agent.deposit}
            </button>

            <button
              type="button"
              className="wallet-fund secondary"
              disabled={props.busy}
              onClick={props.onAirdrop}
              title={dict.agent.airdropTitle}
            >
              {props.busy ? dict.agent.airdropRequesting : dict.agent.airdrop}
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
              {dict.agent.faucet}
              <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>
    </Card>
  );
}
