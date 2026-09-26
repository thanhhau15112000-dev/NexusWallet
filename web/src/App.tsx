import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ClipboardList,
  Command,
  WalletCards,
  ShieldCheck,
  Wallet as WalletIcon,
  X,
} from 'lucide-react';
import { getWallets } from '@wallet-standard/app';
import {
  buildApprovalMessage,
  type AuditEntryView,
  type PaymentRequest,
} from '@nexus/shared';
import { api, ApiError, type AgentState } from './api.js';
import {
  connectWallet,
  discoverWallets,
  disconnectWallet,
  observeWallet,
  sendSolFromWallet,
  signMessageWithWallet,
  type ConnectedWallet,
  type WalletChoice,
} from './solanaWallets.js';
import { AgentFundingPanel } from './components/AgentFundingPanel.js';
import { AgentPanel } from './components/AgentPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { ConsolePanel } from './components/ConsolePanel.js';
import { PolicyPanel } from './components/PolicyPanel.js';
import { RequestList } from './components/RequestList.js';
import { WalletPanel } from './components/WalletPanel.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

type FeatureTab = 'wallet' | 'commands' | 'policy' | 'approvals' | 'audit';

const FEATURE_TABS: Array<{
  id: FeatureTab;
  label: string;
  icon: typeof WalletCards;
}> = [
  { id: 'wallet', label: 'Wallet', icon: WalletCards },
  { id: 'commands', label: 'Commands', icon: Command },
  { id: 'policy', label: 'Policy', icon: ShieldCheck },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'audit', label: 'Audit', icon: ClipboardList },
];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarise(request: PaymentRequest): Toast {
  switch (request.status) {
    case 'confirmed':
      return { tone: 'ok', text: 'Confirmed on devnet' };
    case 'pending_approval':
      return { tone: 'warn', text: 'Approval required' };
    case 'denied':
      return { tone: 'bad', text: 'Denied by policy' };
    case 'failed':
      return { tone: 'bad', text: 'Execution failed' };
    default:
      return { tone: 'warn', text: request.status.replace('_', ' ') };
  }
}

