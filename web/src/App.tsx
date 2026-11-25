import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Clock,
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
import { HistoryPanel } from './components/HistoryPanel.js';
import { McpConnectPanel } from './components/McpConnectPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { ConsolePanel } from './components/ConsolePanel.js';
import { DocsPanel } from './components/DocsPanel.js';
import { OverviewPanel } from './components/OverviewPanel.js';
import { PolicyPanel } from './components/PolicyPanel.js';
import { RequestList } from './components/RequestList.js';
import { TaskVaultPanel } from './components/TaskVaultPanel.js';
import { LanguageToggle } from './components/SettingsMenu.js';
import { BootScreen } from './components/BootScreen.js';
import { Mono, Pill, shorten } from './components/ui.js';
import { Button } from './components/ui/button.js';
import { Badge } from './components/ui/badge.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './components/ui/dialog.js';
import { cn } from './lib/utils.js';
import { useI18n } from './i18n/context.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

type FeatureTab = 'wallet' | 'tasks' | 'commands' | 'policy' | 'approvals' | 'history' | 'audit' | 'docs';

type NavGroup = 'operate' | 'control' | 'resources';

// Sidebar order; arrow keys move through this list top to bottom.
const FEATURE_TABS: Array<{ id: FeatureTab; group: NavGroup; icon: typeof LayoutGrid }> = [
  { id: 'wallet', group: 'operate', icon: LayoutGrid },
  { id: 'commands', group: 'operate', icon: Command },
  { id: 'approvals', group: 'operate', icon: CheckCircle2 },
  { id: 'history', group: 'operate', icon: Clock },
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
    return <p className="py-2 text-xs text-muted">{dict.walletModal.noWallet}</p>;
  }

  return (
    <div className="flex flex-col gap-2" aria-label={dict.walletModal.availableWallets}>
      {props.choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-line bg-panel px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-50"
          disabled={props.busy}
          onClick={() => props.onSelect(choice)}
        >
          {choice.icon ? (
            <img src={choice.icon} alt="" className="h-5 w-5 rounded" />
          ) : (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-surface-muted text-muted">
              <WalletIcon size={14} aria-hidden="true" />
            </span>
          )}
          <span className="flex-1">{choice.name}</span>
          <span className="text-xs font-medium text-accent">{dict.walletModal.continue}</span>
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
  const [scrollToMcp, setScrollToMcp] = useState(false);
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

  // Runs after the commands tab is visible (panels stay mounted and only toggle `hidden`).
  // Must stay above the early return below: hooks cannot be called conditionally.
  useEffect(() => {
    if (!scrollToMcp || activeTab !== 'commands') return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('mcp-card')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    setScrollToMcp(false);
  }, [scrollToMcp, activeTab]);

  const summarise = useCallback(
    (request: PaymentRequest): Toast => {
      switch (request.status) {
        case 'confirmed':
          return { tone: 'ok', text: request.decision?.resolved?.type === 'get_balance' ? dict.toasts.balanceRead : dict.toasts.confirmed };
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

  const runCommand = async (prompt: string): Promise<string | null> => {
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
      return res.request.id;
    } catch (err) {
      // If the response was lost after the server accepted the request, a
      // manual retry must reuse the same idempotency key.
      commandRetry.current = retry;
      setToast({ tone: 'bad', text: errorText(err) });
      return null;
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

  const cancelPending = async (request: PaymentRequest) => {
    setApprovingId(request.id);
    try {
      await api.cancelRequest(request.id);
      setToast({ tone: 'warn', text: dict.toasts.requestCancelled });
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
      <BootScreen
        needsSignIn={needsSignIn}
        offline={offline}
        signInError={signInError}
        connecting={Boolean(busy.connect)}
        hasWallets={walletChoices.length > 0}
        pickerOpen={walletPickerOpen}
        onTogglePicker={() => setWalletPickerOpen((open) => !open)}
        walletOptions={
          <WalletOptions
            choices={walletChoices}
            busy={Boolean(busy.connect)}
            onSelect={(choice) => void connect(choice)}
          />
        }
      />
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

  // The panels stay mounted and only get `hidden`, so scroll after the commands tab is visible.
  const openMcpCard = () => {
    setActiveTab('commands');
    setScrollToMcp(true);
  };


  const panel = (tab: FeatureTab, content: React.ReactNode) => (
    <section
      id={`feature-panel-${tab}`}
      role="tabpanel"
      aria-labelledby={`feature-tab-${tab}`}
      className="space-y-4"
      hidden={activeTab !== tab}
    >
      {content}
    </section>
  );

  return (
    <div className="min-h-screen bg-bg text-ink lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <aside className="flex flex-col border-b border-line bg-panel lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2.5 px-5 py-4">
          <img src="/brand/logo.svg" alt="" width={26} height={26} className="h-6.5 w-6.5 shrink-0" />
          <span className="text-base font-semibold [font-stretch:112%] text-ink">nexusPay</span>
          <Badge variant="ok" className="ml-auto capitalize">
            {state.cluster}
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="lg:hidden"
            aria-expanded={navOpen}
            aria-controls="side-nav"
            aria-label={navOpen ? dict.nav.closeMenu : dict.nav.openMenu}
            onClick={() => setNavOpen((open) => !open)}
          >
            {navOpen ? <X size={17} aria-hidden="true" /> : <Menu size={17} aria-hidden="true" />}
          </Button>
        </div>

        <nav
          id="side-nav"
          className={cn(
            'flex-1 overflow-y-auto px-3 py-2 space-y-5',
            navOpen ? 'block' : 'hidden lg:block',
          )}
          role="tablist"
          aria-orientation="vertical"
          aria-label="App features"
        >
          {NAV_GROUPS.map((group) => (
            <div key={group} className="space-y-0.5" role="presentation">
              <span
                className="block px-2.5 pb-1.5 text-xs font-medium text-muted"
                role="presentation"
              >
                {dict.nav[group]}
              </span>
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
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      selected
                        ? 'bg-accent-soft font-semibold text-accent-strong [&_svg]:text-accent'
                        : 'font-medium text-muted hover:bg-surface-muted hover:text-ink',
                    )}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setNavOpen(false);
                    }}
                    onKeyDown={(event) => selectTabWithKeyboard(event, index)}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden="true" />
                    <span className="flex-1 truncate">{dict.tabs[tab.id]}</span>
                    {tab.id === 'approvals' && pendingApprovals > 0 ? (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-apricot px-1.5 text-[11px] font-semibold text-ink tabular-nums">
                        {pendingApprovals}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={cn('border-t border-line p-4 space-y-3', navOpen ? 'block' : 'hidden lg:block')}>
          {wallet ? (
            <>
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
                  aria-hidden="true"
                >
                  <WalletIcon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted">{dict.wallet.title}</span>
                    {ownerRole}
                  </div>
                  <Mono title={wallet} className="block truncate text-ink">
                    {shorten(wallet, 5)}
                  </Mono>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-center"
                onClick={() => void disconnect()}
              >
                <LogOut size={13} aria-hidden="true" />
                {authRequired ? dict.wallet.logout : dict.wallet.disconnect}
              </Button>
            </>
          ) : (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="default"
                size="sm"
                className="w-full"
                disabled={!walletChoices.length || Boolean(busy.connect)}
                onClick={() => {
                  setNavOpen(false);
                  setWalletPickerOpen(true);
                }}
              >
                {busy.connect ? dict.wallet.connecting : dict.wallet.connectWallet}
              </Button>
              {!walletChoices.length ? (
                <p className="text-xs text-muted">{dict.wallet.installPhantom}</p>
              ) : null}
            </div>
          )}
        </div>
      </aside>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold [font-stretch:112%] text-ink">{dict.tabs[activeTab]}</h1>
          <div className="flex items-center gap-2.5">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                offline
                  ? 'border-bad-line bg-bad-soft text-bad'
                  : 'border-line bg-panel text-muted',
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', offline ? 'bg-bad' : 'bg-accent')}
                aria-hidden="true"
              />
              {offline ? dict.topbar.offline : dict.topbar.ready}
            </span>
            <LanguageToggle />
          </div>
        </header>

        {offline ? (
          <div className="mb-4 rounded-md border border-bad-line bg-bad-soft px-3.5 py-2.5 text-xs font-medium text-bad">
            {interpolate(dict.walletModal.serviceUnavailable, { offline })}
          </div>
        ) : null}

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
            onOpenMcp={openMcpCard}
          />,
        )}

        {panel(
          'commands',
          <div className="space-y-4">
            <ConsolePanel
              state={state}
              busy={Boolean(busy.command)}
              requests={requests}
              connected={Boolean(wallet)}
              onRun={runCommand}
              onOpenPolicy={() => setActiveTab('policy')}
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
            onCancel={(request) => void cancelPending(request)}
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
            connected={Boolean(wallet)}
            agentPubkey={state.agent.pubkey}
            mockWorkerPubkey={state.mockWorker?.pubkey ?? null}
            rpcUrl={state.rpcUrl}
            onToast={setToast}
          />,
        )}

        {panel('audit', <AuditPanel entries={audit} />)}

        {panel('history', <HistoryPanel active={activeTab === 'history'} requests={requests} onViewAll={() => setActiveTab('approvals')} />)}

        {panel('docs', <DocsPanel onOpenTab={setActiveTab} />)}
      </main>

      <Dialog
        open={walletPickerOpen}
        onOpenChange={(open) => {
          if (!busy.connect) setWalletPickerOpen(open);
        }}
      >
        <DialogContent closeLabel={dict.walletModal.close} disableClose={Boolean(busy.connect)}>
          <DialogHeader>
            <DialogTitle>{dict.walletModal.title}</DialogTitle>
            <DialogDescription>{dict.walletModal.desc}</DialogDescription>
          </DialogHeader>
          <WalletOptions
            choices={walletChoices}
            busy={Boolean(busy.connect)}
            onSelect={(choice) => void connect(choice)}
          />
        </DialogContent>
      </Dialog>

      {toast ? (
        <div
          role="status"
          className={cn(
            'fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm font-medium shadow-lg',
            toast.tone === 'ok' && 'border-accent-line bg-panel text-ink',
            toast.tone === 'warn' && 'border-warn-line bg-warn-soft text-warn',
            toast.tone === 'bad' && 'border-bad-line bg-bad-soft text-bad',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
