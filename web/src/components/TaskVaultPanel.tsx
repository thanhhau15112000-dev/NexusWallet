import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Coins,
  ExternalLink,
  Layers,
  Play,
  Plus,
  RefreshCw,
  XCircle,
} from './icons.js';
import {
  LAMPORTS_PER_SOL,
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
import { useI18n } from '../i18n/context.js';

export function TaskVaultPanel(props: {
  owner: string | null;
  agentPubkey: string;
  mockWorkerPubkey: string | null;
  rpcUrl: string;
  onToast: (toast: { tone: 'ok' | 'warn' | 'bad'; text: string }) => void;
}) {
  const { dict, interpolate } = useI18n();
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
  const [newAllowedWorker, setNewAllowedWorker] = useState(props.mockWorkerPubkey ?? '');
  const [newAllowedServiceId, setNewAllowedServiceId] = useState('');
  const [submitOnchain, setSubmitOnchain] = useState(true);

  // Payment form state
  const [paymentWorker, setPaymentWorker] = useState(props.mockWorkerPubkey ?? '');
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
        text: err instanceof ApiError ? err.message : dict.taskVault.toasts.loadFailed,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, [props.owner]);

  // Follow the selected task's allowlist so the payment form does not start out mismatched.
  const selectedWorker = detail?.task.allowedWorker;
  const selectedService = detail?.task.allowedServiceId;
  useEffect(() => {
    if (selectedWorker) setPaymentWorker(selectedWorker);
    if (selectedService) setPaymentService(selectedService);
  }, [detail?.task.taskId, selectedWorker, selectedService]);

  const selectTask = async (taskId: string) => {
    setSelectedTaskId(taskId);
    try {
      const detailRes = await api.taskDetail(taskId);
      setDetail(detailRes);
    } catch (err) {
      props.onToast({ tone: 'bad', text: dict.taskVault.toasts.detailFailed });
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!props.owner) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.connectOwnerFirst });
      return;
    }
    const budgetSol = Number(newBudgetSol);
    const capSol = Number(newCapSol);
    const hours = Number(newHours);
    if (!budgetSol || budgetSol <= 0 || !capSol || capSol <= 0) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.enterValidSol });
      return;
    }
    if (capSol > budgetSol) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.capExceedsBudget });
      return;
    }
    if (submitOnchain && !newAllowedWorker.trim()) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.workerRequired });
      return;
    }
    if (submitOnchain) {
      try {
        if (new PublicKey(newAllowedWorker.trim()).toBase58() !== props.mockWorkerPubkey) {
          props.onToast({ tone: 'warn', text: dict.taskVault.toasts.useMockWorker });
          return;
        }
      } catch {
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.validWorkerAddress });
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
          props.onToast({ tone: 'warn', text: dict.taskVault.toasts.phantomNotFound });
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
          text: interpolate(dict.taskVault.toasts.fundedDevnet, { sig: shorten(txSignature, 4) }),
        });
      } else {
        props.onToast({
          tone: 'ok',
          text: interpolate(dict.taskVault.toasts.createdSimulated, { taskId: res.task.taskId }),
        });
      }

      setNewTaskId(`task-${Date.now().toString(36)}`);
      await loadTasks(res.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : dict.taskVault.toasts.createFailed,
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
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.enterValidAmount });
      return;
    }
    const worker = paymentWorker.trim() || props.owner || props.agentPubkey;

    if (detail.task.allowedWorker && worker !== detail.task.allowedWorker) {
      props.onToast({
        tone: 'warn',
        text: interpolate(dict.taskVault.toasts.workerMismatch, {
          worker: shorten(worker, 4),
          allowed: shorten(detail.task.allowedWorker, 4),
        }),
      });
      return;
    }

    if (detail.task.allowedServiceId && paymentService.trim() !== detail.task.allowedServiceId) {
      props.onToast({
        tone: 'warn',
        text: interpolate(dict.taskVault.toasts.serviceMismatch, {
          service: paymentService,
          allowed: detail.task.allowedServiceId,
        }),
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
          ? interpolate(dict.taskVault.toasts.onchainEscrow, { paymentId, sig: shorten(result.payment.txSignature, 4) })
          : interpolate(dict.taskVault.toasts.simulatedEscrow, { paymentId }),
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : dict.taskVault.toasts.paymentRejected,
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
          ? interpolate(dict.taskVault.toasts.onchainSettlement, { paymentId, sig: shorten(result.receipt.txSignature, 4) })
          : interpolate(dict.taskVault.toasts.simulatedSettlement, { paymentId }),
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : dict.taskVault.toasts.settleFailed,
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCloseReceipt = async (paymentId: string, worker: string) => {
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
        // The program returns receipt rent to the worker who paid it.
        rentRecipient: new PublicKey(worker),
      });
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction().add(instruction);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = ownerPubkey;
      const { signature } = await provider.signAndSendTransaction(transaction as any);
      const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
      if (confirmation.value.err) throw new Error('Receipt close transaction failed');
      await api.closeTaskReceipt(detail.task.taskId, paymentId, signature);
      props.onToast({
        tone: 'ok',
        text: interpolate(dict.taskVault.toasts.receiptClosedRentReturned, { sig: shorten(signature, 4) }),
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: err instanceof ApiError ? err.message : err instanceof Error ? err.message : dict.taskVault.toasts.closeReceiptFailed,
      });
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
      props.onToast({
        tone: 'warn',
        text: interpolate(dict.taskVault.toasts.taskRevoked, { taskId }),
      });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : dict.taskVault.toasts.revokeFailed });
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
        text: interpolate(dict.taskVault.toasts.vaultClosedRefunded, {
          amount: (res.refundedLamports / LAMPORTS_PER_SOL).toFixed(4),
        }),
      });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : dict.taskVault.toasts.refundFailed });
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

  // Mirrors refund_and_close: it reverts with PendingEscrowsExist while any escrow is held.
  const hasHeldEscrow = Boolean(detail?.payments.some((p) => p.status === 'held'));

  // Mirrors close_receipt: the capability must still exist and no longer accept payments.
  const receiptsClosable = Boolean(detail)
    && !detail!.task.isClosed
    && (detail!.task.status !== 'active' || Math.floor(Date.now() / 1000) >= detail!.task.expiry);

  return (
    <div className="task-vault-container">
      <div className="vault-grid">
        {/* Left Column: Create Task & Task Selector */}
        <div className="vault-sidebar">
          <Card
            title={dict.taskVault.create.title}
            titleIcon={<Plus size={16} />}
            className="create-task-card"
          >
            <form onSubmit={handleCreateTask} className="task-form">
              <label>
                <span>{dict.taskVault.create.taskId}</span>
                <input
                  type="text"
                  value={newTaskId}
                  onChange={(e) => setNewTaskId(e.target.value)}
                  placeholder={dict.taskVault.create.taskIdPlaceholder}
                  required
                />
              </label>

              <div className="form-row">
                <label>
                  <span>{dict.taskVault.create.totalBudget}</span>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    value={newBudgetSol}
                    onChange={(e) => setNewBudgetSol(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>{dict.taskVault.create.perPaymentCap}</span>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    value={newCapSol}
                    onChange={(e) => setNewCapSol(e.target.value)}
                    required
                  />
                </label>
              </div>

              <div className="form-row">
                <label>
                  <span>{dict.taskVault.create.allowedWorker}</span>
                  <input
                    type="text"
                    value={newAllowedWorker}
                    onChange={(e) => setNewAllowedWorker(e.target.value)}
                    placeholder={dict.taskVault.create.allowedWorkerPlaceholder}
                  />
                </label>
                <label>
                  <span>{dict.taskVault.create.allowedService}</span>
                  <input
                    type="text"
                    value={newAllowedServiceId}
                    onChange={(e) => setNewAllowedServiceId(e.target.value)}
                    placeholder={dict.taskVault.create.allowedServicePlaceholder}
                  />
                </label>
              </div>

              <label>
                <span>{dict.taskVault.create.expiryDuration}</span>
                <input
                  type="number"
                  step="any"
                  min="0.05"
                  max="168"
                  value={newHours}
                  onChange={(e) => setNewHours(e.target.value)}
                  required
                />
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={submitOnchain}
                  onChange={(e) => setSubmitOnchain(e.target.checked)}
                />
                <span>{dict.taskVault.create.broadcastOnChain}</span>
              </label>

              <button
                type="submit"
                className="primary"
                disabled={busyAction === 'create' || !props.owner}
              >
                {busyAction === 'create' ? dict.taskVault.create.submittingBtn : dict.taskVault.create.submitBtn}
              </button>
              {!props.owner ? (
                <span className="hint-warn">{dict.taskVault.create.connectHint}</span>
              ) : null}
            </form>
          </Card>

          <Card
            title={dict.taskVault.list.title}
            titleIcon={<Layers size={16} />}
            actions={
              <button
                type="button"
                className="link button-with-icon"
                onClick={() => void loadTasks()}
                disabled={loading}
              >
                <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                {dict.taskVault.list.refresh}
              </button>
            }
          >
            {tasks.length === 0 ? (
              <div className="empty-state">{dict.taskVault.list.empty}</div>
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
                          {dict.taskVault.list.cap} {(t.perPaymentCapLamports / LAMPORTS_PER_SOL).toFixed(3)}
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
                title={interpolate(dict.taskVault.detail.taskTitle, { taskId: detail.task.taskId })}
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
                        {dict.taskVault.detail.revoke}
                      </button>
                    ) : null}
                    {!detail.task.isClosed ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyAction) || hasHeldEscrow}
                        title={hasHeldEscrow ? dict.taskVault.detail.refundBlockedPending : undefined}
                        onClick={() => void handleRefund(detail.task.taskId)}
                      >
                        {dict.taskVault.detail.refundAndClose}
                      </button>
                    ) : null}
                  </div>
                }
              >
                <div className="task-summary-grid">
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.status}</span>
                    <Pill tone={statusTone(detail.task.status)}>{detail.task.status}</Pill>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.executionMode}</span>
                    {detail.task.txSignature ? (
                      <a
                        href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Pill tone="ok">{dict.taskVault.detail.devnetTx}</Pill>
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <Pill tone="neutral">{dict.taskVault.detail.simulated}</Pill>
                    )}
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.totalBudget}</span>
                    <strong>{(detail.task.budgetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.totalSpent}</span>
                    <strong>{(detail.task.spentLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.remaining}</span>
                    <strong className="ok-value">
                      {(
                        Math.max(0, detail.task.budgetLamports - detail.task.spentLamports) /
                        LAMPORTS_PER_SOL
                      ).toFixed(4)}{' '}
                      SOL
                    </strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.perPaymentCap}</span>
                    <span>{(detail.task.perPaymentCapLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.allowedWorker}</span>
                    <span>{detail.task.allowedWorker ? shorten(detail.task.allowedWorker, 4) : dict.taskVault.detail.any}</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.allowedService}</span>
                    <span>{detail.task.allowedServiceId || dict.taskVault.detail.any}</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.expiresAt}</span>
                    <span>{new Date(detail.task.expiry * 1000).toLocaleString()}</span>
                  </div>
                </div>

                <div className="pda-bindings">
                  <div className="pda-item">
                    <span className="pda-label">{dict.taskVault.detail.capabilityPda}</span>
                    <Mono>{shorten(detail.task.pda ?? '—', 8)}</Mono>
                    {detail.task.pda ? (
                      <CopyAddressButton value={detail.task.pda} label={dict.taskVault.detail.copyCapPda} />
                    ) : null}
                  </div>
                  <div className="pda-item">
                    <span className="pda-label">{dict.taskVault.detail.vaultPda}</span>
                    <Mono>{shorten(detail.task.vaultPda ?? '—', 8)}</Mono>
                    {detail.task.vaultPda ? (
                      <CopyAddressButton value={detail.task.vaultPda} label={dict.taskVault.detail.copyVaultPda} />
                    ) : null}
                  </div>
                  {detail.task.txSignature ? (
                    <div className="pda-item">
                      <span className="pda-label">{dict.taskVault.detail.devnetTxLabel}</span>
                      <a
                        href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
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
                  title={dict.taskVault.payment.title}
                  titleIcon={<Play size={16} />}
                  className="execute-payment-card"
                >
                  <form onSubmit={handleExecutePayment} className="payment-form">
                    <div className="form-row">
                      <label>
                        <span>{dict.taskVault.payment.workerAddress}</span>
                        <input
                          type="text"
                          value={paymentWorker}
                          onChange={(e) => setPaymentWorker(e.target.value)}
                          placeholder={dict.taskVault.payment.workerPlaceholder}
                        />
                      </label>
                      <label>
                        <span>{dict.taskVault.payment.serviceId}</span>
                        <input
                          type="text"
                          value={paymentService}
                          onChange={(e) => setPaymentService(e.target.value)}
                          required
                        />
                      </label>
                      <label>
                        <span>{dict.taskVault.payment.amount}</span>
                        <input
                          type="number"
                          step="any"
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
                      {busyAction === 'execute_payment' ? dict.taskVault.payment.submittingBtn : dict.taskVault.payment.submitBtn}
                    </button>
                  </form>
                </Card>
              ) : null}

              {/* Escrow & Payment List */}
              <Card title={dict.taskVault.escrows.title} titleIcon={<Clock size={16} />}>
                {detail.payments.length === 0 ? (
                  <div className="empty-state">{dict.taskVault.escrows.empty}</div>
                ) : (
                  <div className="escrows-table-wrapper">
                    <table className="escrows-table">
                      <thead>
                        <tr>
                          <th>{dict.taskVault.escrows.colPaymentId}</th>
                          <th>{dict.taskVault.escrows.colService}</th>
                          <th>{dict.taskVault.escrows.colWorker}</th>
                          <th>{dict.taskVault.escrows.colAmount}</th>
                          <th>{dict.taskVault.escrows.colStatus}</th>
                          <th>{dict.taskVault.escrows.colAction}</th>
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
                                    <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
                                  </a>
                                ) : <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>}
                              </td>
                              <td>
                                {receipt ? (
                                  <div className="receipt-proof-badge">
                                    <CheckCircle2 size={14} className="ok-icon" />
                                    <Mono title={receipt.resultHash}>
                                      {dict.taskVault.escrows.proof} {shorten(receipt.resultHash, 4)}
                                    </Mono>
                                    {receipt.txSignature ? (
                                      <a href={`https://explorer.solana.com/tx/${receipt.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">
                                        <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
                                      </a>
                                    ) : <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>}
                                    {receipt.isSimulated === false && !receipt.isClosed && !receiptsClosable ? (
                                      <span title="On-chain receipts block payment-id replay until the task is revoked, completed or expired">
                                        {dict.taskVault.escrows.receiptLocked}
                                      </span>
                                    ) : receipt.isSimulated === false && !receipt.isClosed ? (
                                      <button
                                        type="button"
                                        className="link primary-link"
                                        title="Close receipt; rent returns to the worker who paid it"
                                        disabled={Boolean(busyAction)}
                                        onClick={() => void handleCloseReceipt(receipt.paymentId, receipt.worker)}
                                      >
                                        <XCircle size={14} />
                                        {busyAction === `close-receipt-${receipt.paymentId}` ? dict.taskVault.escrows.closingReceipt : dict.taskVault.escrows.closeReceipt}
                                      </button>
                                    ) : receipt.isClosed ? <span>{dict.taskVault.escrows.receiptClosed}</span> : null}
                                  </div>
                                ) : p.status === 'held' ? (
                                  <button
                                    type="button"
                                    className="link primary-link"
                                    disabled={Boolean(busyAction)}
                                    onClick={() => void handleSettleMockPayment(p.paymentId, p.serviceId)}
                                  >
                                    {busyAction === `settle-${p.paymentId}`
                                      ? dict.taskVault.escrows.settling
                                      : dict.taskVault.escrows.settleWithReceipt}
                                  </button>
                                ) : (
                                  <span>{dict.taskVault.escrows.refunded}</span>
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
            <Card title={dict.taskVault.detail.defaultTitle}>
              <div className="empty-state">{dict.taskVault.detail.emptySelect}</div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
