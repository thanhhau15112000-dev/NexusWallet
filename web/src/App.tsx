import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Command,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  ShieldCheck,
  Wallet as WalletIcon,
  X,
} from './components/icons.js';
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
import { McpConnectPanel } from './components/McpConnectPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { ConsolePanel } from './components/ConsolePanel.js';
import { DocsPanel } from './components/DocsPanel.js';
import { OverviewPanel } from './components/OverviewPanel.js';
import { PolicyPanel } from './components/PolicyPanel.js';
import { RecentRequests } from './components/RecentRequests.js';
import { RequestList } from './components/RequestList.js';
import { TaskVaultPanel } from './components/TaskVaultPanel.js';
import { LanguageToggle } from './components/SettingsMenu.js';
import { Mascot } from './components/Mascot.js';
import { Mono, Pill, shorten } from './components/ui.js';
import { useI18n } from './i18n/context.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

type FeatureTab = 'wallet' | 'tasks' | 'commands' | 'policy' | 'approvals' | 'audit' | 'docs';

type NavGroup = 'operate' | 'control' | 'resources';

// Sidebar order; arrow keys move through this list top to bottom.
const FEATURE_TABS: Array<{ id: FeatureTab; group: NavGroup; icon: typeof LayoutGrid }> = [
  { id: 'wallet', group: 'operate', icon: LayoutGrid },
  { id: 'commands', group: 'operate', icon: Command },
  { id: 'approvals', group: 'operate', icon: CheckCircle2 },
  { id: 'policy', group: 'control', icon: ShieldCheck },
  { id: 'tasks', group: 'control', icon: Layers },
  { id: 'audit', group: 'control', icon: ClipboardList },
  { id: 'docs', group: 'resources', icon: BookOpen },
];

