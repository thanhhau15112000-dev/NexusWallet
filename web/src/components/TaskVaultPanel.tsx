import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Coins,
  ExternalLink,
  Layers,
  Play,
  Plus,
  RefreshCw,
  Shield,
  XCircle,
} from 'lucide-react';
import {
  LAMPORTS_PER_SOL,
  DEFAULT_MOCK_WORKER_PUBKEY,
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
  createAndFundTaskInstruction,
  closeReceiptInstruction,
  refundAndCloseInstruction,
  revokeTaskInstruction,
  deriveTaskCapabilityPda,
  deriveReceiptPda,
} from '@nexus/shared';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getPhantom } from '../phantom.js';
import { api, ApiError } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';

export function TaskVaultPanel(props: {
  owner: string | null;
  agentPubkey: string;
  rpcUrl: string;
  onToast: (toast: { tone: 'ok' | 'warn' | 'bad'; text: string }) => void;
}) {
  const [tasks, setTasks] = useState<TaskCapabilityRecord[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    task: TaskCapabilityRecord;
    payments: TaskPaymentRecord[];
    receipts: TaskReceiptRecord[];
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Create form state
  const [newTaskId, setNewTaskId] = useState(`task-${Date.now().toString(36)}`);
  const [newBudgetSol, setNewBudgetSol] = useState('0.5');
  const [newCapSol, setNewCapSol] = useState('0.2');
  const [newHours, setNewHours] = useState('24');
  const [newAllowedWorker, setNewAllowedWorker] = useState('');
  const [newAllowedServiceId, setNewAllowedServiceId] = useState('');
  const [submitOnchain, setSubmitOnchain] = useState(true);

  // Payment form state
  const [paymentWorker, setPaymentWorker] = useState(DEFAULT_MOCK_WORKER_PUBKEY);
  const [paymentService, setPaymentService] = useState('service-data-enrichment');
  const [paymentAmountSol, setPaymentAmountSol] = useState('0.1');

  const loadTasks = async (selectId?: string) => {
    setLoading(true);
    try {
      const res = await api.tasks();
      setTasks(res.tasks);
      const targetId = selectId ?? selectedTaskId ?? res.tasks[0]?.taskId ?? null;
      if (targetId) {
        setSelectedTaskId(targetId);
        const detailRes = await api.taskDetail(targetId);
        setDetail(detailRes);
      } else {
        setDetail(null);
      }
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : 'Failed to load task capabilities',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [props.owner]);

  const selectTask = async (taskId: string) => {
    setSelectedTaskId(taskId);
    try {
      const detailRes = await api.taskDetail(taskId);
      setDetail(detailRes);
    } catch (err) {
      props.onToast({ tone: 'bad', text: 'Failed to load task details' });
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!props.owner) {
      props.onToast({ tone: 'warn', text: 'Connect your owner wallet first' });
      return;
    }
    const budgetSol = Number(newBudgetSol);
    const capSol = Number(newCapSol);
    const hours = Number(newHours);
    if (!budgetSol || budgetSol <= 0 || !capSol || capSol <= 0) {
      props.onToast({ tone: 'warn', text: 'Enter valid positive SOL amounts' });
      return;
    }
    if (capSol > budgetSol) {
      props.onToast({ tone: 'warn', text: 'Per-payment cap cannot exceed budget' });
      return;
    }
    if (submitOnchain && newAllowedWorker.trim()) {
      try {
        if (new PublicKey(newAllowedWorker.trim()).toBase58() !== DEFAULT_MOCK_WORKER_PUBKEY) {
          props.onToast({ tone: 'warn', text: 'On-chain demo tasks currently use the configured mock worker' });
          return;
        }
      } catch {
        props.onToast({ tone: 'warn', text: 'Allowed worker must be a valid Solana address' });
        return;
      }
    }

    setBusyAction('create');
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + Math.round(hours * 3600);
      let txSignature: string | undefined;

      if (submitOnchain) {
        const provider = getPhantom();
        if (!provider) {
          props.onToast({ tone: 'warn', text: 'Phantom wallet not detected for on-chain submission' });
          setBusyAction(null);
          return;
        }
        const connection = new Connection(props.rpcUrl, 'confirmed');
        const ownerPubkey = new PublicKey(props.owner);
        const agentPubkey = new PublicKey(props.agentPubkey);

        const ix = createAndFundTaskInstruction({
          owner: ownerPubkey,
          agentSigner: agentPubkey,
          taskId: newTaskId.trim(),
          budgetLamports: Math.round(budgetSol * LAMPORTS_PER_SOL),
          perPaymentCapLamports: Math.round(capSol * LAMPORTS_PER_SOL),
          allowedWorker: newAllowedWorker.trim() ? new PublicKey(newAllowedWorker.trim()) : undefined,
          allowedServiceId: newAllowedServiceId.trim() || undefined,
          expiry,
        });

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = ownerPubkey;

        const { signature } = await provider.signAndSendTransaction(tx as any);
        txSignature = signature;
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        if (confirmation.value.err) {
          throw new Error('On-chain task creation transaction failed');
        }
      }

      const res = await api.createTask({
        taskId: newTaskId.trim(),
        budgetLamports: Math.round(budgetSol * LAMPORTS_PER_SOL),
        perPaymentCapLamports: Math.round(capSol * LAMPORTS_PER_SOL),
        expiry,
        allowedWorker: newAllowedWorker.trim() || undefined,
        allowedServiceId: newAllowedServiceId.trim() || undefined,
        txSignature,
        isSimulated: !txSignature,
      });

      if (txSignature) {
        props.onToast({
          tone: 'ok',
          text: `Task Capability funded on Solana Devnet: ${shorten(txSignature, 4)}`,
        });
      } else {
        props.onToast({
          tone: 'ok',
          text: `Task Capability "${res.task.taskId}" created in simulation mode`,
        });
      }

      setNewTaskId(`task-${Date.now().toString(36)}`);
      await loadTasks(res.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to create task vault',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleExecutePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const amountSol = Number(paymentAmountSol);
    if (!amountSol || amountSol <= 0) {
      props.onToast({ tone: 'warn', text: 'Enter a valid payment amount' });
      return;
    }
    const worker = paymentWorker.trim() || props.owner || props.agentPubkey;

    if (detail.task.allowedWorker && worker !== detail.task.allowedWorker) {
      props.onToast({
        tone: 'warn',
        text: `Worker ${shorten(worker, 4)} does not match allowed worker ${shorten(detail.task.allowedWorker, 4)}`,
      });
      return;
    }

    if (detail.task.allowedServiceId && paymentService.trim() !== detail.task.allowedServiceId) {
      props.onToast({
        tone: 'warn',
        text: `Service "${paymentService}" does not match allowed service "${detail.task.allowedServiceId}"`,
      });
      return;
    }

    setBusyAction('execute_payment');
    try {
      const paymentId = `pay-${Date.now().toString(36)}`;
      const requestHash = `reqhash-${Date.now().toString(36)}`;
      const result = await api.executeTaskPayment(detail.task.taskId, {
        paymentId,
        worker,
        serviceId: paymentService.trim(),
        amountLamports: Math.round(amountSol * LAMPORTS_PER_SOL),
        requestHash,
      });
      props.onToast({
        tone: 'ok',
        text: result.payment.txSignature
          ? `On-chain escrow ${paymentId}: ${shorten(result.payment.txSignature, 4)}`
          : `Simulated escrow ${paymentId} locked in vault`,
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : 'Payment rejected by capability guard',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSettleMockPayment = async (paymentId: string, serviceId: string) => {
    if (!detail) return;
    setBusyAction(`settle-${paymentId}`);
    try {
      // 1. Run mock computation to acquire proof hash and worker receipt signature
      const mockResult = await api.runMockService({
        taskId: detail.task.taskId,
        paymentId,
        serviceId,
        payload: { simulatedTask: detail.task.taskId, paymentId },
      });
      // 2. Submit settlement receipt with cryptographic worker signature
      const result = await api.settleTaskPayment(detail.task.taskId, paymentId, {
        resultHash: mockResult.resultHash,
        workerPubkey: mockResult.workerPubkey,
        workerSignature: mockResult.workerSignature,
      });
      props.onToast({
        tone: 'ok',
        text: result.receipt.txSignature
          ? `On-chain settlement ${paymentId}: ${shorten(result.receipt.txSignature, 4)}`
          : `Simulated settlement ${paymentId} recorded with worker receipt`,
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : 'Failed to settle escrow payment',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCloseReceipt = async (paymentId: string) => {
    if (!detail || !props.owner) return;
    setBusyAction(`close-receipt-${paymentId}`);
    try {
      const provider = getPhantom();
      if (!provider) throw new Error('Phantom wallet is required to reclaim receipt rent');
      const connection = new Connection(props.rpcUrl, 'confirmed');
      const ownerPubkey = new PublicKey(props.owner);
      const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, detail.task.taskId);
      const [receiptPda] = deriveReceiptPda(taskPda, paymentId);
      const instruction = closeReceiptInstruction({
        taskCapability: taskPda,
        receipt: receiptPda,
        authority: ownerPubkey,
        rentRecipient: ownerPubkey,
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction().add(instruction);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = ownerPubkey;
      const { signature } = await provider.signAndSendTransaction(transaction as any);
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error('Receipt close transaction failed');
      await api.closeTaskReceipt(detail.task.taskId, paymentId, signature);
      props.onToast({ tone: 'ok', text: `Receipt rent reclaimed: ${shorten(signature, 4)}` });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to close receipt' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRevoke = async (taskId: string) => {
    setBusyAction(`revoke-${taskId}`);
    try {
      let txSignature: string | undefined;
      if (detail?.task.isSimulated === false) {
        if (!props.owner) throw new Error('Connect the owner wallet to revoke this on-chain task');
        const provider = getPhantom();
        if (!provider) throw new Error('Phantom wallet is required to revoke this on-chain task');
        const connection = new Connection(props.rpcUrl, 'confirmed');
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, taskId);
        const ix = revokeTaskInstruction({ taskCapability: taskPda, owner: ownerPubkey });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = ownerPubkey;
        const { signature } = await provider.signAndSendTransaction(tx as any);
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) throw new Error('On-chain revoke transaction failed');
        txSignature = signature;
      }
      await api.revokeTask(taskId, txSignature);
      props.onToast({ tone: 'warn', text: `Task Capability "${taskId}" has been revoked` });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : 'Revoke failed' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefund = async (taskId: string) => {
    setBusyAction(`refund-${taskId}`);
    try {
      let txSignature: string | undefined;
      if (detail?.task.isSimulated === false) {
        if (!props.owner) throw new Error('Connect the owner wallet to close this on-chain task');
        const provider = getPhantom();
        if (!provider) throw new Error('Phantom wallet is required to close this on-chain task');
        const connection = new Connection(props.rpcUrl, 'confirmed');
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, taskId);
        const ix = refundAndCloseInstruction({
          taskCapability: taskPda,
          owner: ownerPubkey,
          caller: ownerPubkey,
        });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = ownerPubkey;
        const { signature } = await provider.signAndSendTransaction(tx as any);
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) throw new Error('On-chain refund transaction failed');
        txSignature = signature;
      }
      const res = await api.refundTask(taskId, txSignature);
      props.onToast({
        tone: 'ok',
        text: `Vault closed: ${(res.refundedLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL refunded to owner`,
      });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : 'Refund failed' });
    } finally {
      setBusyAction(null);
    }
  };

  const statusTone = (status: string): 'ok' | 'warn' | 'bad' | 'neutral' => {
    switch (status) {
      case 'active':
        return 'ok';
      case 'completed':
        return 'neutral';
      case 'revoked':
        return 'bad';
      case 'expired':
        return 'warn';
      default:
        return 'neutral';
    }
  };

  // Mirrors close_receipt: the capability must still exist and no longer accept payments.
  const receiptsClosable = Boolean(detail)
    && !detail!.task.isClosed
    && (detail!.task.status !== 'active' || Math.floor(Date.now() / 1000) >= detail!.task.expiry);

  return (
    <div className="task-vault-container">
      {/* Non-Custodial Architecture Notice Banner */}
      <div className="vault-architecture-notice">
        <div className="notice-icon">
          <Shield size={24} />
        </div>
        <div className="notice-content">
          <div className="notice-title">
            <strong>Task Capability Vault — Programmable Agent Treasury</strong>
            {detail?.task.txSignature ? (
              <a
                href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                className="explorer-link-pill"
              >
                <Pill tone="ok">On-Chain Devnet: {shorten(detail.task.txSignature, 4)}</Pill>
              </a>
            ) : detail?.task ? (
              <Pill tone="neutral">Off-Chain State (Simulated)</Pill>
            ) : (
              <Pill tone="neutral">Task Capability Engine</Pill>
            )}
          </div>
          <p>
            The agent never holds or withdraws the owner's funds. Instead, the owner grants a bounded{' '}
            <strong>Task Capability</strong> locking funds in an on-chain Vault PDA. The agent can only execute
            authorized payments into Escrow PDAs, which are released exclusively upon valid worker settlement
            receipts. Unused balances are refunded automatically.
          </p>
          <div className="notice-comparison">
            <span className="contrast-tag legacy">Legacy Direct-Key Mode: Off-chain encrypted key</span>
            <ArrowRight size={14} />
            <span className="contrast-tag modern">Task Capability Vault: Non-custodial PDA Escrow</span>
          </div>
        </div>
      </div>

      <div className="vault-grid">
        {/* Left Column: Create Task & Task Selector */}
        <div className="vault-sidebar">
          <Card
            title="Fund New Task Capability"
            titleIcon={<Plus size={16} />}
            className="create-task-card"
          >
            <form onSubmit={handleCreateTask} className="task-form">
              <label>
                <span>Task ID / Nonce</span>
                <input
                  type="text"
                  value={newTaskId}
                  onChange={(e) => setNewTaskId(e.target.value)}
                  placeholder="e.g. task-ai-market-eval"
                  required
                />
              </label>

              <div className="form-row">
                <label>
                  <span>Total Budget (SOL)</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.01"
                    value={newBudgetSol}
                    onChange={(e) => setNewBudgetSol(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Per-Payment Cap (SOL)</span>
                  <input
                    type="number"
                    step="0.05"
                    min="0.01"
                    value={newCapSol}
                    onChange={(e) => setNewCapSol(e.target.value)}
                    required
                  />
                </label>
              </div>

              <div className="form-row">
                <label>
                  <span>Allowed Worker (optional)</span>
                  <input
                    type="text"
                    value={newAllowedWorker}
                    onChange={(e) => setNewAllowedWorker(e.target.value)}
                    placeholder="Leave blank for any"
                  />
                </label>
                <label>
                  <span>Allowed Service (optional)</span>
                  <input
                    type="text"
                    value={newAllowedServiceId}
                    onChange={(e) => setNewAllowedServiceId(e.target.value)}
                    placeholder="e.g. service-data-enrichment"
                  />
                </label>
              </div>

              <label>
                <span>Expiry Duration (hours)</span>
                <input
                  type="number"
                  min="1"
                  max="168"
                  value={newHours}
                  onChange={(e) => setNewHours(e.target.value)}
                  required
                />
              </label>

              <label className="checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', margin: '8px 0' }}>
                <input
                  type="checkbox"
                  checked={submitOnchain}
                  onChange={(e) => setSubmitOnchain(e.target.checked)}
                />
                <span style={{ fontSize: '0.82rem' }}>Broadcast on-chain to Solana Devnet via Phantom</span>
              </label>

              <button
                type="submit"
                className="primary"
                disabled={busyAction === 'create' || !props.owner}
              >
                {busyAction === 'create' ? 'Funding Task Vault…' : 'Fund Task Capability Vault'}
              </button>
              {!props.owner ? (
                <span className="hint-warn">Connect wallet above to fund task capabilities</span>
              ) : null}
            </form>
          </Card>

          <Card
            title="Active Task Capabilities"
            titleIcon={<Layers size={16} />}
            actions={
              <button
                type="button"
                className="link button-with-icon"
                onClick={() => void loadTasks()}
                disabled={loading}
              >
                <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                Refresh
              </button>
            }
          >
            {tasks.length === 0 ? (
              <div className="empty-state">No task capabilities found. Fund one above!</div>
            ) : (
              <ul className="task-list">
                {tasks.map((t) => {
                  const isSelected = t.taskId === selectedTaskId;
                  const spentSol = t.spentLamports / LAMPORTS_PER_SOL;
                  const budgetSol = t.budgetLamports / LAMPORTS_PER_SOL;
                  return (
                    <li
                      key={t.taskId}
                      className={`task-list-item${isSelected ? ' is-selected' : ''}`}
                      onClick={() => void selectTask(t.taskId)}
                    >
                      <div className="task-item-head">
                        <strong>{t.taskId}</strong>
                        <Pill tone={statusTone(t.status)}>{t.status}</Pill>
                      </div>
                      <div className="task-item-progress">
                        <div
                          className="progress-bar-fill"
                          style={{ width: `${Math.min(100, (spentSol / budgetSol) * 100)}%` }}
                        />
                      </div>
                      <div className="task-item-footer">
                        <span>
                          {spentSol.toFixed(3)} / {budgetSol.toFixed(3)} SOL
                        </span>
                        <span className="task-cap-info">
                          cap {(t.perPaymentCapLamports / LAMPORTS_PER_SOL).toFixed(3)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* Right Column: Selected Task Details, Escrows, and Payments */}
        <div className="vault-main">
          {detail ? (
            <>
              <Card
                title={`Task: ${detail.task.taskId}`}
                titleIcon={<Coins size={16} />}
                actions={
                  <div className="task-actions-group">
                    {detail.task.status === 'active' ? (
                      <button
                        type="button"
                        className="bad-button"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleRevoke(detail.task.taskId)}
                      >
                        Revoke Task
                      </button>
                    ) : null}
                    {!detail.task.isClosed ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyAction)}
                        onClick={() => void handleRefund(detail.task.taskId)}
                      >
                        Refund & Close
                      </button>
                    ) : null}
                  </div>
                }
              >
                <div className="task-summary-grid">
                  <div className="summary-stat">
                    <span className="stat-label">Status</span>
                    <Pill tone={statusTone(detail.task.status)}>{detail.task.status}</Pill>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Execution Mode</span>
                    {detail.task.txSignature ? (
                      <a
                        href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Pill tone="ok">Devnet Tx</Pill>
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <Pill tone="neutral">Simulated</Pill>
                    )}
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Total Budget</span>
                    <strong>{(detail.task.budgetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Total Spent</span>
                    <strong>{(detail.task.spentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Remaining in Vault</span>
                    <strong className="ok-value">
                      {(
                        Math.max(0, detail.task.budgetLamports - detail.task.spentLamports) /
                        LAMPORTS_PER_SOL
                      ).toFixed(4)}{' '}
                      SOL
                    </strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Per-Payment Cap</span>
                    <span>{(detail.task.perPaymentCapLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Allowed Worker</span>
                    <span>{detail.task.allowedWorker ? shorten(detail.task.allowedWorker, 4) : 'Any'}</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Allowed Service</span>
                    <span>{detail.task.allowedServiceId || 'Any'}</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">Expires At</span>
                    <span>{new Date(detail.task.expiry * 1000).toLocaleString()}</span>
                  </div>
                </div>

                <div className="pda-bindings">
                  <div className="pda-item">
                    <span className="pda-label">Capability PDA:</span>
                    <Mono>{shorten(detail.task.pda ?? '—', 8)}</Mono>
                    {detail.task.pda ? (
                      <CopyAddressButton value={detail.task.pda} label="Copy capability PDA" />
                    ) : null}
                  </div>
                  <div className="pda-item">
                    <span className="pda-label">Vault PDA:</span>
                    <Mono>{shorten(detail.task.vaultPda ?? '—', 8)}</Mono>
                    {detail.task.vaultPda ? (
                      <CopyAddressButton value={detail.task.vaultPda} label="Copy vault PDA" />
                    ) : null}
                  </div>
                  {detail.task.txSignature ? (
                    <div className="pda-item">
                      <span className="pda-label">Devnet Tx:</span>
                      <a
                        href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--c-accent)' }}
                      >
                        <Mono>{shorten(detail.task.txSignature, 8)}</Mono>
                        <ExternalLink size={12} />
                      </a>
                    </div>
                  ) : null}
                </div>
              </Card>

              {/* Multi-step Payment Simulator */}
              {detail.task.status === 'active' ? (
                <Card
                  title="Execute Payment into Escrow"
                  titleIcon={<Play size={16} />}
                  className="execute-payment-card"
                >
                  <form onSubmit={handleExecutePayment} className="payment-form">
                    <div className="form-row">
                      <label>
                        <span>Worker Address</span>
                        <input
                          type="text"
                          value={paymentWorker}
                          onChange={(e) => setPaymentWorker(e.target.value)}
                          placeholder="Defaults to owner/agent if empty"
                        />
                      </label>
                      <label>
                        <span>Service / Protocol ID</span>
                        <input
                          type="text"
                          value={paymentService}
                          onChange={(e) => setPaymentService(e.target.value)}
                          required
                        />
                      </label>
                      <label>
                        <span>Amount (SOL)</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0.001"
                          value={paymentAmountSol}
                          onChange={(e) => setPaymentAmountSol(e.target.value)}
                          required
                        />
                      </label>
                    </div>

                    <button
                      type="submit"
                      className="primary"
                      disabled={busyAction === 'execute_payment'}
                    >
                      {busyAction === 'execute_payment' ? 'Locking Escrow…' : 'Execute Task Payment (Lock Escrow)'}
                    </button>
                  </form>
                </Card>
              ) : null}

              {/* Escrow & Payment List */}
              <Card title="Escrow Payments & Receipt Proofs" titleIcon={<Clock size={16} />}>
                {detail.payments.length === 0 ? (
                  <div className="empty-state">No payments executed under this task yet.</div>
                ) : (
                  <div className="escrows-table-wrapper">
                    <table className="escrows-table">
                      <thead>
                        <tr>
                          <th>Payment ID</th>
                          <th>Service</th>
                          <th>Worker</th>
                          <th>Amount</th>
                          <th>Status</th>
                          <th>Settlement / Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.payments.map((p) => {
                          const receipt = detail.receipts.find((r) => r.paymentId === p.paymentId);
                          return (
                            <tr key={p.paymentId}>
                              <td>
                                <Mono>{p.paymentId}</Mono>
                              </td>
                              <td>{p.serviceId}</td>
                              <td>
                                <Mono title={p.worker}>{shorten(p.worker, 4)}</Mono>
                              </td>
                              <td>
                                <strong>{(p.amountLamports / LAMPORTS_PER_SOL).toFixed(3)} SOL</strong>
                              </td>
                              <td>
                                <Pill tone={p.status === 'settled' ? 'ok' : 'warn'}>
                                  {p.status}
                                </Pill>
                                {p.txSignature ? (
                                  <a href={`https://explorer.solana.com/tx/${p.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">
                                    <Pill tone="ok">On-Chain Devnet</Pill>
                                  </a>
                                ) : <Pill tone="neutral">Simulated</Pill>}
                              </td>
                              <td>
                                {receipt ? (
                                  <div className="receipt-proof-badge">
                                    <CheckCircle2 size={14} className="ok-icon" />
                                    <Mono title={receipt.resultHash}>
                                      proof {shorten(receipt.resultHash, 4)}
                                    </Mono>
                                    {receipt.txSignature ? (
                                      <a href={`https://explorer.solana.com/tx/${receipt.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">
                                        <Pill tone="ok">On-Chain Devnet</Pill>
                                      </a>
                                    ) : <Pill tone="neutral">Simulated</Pill>}
                                    {receipt.isSimulated === false && !receipt.isClosed && !receiptsClosable ? (
                                      <span title="On-chain receipts block payment-id replay until the task is revoked, completed or expired">
                                        Rent locked until task ends
                                      </span>
                                    ) : receipt.isSimulated === false && !receipt.isClosed ? (
                                      <button
                                        type="button"
                                        className="link primary-link"
                                        title="Close receipt and reclaim rent"
                                        disabled={Boolean(busyAction)}
                                        onClick={() => void handleCloseReceipt(receipt.paymentId)}
                                      >
                                        <XCircle size={14} />
                                        {busyAction === `close-receipt-${receipt.paymentId}` ? 'Closing…' : 'Reclaim rent'}
                                      </button>
                                    ) : receipt.isClosed ? <span>Rent reclaimed</span> : null}
                                  </div>
                                ) : p.status === 'held' ? (
                                  <button
                                    type="button"
                                    className="link primary-link"
                                    disabled={Boolean(busyAction)}
                                    onClick={() => void handleSettleMockPayment(p.paymentId, p.serviceId)}
                                  >
                                    {busyAction === `settle-${p.paymentId}`
                                      ? 'Settling…'
                                      : 'Settle with Receipt'}
                                  </button>
                                ) : (
                                  <span>Refunded</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </>
          ) : (
            <Card title="Task Capability Details">
              <div className="empty-state">Select or fund a Task Capability to view details and escrows.</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
