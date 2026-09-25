import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  buildApprovalMessage,
  type AuditEntryView,
  type PaymentRequest,
} from '@nexus/shared';
import { api, ApiError, type AgentState } from './api.js';
import { getPhantom, sendSolFromPhantom, signPhantomMessage } from './phantom.js';
import { AgentPanel } from './components/AgentPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { ConsolePanel } from './components/ConsolePanel.js';
import { PolicyPanel } from './components/PolicyPanel.js';
import { RequestList } from './components/RequestList.js';
import { WalletPanel } from './components/WalletPanel.js';

type Toast = { tone: 'ok' | 'warn' | 'bad'; text: string };

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

export function App() {
  const [state, setState] = useState<AgentState | null>(null);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntryView[]>([]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [hasPhantom, setHasPhantom] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authOwner, setAuthOwner] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const bindAttempt = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const commandRetry = useRef<{ prompt: string; key: string } | null>(null);

  const setFlag = (key: string, value: boolean) =>
    setBusy((prev) => ({ ...prev, [key]: value }));

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
        setOffline('Session expired. Sign in with the pinned Phantom wallet again.');
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
    const provider = getPhantom();
    setHasPhantom(Boolean(provider));
    if (!provider) return;
    // Reconnect silently if this site was already trusted by the wallet.
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => setWallet(res.publicKey.toString()))
      .catch(() => undefined);

    const onDisconnect = () => {
      setWallet(null);
      if (authRequired) void logoutSession();
    };
    const onAccountChanged = (next: unknown) => {
      setWallet(next ? String(next) : null);
      bindAttempt.current = null;
    };
    provider.on('disconnect', onDisconnect);
    provider.on('accountChanged', onAccountChanged);

    return () => {
      provider.off?.('disconnect', onDisconnect);
      provider.off?.('accountChanged', onAccountChanged);
    };
  }, [authRequired, logoutSession]);

  useEffect(() => {
    if (authRequired && authenticated && authOwner && wallet && wallet !== authOwner) {
      void logoutSession();
    }
  }, [authRequired, authenticated, authOwner, wallet, logoutSession]);

  // In multi-tenant mode, the owner is bound to their session upon Phantom login.

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
    if (!wallet || !state) return;
    setFlag('deposit', true);
    try {
      const signature = await sendSolFromPhantom({
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

  const connect = async () => {
    const provider = getPhantom();
    if (!provider) return;
    setFlag('connect', true);
    try {
      const res = await provider.connect();
      const pubkey = res.publicKey.toString();
      setWallet(pubkey);
      if (authRequired && (!authenticated || authOwner !== pubkey)) {
        const challenge = await api.authChallenge(pubkey);
        const signature = await signPhantomMessage(challenge.message);
        const session = await api.authLogin({
          challengeId: challenge.challengeId,
          pubkey,
          signature,
        });
        setAuthenticated(true);
        setAuthOwner(session.owner);
        setOffline(null);
      }
    } catch (err) {
      setOffline(errorText(err));
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('connect', false);
    }
  };

  const disconnect = async () => {
    await getPhantom()?.disconnect().catch(() => undefined);
    setWallet(null);
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
    if (!wallet || !request.approval) return;
    setApprovingId(request.id);
    try {
      // Rebuild the message locally. If the server's copy differs in any byte,
      // refuse to sign rather than trusting what was handed to us.
      const expected = buildApprovalMessage(request.approval.payload);
      if (expected !== request.approval.message) {
        throw new Error('approval message does not match its payload; refusing to sign');
      }
      const signature = await signPhantomMessage(expected);
      const res = await api.approve(request.id, signature, wallet);
      setToast(summarise(res.request));
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setApprovingId(null);
      await refresh();
    }
  };

  if (!state) {
    const needsSignIn = authReady && authRequired && !authenticated;
    return (
      <main className="boot">
        <h1>nexusPay</h1>
        <p>{needsSignIn ? 'Sign in required' : offline ? 'Service unavailable' : 'Loading'}</p>
        {offline ? <p className="bad-text">{offline}</p> : null}
        {authReady && authRequired && !authenticated ? (
          <>
            <p>Sign in with the pinned Phantom wallet. The message signature only creates a session.</p>
            <button
              type="button"
              className="primary"
              disabled={!hasPhantom || Boolean(busy.connect)}
              onClick={() => void connect()}
            >
              {busy.connect ? 'Connecting…' : 'Sign in with Phantom'}
            </button>
            {!hasPhantom ? (
              <p><a href="https://phantom.app/download" target="_blank" rel="noreferrer">Install Phantom</a></p>
            ) : null}
          </>
        ) : null}
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
        </div>
        <div className={`service-state ${offline ? 'is-offline' : ''}`}>
          <Activity size={15} aria-hidden="true" />
          {offline ? 'Offline' : 'Ready'}
        </div>
      </header>

      {offline ? <div className="banner bad">Service unavailable: {offline}</div> : null}

      <div className="workspace-grid">
        <AgentPanel
          state={state}
          busy={Boolean(busy.airdrop || busy.seed || busy.deposit)}
          onAirdrop={() => void airdrop()}
          onClaimSeed={() => void claimSeed()}
          onDeposit={(amount) => void deposit(amount)}
        />
        <WalletPanel
          state={state}
          wallet={wallet}
          hasPhantom={hasPhantom}
          busy={Boolean(busy.connect)}
          onConnect={() => void connect()}
          onDisconnect={() => void disconnect()}
        />
        <PolicyPanel
          state={state}
          wallet={wallet}
          busy={Boolean(busy.policy)}
          onSave={savePolicy}
        />
        <ConsolePanel state={state} busy={Boolean(busy.command)} onRun={runCommand} />
      </div>

      <RequestList
        requests={requests}
        wallet={wallet}
        owner={state.owner}
        busyId={approvingId}
        onApprove={(request) => void approve(request)}
      />

      <AuditPanel entries={audit} />

      {toast ? <div className={`toast ${toast.tone}`}>{toast.text}</div> : null}
    </main>
  );
}