function WalletOptions(props: {
  choices: WalletChoice[];
  busy: boolean;
  onSelect: (choice: WalletChoice) => void;
}) {
  if (!props.choices.length) {
    return <p className="wallet-picker-empty">No compatible Solana wallet found. Install a wallet that supports message signing, then reload.</p>;
  }

  return (
    <div className="wallet-picker-options" aria-label="Available Solana wallets">
      {props.choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="wallet-option"
          disabled={props.busy}
          onClick={() => props.onSelect(choice)}
        >
          {choice.icon ? (
            <img src={choice.icon} alt="" />
          ) : (
            <span className="wallet-option-fallback"><WalletIcon size={17} aria-hidden="true" /></span>
          )}
          <span>{choice.name}</span>
          <span className="wallet-option-action">Continue</span>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<AgentState | null>(null);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntryView[]>([]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet | null>(null);
  const [walletChoices, setWalletChoices] = useState<WalletChoice[]>([]);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [ownerWalletSettingsOpen, setOwnerWalletSettingsOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authOwner, setAuthOwner] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FeatureTab>('wallet');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const bindAttempt = useRef<string | null>(null);
  const connectedWalletRef = useRef<ConnectedWallet | null>(null);
  const autoConnectAttempted = useRef(false);
  const refreshSequence = useRef(0);
  const commandRetry = useRef<{ prompt: string; key: string } | null>(null);

  const setFlag = (key: string, value: boolean) =>
    setBusy((prev) => ({ ...prev, [key]: value }));

  const setActiveWallet = useCallback((next: ConnectedWallet | null) => {
    connectedWalletRef.current = next;
    setConnectedWallet(next);
    setWallet(next?.address ?? null);
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [nextState, nextRequests, nextAudit] = await Promise.all([
        api.state(),
        api.requests(),
        api.audit(),
      ]);
      if (sequence !== refreshSequence.current) return;
      setState(nextState);
      setRequests(nextRequests.requests);
      setAudit(nextAudit.entries);
      setOffline(null);
    } catch (err) {
      if (sequence !== refreshSequence.current) return;
      if (err instanceof ApiError && err.status === 401) {
        refreshSequence.current += 1;
        setAuthenticated(false);
        setAuthOwner(null);
        setState(null);
        setRequests([]);
        setAudit([]);
        setOffline('Session expired. Sign in with your wallet again.');
        return;
      }
      setOffline(errorText(err));
    }
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const health = await api.health();
        if (!current) return;
        setAuthRequired(health.authRequired);
        if (health.authRequired) {
          const session = await api.authSession();
          if (!current) return;
          setAuthenticated(session.authenticated);
          setAuthOwner(session.owner);
        } else {
          setAuthenticated(true);
          setAuthOwner(null);
        }
      } catch (err) {
        if (!current) return;
        setOffline(errorText(err));
      } finally {
        if (current) setAuthReady(true);
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!authReady || (authRequired && !authenticated)) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [authReady, authRequired, authenticated, refresh]);

  const logoutSession = useCallback(async () => {
    if (!authRequired) return;
    refreshSequence.current += 1;
    try {
      await api.authLogout();
    } catch {
      // Expired sessions are already unusable; clear local state either way.
    }
    setAuthenticated(false);
    setAuthOwner(null);
    setState(null);
    setRequests([]);
    setAudit([]);
  }, [authRequired]);

  useEffect(() => {
    const registry = getWallets();
    const refreshWallets = () => setWalletChoices(discoverWallets());
    refreshWallets();
    const unregisterRegistered = registry.on('register', refreshWallets);
    const unregisterRemoved = registry.on('unregister', refreshWallets);
    return () => {
      unregisterRegistered();
      unregisterRemoved();
    };
  }, []);

  useEffect(() => {
    if (connectedWallet || autoConnectAttempted.current || !walletChoices.length) return;

    const alreadyAuthorized = walletChoices.find(
      (choice) =>
        choice.kind === 'standard' &&
        choice.wallet.accounts.some((account) =>
          account.chains.some((chain) => chain.startsWith('solana:')) &&
          account.features.includes('solana:signMessage'),
        ),
    );
    if (alreadyAuthorized?.kind === 'standard') {
      const account = alreadyAuthorized.wallet.accounts.find((candidate) =>
        candidate.chains.some((chain) => chain.startsWith('solana:')) &&
        candidate.features.includes('solana:signMessage'),
      );
      if (account) {
        autoConnectAttempted.current = true;
        setActiveWallet({
          kind: 'standard',
          wallet: alreadyAuthorized.wallet,
          account,
          address: account.address,
        });
        return;
      }
    }

    const phantom = walletChoices.find((choice) => choice.kind === 'phantom');
    if (!phantom || phantom.kind !== 'phantom') return;
    autoConnectAttempted.current = true;
    void connectWallet(phantom, true)
      .then((connected) => {
        if (!connectedWalletRef.current) setActiveWallet(connected);
      })
      .catch(() => undefined);
  }, [connectedWallet, walletChoices, setActiveWallet]);

  useEffect(() => {
    if (!connectedWallet) return;
    return observeWallet(connectedWallet, (next) => {
      if (connectedWalletRef.current !== connectedWallet) return;
      bindAttempt.current = null;
      setActiveWallet(next);
      if (!next && authRequired) void logoutSession();
    });
  }, [connectedWallet, authRequired, logoutSession, setActiveWallet]);

  useEffect(() => {
    if (authRequired && authenticated && authOwner && wallet && wallet !== authOwner) {
      void logoutSession();
    }
  }, [authRequired, authenticated, authOwner, wallet, logoutSession]);

  // In multi-tenant mode, the owner is bound to their session upon wallet login.

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const claimSeed = async () => {
    setFlag('seed', true);
    try {
      await api.claimSeed();
      await refresh();
      setToast({ tone: 'ok', text: '0.1 SOL demo seed claimed!' });
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('seed', false);
    }
  };

  const deposit = async (amountSol: number) => {
    if (!wallet || !state || !connectedWalletRef.current) return;
    setFlag('deposit', true);
    try {
      const signature = await sendSolFromWallet({
        connected: connectedWalletRef.current,
        rpcUrl: state.rpcUrl,
        fromPubkey: wallet,
        toPubkey: state.agent.pubkey,
        amountSol,
      });
      setToast({ tone: 'ok', text: `Deposit of ${amountSol} SOL sent! Tx: ${signature.slice(0, 8)}…` });
      await refresh();
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('deposit', false);
    }
  };

  const connect = async (choice: WalletChoice) => {
    setFlag('connect', true);
    try {
      const active = await connectWallet(choice);
      const pubkey = active.address;
      setActiveWallet(active);
      if (authRequired && (!authenticated || authOwner !== pubkey)) {
        const challenge = await api.authChallenge(pubkey);
        const signature = await signMessageWithWallet(active, challenge.message);
        const session = await api.authLogin({
          challengeId: challenge.challengeId,
          pubkey,
          signature,
        });
        setAuthenticated(true);
        setAuthOwner(session.owner);
      }
      setSignInError(null);
      setWalletPickerOpen(false);
    } catch (err) {
      setSignInError(errorText(err));
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('connect', false);
    }
  };

  const disconnect = async () => {
    const active = connectedWalletRef.current;
    setActiveWallet(null);
    await disconnectWallet(active);
    bindAttempt.current = null;
    await logoutSession();
  };

  const savePolicy = async (input: Parameters<typeof api.savePolicy>[0]) => {
    setFlag('policy', true);
    try {
      await api.savePolicy(input);
      await refresh();
      setToast({ tone: 'ok', text: 'Policy saved' });
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
      throw err;
    } finally {
      setFlag('policy', false);
    }
  };

  const airdrop = async () => {
    setFlag('airdrop', true);
    try {
      await api.airdrop(1);
      await refresh();
      setToast({ tone: 'ok', text: 'Airdrop requested' });
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('airdrop', false);
    }
  };

  const runCommand = async (prompt: string) => {
    setFlag('command', true);
    const retry =
      commandRetry.current?.prompt === prompt
        ? commandRetry.current
        : { prompt, key: crypto.randomUUID() };
    try {
      const res = await api.command(prompt, retry.key);
      commandRetry.current = null;
      setToast(summarise(res.request));
      await refresh();
    } catch (err) {
      // If the response was lost after the server accepted the request, a
      // manual retry must reuse the same idempotency key.
      commandRetry.current = retry;
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('command', false);
    }
  };

  const approve = async (request: PaymentRequest) => {
    const active = connectedWalletRef.current;
    if (!wallet || !active || !request.approval) return;
    setApprovingId(request.id);
    try {
      // Rebuild the message locally. If the server's copy differs in any byte,
      // refuse to sign rather than trusting what was handed to us.
      const expected = buildApprovalMessage(request.approval.payload);
      if (expected !== request.approval.message) {
        throw new Error('approval message does not match its payload; refusing to sign');
      }
      const signature = await signMessageWithWallet(active, expected);
      const res = await api.approve(request.id, signature, wallet);
      setToast(summarise(res.request));
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setApprovingId(null);
      await refresh();
    }
  };

  const pendingApprovals = requests.filter((request) => request.status === 'pending_approval').length;

  const selectTabWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? FEATURE_TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + FEATURE_TABS.length) % FEATURE_TABS.length;
    const next = FEATURE_TABS[nextIndex];
    if (!next) return;
    setActiveTab(next.id);
    document.getElementById(`feature-tab-${next.id}`)?.focus();
  };

  if (!state) {
    const needsSignIn = authReady && authRequired && !authenticated;
    return (
      <main className="boot-page">
        <section className="boot" aria-labelledby="login-title">
          <h1 id="login-title">nexusPay</h1>
          <p className="boot-status">{needsSignIn ? 'Sign in required' : offline ? 'Service unavailable' : 'Loading'}</p>
          {offline ? <p className="bad-text boot-error">{offline}</p> : null}
          {signInError ? <p className="bad-text boot-error">{signInError}</p> : null}
          {authReady && authRequired && !authenticated ? (
            <>
              <button
                type="button"
                className="primary boot-sign-in"
                aria-expanded={walletPickerOpen}
                aria-controls="login-wallet-options"
                disabled={!walletChoices.length || Boolean(busy.connect)}
                onClick={() => setWalletPickerOpen((open) => !open)}
              >
                {busy.connect ? 'Connecting…' : 'Sign in with wallet'}
              </button>
              {walletPickerOpen ? (
                <div id="login-wallet-options" className="boot-wallet-picker">
                  <WalletOptions
                    choices={walletChoices}
                    busy={Boolean(busy.connect)}
                    onSelect={(choice) => void connect(choice)}
                  />
                </div>
              ) : null}
              {!walletChoices.length ? (
                <p className="wallet-picker-empty boot-wallet-empty">
                  No compatible Solana wallet found. Install a wallet that supports message signing, then reload.
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div>
            <h1>nexusPay</h1>
          </div>
          <span className="brand-network-tag">{state.cluster}</span>
        </div>
        <div className={`service-state ${offline ? 'is-offline' : ''}`}>
          <Activity size={15} aria-hidden="true" />
          {offline ? 'Offline' : 'Ready'}
        </div>
      </header>

      {offline ? <div className="banner bad">Service unavailable: {offline}</div> : null}

      <nav className="feature-tabs" role="tablist" aria-label="App features">
        {FEATURE_TABS.map((tab, index) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          const count = tab.id === 'approvals' ? pendingApprovals : tab.id === 'audit' ? audit.length : null;
          return (
            <button
              key={tab.id}
              id={`feature-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`feature-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`feature-tab${selected ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => selectTabWithKeyboard(event, index)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{tab.label}</span>
              {count !== null ? <span className="feature-tab-count">{count}</span> : null}
            </button>
          );
        })}
      </nav>

      <section
        id="feature-panel-wallet"
        role="tabpanel"
        aria-labelledby="feature-tab-wallet"
        className="tab-panel"
        hidden={activeTab !== 'wallet'}
      >
        <div className="workspace-grid">
          <AgentPanel
            state={state}
            ownerWalletSettingsOpen={ownerWalletSettingsOpen}
            onToggleOwnerWalletSettings={() => setOwnerWalletSettingsOpen((open) => !open)}
            onCloseOwnerWalletSettings={() => setOwnerWalletSettingsOpen(false)}
            ownerWallet={
              <WalletPanel
                state={state}
                settingsOpen={ownerWalletSettingsOpen}
                wallet={wallet}
                hasWallet={walletChoices.length > 0}
                busy={Boolean(busy.connect)}
                onConnect={() => setWalletPickerOpen(true)}
                onDisconnect={() => void disconnect()}
              />
            }
          />
          <AgentFundingPanel
            state={state}
            busy={Boolean(busy.airdrop || busy.seed || busy.deposit)}
            onAirdrop={() => void airdrop()}
            onClaimSeed={() => void claimSeed()}
            onDeposit={(amount) => void deposit(amount)}
          />
        </div>
      </section>

      <section
        id="feature-panel-commands"
        role="tabpanel"
        aria-labelledby="feature-tab-commands"
        className="tab-panel"
        hidden={activeTab !== 'commands'}
      >
        <ConsolePanel state={state} busy={Boolean(busy.command)} onRun={runCommand} />
      </section>

      <section
        id="feature-panel-policy"
        role="tabpanel"
        aria-labelledby="feature-tab-policy"
        className="tab-panel"
        hidden={activeTab !== 'policy'}
      >
        <PolicyPanel
          state={state}
          wallet={wallet}
          busy={Boolean(busy.policy)}
          onSave={savePolicy}
        />
      </section>

      <section
        id="feature-panel-approvals"
        role="tabpanel"
        aria-labelledby="feature-tab-approvals"
        className="tab-panel"
        hidden={activeTab !== 'approvals'}
      >
        <RequestList
          requests={requests}
          wallet={wallet}
          owner={state.owner}
          busyId={approvingId}
          onApprove={(request) => void approve(request)}
        />
      </section>

      <section
        id="feature-panel-audit"
        role="tabpanel"
        aria-labelledby="feature-tab-audit"
        className="tab-panel"
        hidden={activeTab !== 'audit'}
      >
        <AuditPanel entries={audit} />
      </section>

      {walletPickerOpen ? (
        <div
          className="wallet-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy.connect) setWalletPickerOpen(false);
          }}
        >
          <section className="wallet-dialog" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title">
            <div className="wallet-dialog-head">
              <div>
                <h2 id="wallet-dialog-title">Connect a wallet</h2>
                <p>Choose a Solana wallet to connect as owner.</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close wallet selection"
                disabled={Boolean(busy.connect)}
                onClick={() => setWalletPickerOpen(false)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <WalletOptions
              choices={walletChoices}
              busy={Boolean(busy.connect)}
              onSelect={(choice) => void connect(choice)}
            />
          </section>
        </div>
      ) : null}

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </main>
  );
}