const NAV_GROUPS: NavGroup[] = ['operate', 'control', 'resources'];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function WalletOptions(props: {
  choices: WalletChoice[];
  busy: boolean;
  onSelect: (choice: WalletChoice) => void;
}) {
  const { dict } = useI18n();
  if (!props.choices.length) {
    return <p className="wallet-picker-empty">{dict.walletModal.noWallet}</p>;
  }

  return (
    <div className="wallet-picker-options" aria-label={dict.walletModal.availableWallets}>
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
          <span className="wallet-option-action">{dict.walletModal.continue}</span>
        </button>
      ))}
    </div>
  );
}
export function App() {
  const { dict, interpolate } = useI18n();
  const [state, setState] = useState<AgentState | null>(null);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntryView[]>([]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet | null>(null);
  const [walletChoices, setWalletChoices] = useState<WalletChoice[]>([]);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  // Mobile burger menu; the sidebar is always visible on wider screens.
  const [navOpen, setNavOpen] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authOwner, setAuthOwner] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  // An agent holding a transfer links the owner to ?request=<id>; open the approvals tab for it.
  const [focusRequestId] = useState(() => new URLSearchParams(window.location.search).get('request'));
  const [activeTab, setActiveTab] = useState<FeatureTab>(focusRequestId ? 'approvals' : 'wallet');
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
        setOffline(dict.walletModal.sessionExpired);
        return;
      }
      setOffline(errorText(err));
    }
  }, [dict.walletModal.sessionExpired]);

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
    if (!navOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [navOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const summarise = useCallback(
    (request: PaymentRequest): Toast => {
      switch (request.status) {
        case 'confirmed':
          return { tone: 'ok', text: dict.toasts.confirmed };
        case 'pending_approval':
          return { tone: 'warn', text: dict.toasts.approvalRequired };
        case 'denied':
          return { tone: 'bad', text: dict.toasts.denied };
        case 'failed':
          return { tone: 'bad', text: dict.toasts.executionFailed };
        default:
          return { tone: 'warn', text: request.status.replace('_', ' ') };
      }
    },
    [dict.toasts],
  );

  const claimSeed = async () => {
    setFlag('seed', true);
    try {
      await api.claimSeed();
      await refresh();
      setToast({ tone: 'ok', text: dict.toasts.seedClaimed });
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
      setToast({
        tone: 'ok',
        text: interpolate(dict.toasts.depositSent, {
          amount: amountSol,
          tx: `${signature.slice(0, 8)}…`,
        }),
      });
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
      setToast({ tone: 'ok', text: dict.toasts.policySaved });
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
      setToast({ tone: 'ok', text: dict.toasts.airdropRequested });
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
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? FEATURE_TABS.length - 1
          : (index + step + FEATURE_TABS.length) % FEATURE_TABS.length;
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
          <Mascot
            className="boot-mascot"
            pose={offline ? 'sleep' : needsSignIn ? 'wave' : 'think'}
            caption={offline ? dict.mascot.offline : needsSignIn ? dict.mascot.signIn : dict.mascot.loading}
          />
          <h1 id="login-title">nexusPay</h1>
          <p className="boot-status">{needsSignIn ? dict.boot.signInRequired : offline ? dict.boot.serviceUnavailable : dict.boot.loading}</p>
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
                {busy.connect ? dict.boot.connecting : dict.boot.signInBtn}
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
                  {dict.boot.installPhantom}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      </main>
    );
  }

  const boundToThisWallet = Boolean(wallet && state.owner === wallet);
  const ownerRole = boundToThisWallet ? (
    <Pill tone={state.isAdmin ? 'wallet' : 'ok'}>{state.isAdmin ? dict.wallet.admin : dict.wallet.owner}</Pill>
  ) : state.owner ? (
    <Pill tone="warn">{dict.wallet.bound} {shorten(state.owner, 4)}</Pill>
  ) : (
    <Pill tone="warn">{dict.wallet.unbound}</Pill>
  );

  const panel = (tab: FeatureTab, content: React.ReactNode) => (
    <section
      id={`feature-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`feature-tab-${tab}`}
      className="tab-panel"
      hidden={activeTab !== tab}
    >
      {content}
    </section>
  );

  return (
    <div className="shell">
      <aside className={navOpen ? 'sidebar is-open' : 'sidebar'}>
        <div className="brand">
          <img className="brand-logo" src="/brand/logo.svg" alt="" width={32} height={32} />
          <span className="brand-name">nexusPay</span>
          <span className="brand-network-tag">{state.cluster}</span>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen}
            aria-controls="side-nav"
            aria-label={navOpen ? dict.nav.closeMenu : dict.nav.openMenu}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
        </div>

        <nav id="side-nav" className="side-nav" role="tablist" aria-orientation="vertical" aria-label="App features">
          {NAV_GROUPS.map((group) => (
            <div key={group} className="side-nav-group" role="presentation">
              <span className="side-nav-heading" role="presentation">{dict.nav[group]}</span>
              {FEATURE_TABS.filter((tab) => tab.group === group).map((tab) => {
                const Icon = tab.icon;
                const index = FEATURE_TABS.indexOf(tab);
                const selected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    id={`feature-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={`feature-panel-${tab.id}`}
                    tabIndex={selected ? 0 : -1}
                    className={`side-nav-item${selected ? ' is-active' : ''}`}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setNavOpen(false);
                    }}
                    onKeyDown={(event) => selectTabWithKeyboard(event, index)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    <span>{dict.tabs[tab.id]}</span>
                    {tab.id === 'approvals' && pendingApprovals > 0 ? (
                      <span className="side-nav-badge">{pendingApprovals}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-owner">
          {wallet ? (
            <>
              <div className="owner-row">
                <span className="owner-avatar" aria-hidden="true">
                  <WalletIcon size={16} />
                </span>
                <div className="owner-meta">
                  <span className="owner-label">{dict.wallet.title}</span>
                  <Mono title={wallet}>{shorten(wallet, 4)}</Mono>
                </div>
                {ownerRole}
              </div>
              <button type="button" className="sidebar-logout button-with-icon" onClick={() => void disconnect()}>
                <LogOut size={14} aria-hidden="true" />
                {authRequired ? dict.wallet.logout : dict.wallet.disconnect}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="primary"
                disabled={!walletChoices.length || Boolean(busy.connect)}
                onClick={() => {
                  setNavOpen(false);
                  setWalletPickerOpen(true);
                }}
              >
                {busy.connect ? dict.wallet.connecting : dict.wallet.connectWallet}
              </button>
              {!walletChoices.length ? <span className="hint">{dict.wallet.installPhantom}</span> : null}
            </>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="page-head">
          <div className="page-title">
            <h1>{dict.tabs[activeTab]}</h1>
            <p>{dict.pageDesc[activeTab]}</p>
          </div>
          <div className="page-tools">
            <span className={`service-state${offline ? ' is-offline' : ''}`}>
              <Activity size={14} aria-hidden="true" />
              {offline ? dict.topbar.offline : dict.topbar.ready}
            </span>
            <LanguageToggle />
          </div>
        </header>

        {offline ? <div className="banner bad">{interpolate(dict.walletModal.serviceUnavailable, { offline })}</div> : null}

        {panel(
          'wallet',
          <OverviewPanel
            state={state}
            wallet={wallet}
            requests={requests}
            fundingBusy={Boolean(busy.airdrop || busy.seed || busy.deposit)}
            onAirdrop={() => void airdrop()}
            onClaimSeed={() => void claimSeed()}
            onDeposit={(amount) => void deposit(amount)}
            onRefresh={refresh}
            onToast={setToast}
            onOpenTab={setActiveTab}
          />,
        )}

        {panel(
          'commands',
          <div className="page-stack">
            <ConsolePanel state={state} busy={Boolean(busy.command)} onRun={runCommand} />
            <RecentRequests
              title={dict.console.recentTitle}
              requests={requests}
              limit={5}
              onViewAll={() => setActiveTab('approvals')}
            />
            <McpConnectPanel />
          </div>,
        )}

        {panel(
          'approvals',
          <RequestList
            requests={requests}
            wallet={wallet}
            owner={state.owner}
            busyId={approvingId}
            focusId={focusRequestId}
            onApprove={(request) => void approve(request)}
          />,
        )}

        {panel(
          'policy',
          <PolicyPanel state={state} wallet={wallet} busy={Boolean(busy.policy)} onSave={savePolicy} />,
        )}

        {panel(
          'tasks',
          <TaskVaultPanel
            owner={state.owner}
            agentPubkey={state.agent.pubkey}
            mockWorkerPubkey={state.mockWorker?.pubkey ?? null}
            rpcUrl={state.rpcUrl}
            onToast={setToast}
          />,
        )}

        {panel('audit', <AuditPanel entries={audit} />)}

        {panel('docs', <DocsPanel onOpenTab={setActiveTab} />)}
      </main>

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
                <h2 id="wallet-dialog-title">{dict.walletModal.title}</h2>
                <p>{dict.walletModal.desc}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={dict.walletModal.close}
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

      {toast ? <div className={`toast ${toast.tone}`} role="status">{toast.text}</div> : null}
    </div>
  );
}
