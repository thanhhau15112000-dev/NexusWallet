import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildApprovalMessage,
  type AuditEntryView,
  type PaymentRequest,
} from '@nexus/shared';
import { api, type AgentState } from './api.js';
import { getPhantom, signApproval } from './phantom.js';
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
      setOffline(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 6000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const provider = getPhantom();
    setHasPhantom(Boolean(provider));
    if (!provider) return;
    // Reconnect silently if this site was already trusted by the wallet.
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => setWallet(res.publicKey.toString()))
      .catch(() => undefined);

    const onDisconnect = () => setWallet(null);
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
  }, []);

  // Bind the connected wallet as the agent owner. Attempted once per wallet so a
  // rejected bind cannot loop.
  useEffect(() => {
    if (!wallet || !state) return;
    if (state.owner === wallet || bindAttempt.current === wallet) return;
    bindAttempt.current = wallet;
    api
      .bindOwner(wallet)
      .then(() => refresh())
      .catch((err) => {
        // Allow a transient network failure to retry on the next refresh. A
        // pinned owner is intentionally not retried until the wallet changes.
        if (!state.ownerPinned) bindAttempt.current = null;
        setToast({ tone: 'bad', text: errorText(err) });
      });
  }, [wallet, state, refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const connect = async () => {
    const provider = getPhantom();
    if (!provider) return;
    setFlag('connect', true);
    try {
      const res = await provider.connect();
      setWallet(res.publicKey.toString());
    } catch (err) {
      setToast({ tone: 'bad', text: errorText(err) });
    } finally {
      setFlag('connect', false);
    }
  };

  const disconnect = async () => {
    await getPhantom()?.disconnect().catch(() => undefined);
    setWallet(null);
    bindAttempt.current = null;
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
      const signature = await signApproval(expected);
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
    return (
      <main className="boot">
        <h1>NexusWallet</h1>
        <p>{offline ? 'Service unavailable' : 'Loading'}</p>
        {offline ? <p className="bad-text">{offline}</p> : null}
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <div>
            <h1>NexusWallet</h1>
          </div>
        </div>
        <div className={`service-state ${offline ? 'is-offline' : ''}`}>
          <span className="status-dot" aria-hidden="true" />
          {offline ? 'Offline' : 'Ready'}
        </div>
      </header>

      {offline ? <div className="banner bad">Service unavailable: {offline}</div> : null}

      <div className="workspace-grid">
        <AgentPanel state={state} busy={Boolean(busy.airdrop)} onAirdrop={() => void airdrop()} />
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
