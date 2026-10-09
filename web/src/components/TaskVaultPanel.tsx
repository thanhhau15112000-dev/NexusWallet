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
  deriveEscrowPda,
  computeTaskAcceptanceMessage,
} from '@nexus/shared';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getPhantom, signPhantomMessage } from '../phantom.js';
import { api, ApiError } from '../api.js';
import { Card, CopyAddressButton, Mono, Pill, shorten } from './ui.js';
import { useI18n } from '../i18n/context.js';

export function TaskVaultPanel(props: {
  owner: string | null;
  /** Wallet currently connected in this browser; actions that act as the owner need it. */
  connected: boolean;
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
  const [loaded, setLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reviewedOutputs, setReviewedOutputs] = useState<Set<string>>(new Set());

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
      setLoaded(true);
    }
  };

  useEffect(() => {
    setReviewedOutputs(new Set());
    void loadTasks();
  }, [props.owner]);

  // Follow the selected task's allowlist so the payment form does not start out mismatched.
  const selectedWorker = detail?.task.allowedWorker;
  const selectedService = detail?.task.allowedServiceId;
  useEffect(() => {
    if (selectedWorker) setPaymentWorker(selectedWorker);
    if (selectedService) setPaymentService(selectedService);
  }, [detail?.task.taskId, selectedWorker, selectedService]);

  const selectTask = (taskId: string) => loadTasks(taskId);

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
      setShowCreate(false);
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

  const handleSubmitMockOutput = async (paymentId: string, serviceId: string) => {
    if (!detail) return;
    setBusyAction(`output-${paymentId}`);
    try {
      // Submission saves the output for review; it does not release escrow.
      const mockResult = await api.runMockService({
        taskId: detail.task.taskId,
        paymentId,
        serviceId,
        payload: { simulatedTask: detail.task.taskId, paymentId },
      });
      await api.submitTaskOutput(detail.task.taskId, paymentId, {
        resultHash: mockResult.resultHash,
        resultPayload: mockResult.resultPayload,
        workerPubkey: mockResult.workerPubkey,
        workerSignature: mockResult.workerSignature,
      });
      props.onToast({ tone: 'ok', text: dict.taskVault.toasts.outputSubmitted });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : dict.taskVault.toasts.outputFailed });
    } finally {
      setBusyAction(null);
    }
  };

  const reviewKey = (payment: TaskPaymentRecord) =>
    `${props.owner}:${payment.taskId}:${payment.paymentId}:${payment.delivery?.resultHash}`;

  const handleAcceptPayment = async (payment: TaskPaymentRecord) => {
    if (!detail || !payment.delivery || !reviewedOutputs.has(reviewKey(payment))) return;
    const paymentId = payment.paymentId;
    setBusyAction(`settle-${paymentId}`);
    try {
      const provider = getPhantom();
      if (!props.connected || !provider || provider.publicKey?.toString() !== detail.task.owner) {
        throw new Error(dict.taskVault.toasts.connectOwnerFirst);
      }
      const [taskCapability] = deriveTaskCapabilityPda(new PublicKey(detail.task.owner), detail.task.taskId);
      const [escrow] = deriveEscrowPda(taskCapability, paymentId);
      const ownerSignature = await signPhantomMessage(computeTaskAcceptanceMessage({
        taskCapability, escrow, requestHash: payment.requestHash,
        resultHash: payment.delivery.resultHash, amountLamports: payment.amountLamports,
      }));
      const result = await api.settleTaskPayment(detail.task.taskId, paymentId, {
        resultHash: payment.delivery.resultHash,
        workerPubkey: payment.worker,
        workerSignature: payment.delivery.workerSignature,
        ownerSignature,
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
        text: interpolate(txSignature ? dict.taskVault.toasts.vaultClosedRefunded : dict.taskVault.toasts.vaultClosedSimulated, {
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

  // The stored status stays 'active' after expiry until someone closes the task; show what the guard enforces.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const effectiveStatus = (task: TaskCapabilityRecord) =>
    task.status === 'active' && nowSeconds >= task.expiry ? 'expired' : task.status;

  const locked = !props.connected;
  const paymentActionsLocked = locked || Boolean(detail?.task.isClosed) || Boolean(detail && nowSeconds >= detail.task.expiry);
  const createOpen = showCreate || (loaded && tasks.length === 0);

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

  // A closed task's vault is drained back to the owner, so nothing remains in it.
  const unspentLamports = detail ? Math.max(0, detail.task.budgetLamports - detail.task.spentLamports) : 0;
  const vaultRemainingLamports = detail?.task.isClosed ? 0 : unspentLamports;
  const refundedLamports = detail?.task.isClosed ? unspentLamports : 0;

  // Mirrors close_receipt: the capability must still exist and no longer accept payments.
  const detailStatus = detail ? effectiveStatus(detail.task) : null;
  const taskOpen = detailStatus === 'active';
  const receiptsClosable = Boolean(detail) && !detail!.task.isClosed && !taskOpen;

  return (
    <div className="task-vault-container">
      {locked ? <p className="hint-warn" role="status">{dict.taskVault.connectToOperate}</p> : null}
      <div className="vault-grid">
        {/* Left Column: Create Task & Task Selector */}
        <div className="vault-sidebar">
          {createOpen ? (
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
                disabled={busyAction === 'create' || !props.owner || locked}
              >
                {busyAction === 'create' ? dict.taskVault.create.submittingBtn : dict.taskVault.create.submitBtn}
              </button>
              {!props.owner ? (
                <span className="hint-warn">{dict.taskVault.create.connectHint}</span>
              ) : null}
            </form>
          </Card>
          ) : null}

          <Card
            title={dict.taskVault.list.title}
            titleIcon={<Layers size={16} />}
            actions={
              <div className="task-actions-group">
                <button
                  type="button"
                  className="link button-with-icon"
                  onClick={() => void loadTasks()}
                  disabled={loading}
                >
                  <RefreshCw size={13} className={loading ? 'spinning' : ''} />
                  {dict.taskVault.list.refresh}
                </button>
                {tasks.length > 0 ? (
                  <button
                    type="button"
                    className="primary button-with-icon"
                    aria-expanded={createOpen}
                    onClick={() => setShowCreate((open) => !open)}
                  >
                    {createOpen ? null : <Plus size={13} />}
                    {createOpen ? dict.taskVault.list.hideForm : dict.taskVault.list.newTask}
                  </button>
                ) : null}
              </div>
            }
          >
            {tasks.length === 0 ? (
              <div className="empty-state">{dict.taskVault.list.empty}</div>
            ) : (
              <ul className="task-list">
                {tasks.map((t) => {
                  const isSelected = t.taskId === selectedTaskId;
                  const rowStatus = effectiveStatus(t);
                  const spentSol = t.spentLamports / LAMPORTS_PER_SOL;
                  const budgetSol = t.budgetLamports / LAMPORTS_PER_SOL;
                  return (
                    <li
                      key={t.taskId}
                      className={`task-list-item${isSelected ? ' is-selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      onClick={() => void selectTask(t.taskId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void selectTask(t.taskId);
                        }
                      }}
                    >
                      <div className="task-item-head">
                        <strong>{t.taskId}</strong>
                        <Pill tone={statusTone(rowStatus)}>{dict.taskVault.statuses[rowStatus]}</Pill>
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
                    {taskOpen ? (
                      <button
                        type="button"
                        className="bad-button"
                        disabled={Boolean(busyAction) || locked}
                        onClick={() => void handleRevoke(detail.task.taskId)}
                      >
                        {dict.taskVault.detail.revoke}
                      </button>
                    ) : null}
                    {!detail.task.isClosed ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busyAction) || hasHeldEscrow || locked}
                        aria-describedby={hasHeldEscrow ? 'refund-blocked-note' : undefined}
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
                    <Pill tone={statusTone(detailStatus!)}>{dict.taskVault.statuses[detailStatus!]}</Pill>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.executionMode}</span>
                    {detail.task.txSignature ? (
                      <a
                          href={`https://explorer.solana.com/tx/${detail.task.txSignature}?cluster=devnet`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-link"
                        >
                        <Pill tone="ok">{dict.taskVault.detail.devnetTx}</Pill>
                        <ExternalLink size={12} />
                      </a>
                    ) : (
                      <Pill tone="neutral">{dict.taskVault.detail.simulated}</Pill>
                    )}
                  </div>
                  <div className="summary-stat summary-stat-key">
                    <span className="stat-label">{dict.taskVault.detail.remaining}</span>
                    <strong className="ok-value">
                      {(vaultRemainingLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
                    </strong>
                    {detail.task.isClosed ? (
                      <span className="stat-label">
                        {detail.task.isSimulated === false ? dict.taskVault.detail.refunded : dict.taskVault.detail.refundedSimulated}: {(refundedLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
                      </span>
                    ) : null}
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.totalSpent}</span>
                    <strong>
                      {(detail.task.spentLamports / LAMPORTS_PER_SOL).toFixed(4)} / {(detail.task.budgetLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL
                    </strong>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.perPaymentCap}</span>
                    <span>{(detail.task.perPaymentCapLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                  </div>
                  <div className="summary-stat">
                    <span className="stat-label">{dict.taskVault.detail.expiresAt}</span>
                    <span>{new Date(detail.task.expiry * 1000).toLocaleString()}</span>
                  </div>
                </div>

                {detailStatus === 'expired' && !detail.task.isClosed ? (
                  <p className="hint-warn" role="status">{dict.taskVault.detail.expiredNote}</p>
                ) : null}
                {hasHeldEscrow && !detail.task.isClosed ? (
                  <p id="refund-blocked-note" className="hint-warn" role="status">
                    {dict.taskVault.detail.refundBlockedPending}
                  </p>
                ) : null}

                <details className="task-tech">
                  <summary>{dict.taskVault.detail.technicalDetails}</summary>
                  <div className="pda-bindings">
                    <div className="pda-item">
                      <span className="pda-label">{dict.taskVault.detail.allowedWorker}</span>
                      <span>{detail.task.allowedWorker ? shorten(detail.task.allowedWorker, 4) : dict.taskVault.detail.any}</span>
                    </div>
                    <div className="pda-item">
                      <span className="pda-label">{dict.taskVault.detail.allowedService}</span>
                      <span>{detail.task.allowedServiceId || dict.taskVault.detail.any}</span>
                    </div>
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
                          className="inline-link"
                        >
                          <Mono>{shorten(detail.task.txSignature, 8)}</Mono>
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    ) : null}
                  </div>
                </details>
              </Card>

              {/* Multi-step Payment Simulator */}
              {taskOpen ? (
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
                      disabled={busyAction === 'execute_payment' || locked}
                    >
                      {busyAction === 'execute_payment' ? dict.taskVault.payment.submittingBtn : dict.taskVault.payment.submitBtn}
                    </button>
                  </form>
                </Card>
              ) : null}

              {/* Escrow & Payment List */}
              <Card title={dict.taskVault.escrows.title} titleIcon={<Clock size={16} />}>
                <p className="card-desc">{dict.taskVault.escrows.proofHint}</p>
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
                                  {dict.taskVault.escrowStatuses[p.status]}
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
                                    {receipt.isSimulated === false && !receipt.isClosed && detail.task.isClosed ? (
                                      <span title={dict.taskVault.escrows.receiptWorkerOnlyHint}>
                                        {dict.taskVault.escrows.receiptWorkerOnly}
                                      </span>
                                    ) : receipt.isSimulated === false && !receipt.isClosed && !receiptsClosable ? (
                                      <span title={dict.taskVault.escrows.receiptLockedHint}>
                                        {dict.taskVault.escrows.receiptLocked}
                                      </span>
                                    ) : receipt.isSimulated === false && !receipt.isClosed ? (
                                      <button
                                        type="button"
                                        className="link primary-link"
                                        title={dict.taskVault.escrows.closeReceiptHint}
                                        disabled={Boolean(busyAction) || locked}
                                        onClick={() => void handleCloseReceipt(receipt.paymentId, receipt.worker)}
                                      >
                                        <XCircle size={14} />
                                        {busyAction === `close-receipt-${receipt.paymentId}` ? dict.taskVault.escrows.closingReceipt : dict.taskVault.escrows.closeReceipt}
                                      </button>
                                    ) : receipt.isClosed ? <span>{dict.taskVault.escrows.receiptClosed}</span> : null}
                                  </div>
                                ) : p.status === 'held' && p.delivery ? (
                                  <div className="task-output-review">
                                    <details open>
                                      <summary>{dict.taskVault.escrows.reviewOutput}</summary>
                                      <pre>{JSON.stringify(p.delivery.resultPayload, null, 2)}</pre>
                                    </details>
                                    <Mono title={p.delivery.resultHash}>{shorten(p.delivery.resultHash, 8)}</Mono>
                                    <label className="task-output-confirm">
                                      <input type="checkbox"
                                        checked={reviewedOutputs.has(reviewKey(p))}
                                        disabled={Boolean(busyAction) || paymentActionsLocked}
                                        onChange={(event) => setReviewedOutputs((current) => {
                                          const next = new Set(current);
                                          if (event.target.checked) next.add(reviewKey(p));
                                          else next.delete(reviewKey(p));
                                          return next;
                                        })}
                                      />
                                      {dict.taskVault.escrows.reviewedConfirmation}
                                    </label>
                                    <button type="button" className="link primary-link"
                                      disabled={Boolean(busyAction) || paymentActionsLocked || !reviewedOutputs.has(reviewKey(p))}
                                      onClick={() => void handleAcceptPayment(p)}
                                    >
                                      {busyAction === `settle-${p.paymentId}` ? dict.taskVault.escrows.settling : dict.taskVault.escrows.acceptAndSettle}
                                    </button>
                                    <p className="hint">{dict.taskVault.escrows.reviewLimitation}</p>
                                  </div>
                                ) : p.status === 'held' ? (
                                  <button
                                    type="button"
                                    className="link primary-link"
                                    disabled={Boolean(busyAction) || paymentActionsLocked}
                                    onClick={() => void handleSubmitMockOutput(p.paymentId, p.serviceId)}
                                  >
                                    {busyAction === `output-${p.paymentId}`
                                      ? dict.taskVault.escrows.submittingOutput
                                      : dict.taskVault.escrows.submitOutput}
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
