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
  createAssociatedTokenAccountIdempotentInstruction,
  deriveVaultPda,
} from '@nexus/shared';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { getPhantom, signPhantomMessage } from '../phantom.js';
import { api, ApiError } from '../api.js';
import { Card, CopyAddressButton, DateTime, Empty, Mono, Pill, shorten } from './ui.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { cn } from '../lib/utils.js';
import { useI18n } from '../i18n/context.js';

export function TaskVaultPanel(props: {
  owner: string | null;
  /** Wallet currently connected in this browser; actions that act as the owner need it. */
  connected: boolean;
  agentPubkey: string;
  mockWorkerPubkey: string | null;
  /** Policy mints a task budget may use besides SOL. */
  allowedMints: { label: string; address: string }[];
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
  const [showCreate, setShowCreate] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [reviewedOutputs, setReviewedOutputs] = useState<Set<string>>(new Set());

  // Create form state
  const [newBudgetSol, setNewBudgetSol] = useState('0.5');
  const [newCapSol, setNewCapSol] = useState('0.2');
  const [newHours, setNewHours] = useState('24');
  const [newAllowedWorker, setNewAllowedWorker] = useState(props.mockWorkerPubkey ?? '');
  const [newAllowedServiceId, setNewAllowedServiceId] = useState('');
  const [submitOnchain, setSubmitOnchain] = useState(true);
  /** Worker, service and Devnet mode have working defaults, so they stay folded unless a check needs them. */
  const [createAdvancedOpen, setCreateAdvancedOpen] = useState(false);
  /** '' is SOL; otherwise an SPL mint from the policy. */
  const [newAsset, setNewAsset] = useState('');
  const newAssetUnit = props.allowedMints.find((entry) => entry.address === newAsset)?.label ?? 'SOL';
  /** Owner's balance of the selected asset in base units, with its decimals; null until read. */
  const [ownerBalance, setOwnerBalance] = useState<{ asset: string; baseUnits: bigint; decimals: number } | null>(null);

  // Payment form state
  const [paymentWorker, setPaymentWorker] = useState(props.mockWorkerPubkey ?? '');
  const [paymentService, setPaymentService] = useState('service-data-enrichment');
  const [paymentAmountSol, setPaymentAmountSol] = useState('0.1');
  const [paymentAdvancedOpen, setPaymentAdvancedOpen] = useState(false);

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
    setReviewedOutputs(new Set());
    void loadTasks();
  }, [props.owner]);

  // The budget comes from the owner's wallet, so read its balance of the selected asset.
  useEffect(() => {
    setOwnerBalance(null);
    if (!props.owner) return;
    let cancelled = false;
    const owner = new PublicKey(props.owner);
    const connection = new Connection(props.rpcUrl, 'confirmed');
    const read = newAsset
      ? connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(newAsset) }).then((res) => {
        const amounts = res.value.map((account) => account.account.data.parsed.info.tokenAmount as { amount: string; decimals: number });
        return {
          baseUnits: amounts.reduce((sum, amount) => sum + BigInt(amount.amount), 0n),
          // An owner without a token account holds none; its decimals are then not needed.
          decimals: amounts[0]?.decimals ?? 0,
        };
      })
      : connection.getBalance(owner).then((lamports) => ({ baseUnits: BigInt(lamports), decimals: 9 }));
    read
      .then((balance) => {
        if (!cancelled) setOwnerBalance({ asset: newAsset, ...balance });
      })
      .catch(() => {
        if (!cancelled) setOwnerBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [props.owner, props.rpcUrl, newAsset]);

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
    const mint = newAsset ? new PublicKey(newAsset) : undefined;
    const balance = ownerBalance?.asset === newAsset ? ownerBalance : null;
    if (mint && (!balance || balance.baseUnits === 0n)) {
      props.onToast({ tone: 'warn', text: interpolate(dict.taskVault.toasts.noOwnerTokens, { unit: newAssetUnit }) });
      return;
    }
    const decimals = mint ? balance!.decimals : 9;
    const budgetUnits = Math.round(budgetSol * 10 ** decimals);
    const capUnits = Math.round(capSol * 10 ** decimals);
    if (submitOnchain && balance && BigInt(budgetUnits) > balance.baseUnits) {
      props.onToast({
        tone: 'warn',
        text: interpolate(dict.taskVault.toasts.insufficientOwnerBalance, {
          balance: formatUnits(balance.baseUnits, balance.decimals),
          unit: newAssetUnit,
        }),
      });
      return;
    }
    if (submitOnchain && !newAllowedWorker.trim()) {
      setCreateAdvancedOpen(true);
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.workerRequired });
      return;
    }
    if (submitOnchain) {
      try {
        if (new PublicKey(newAllowedWorker.trim()).toBase58() !== props.mockWorkerPubkey) {
          setCreateAdvancedOpen(true);
          props.onToast({ tone: 'warn', text: dict.taskVault.toasts.useMockWorker });
          return;
        }
      } catch {
        setCreateAdvancedOpen(true);
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.validWorkerAddress });
        return;
      }
    }

    setBusyAction('create');
    // The id seeds the on-chain capability PDA, so it must exist before the owner signs.
    const taskId = `task-${Date.now().toString(36)}`;
    try {
      const now = Math.floor(Date.now() / 1000);
      const expiry = now + Math.round(hours * 3600);
      let txSignature: string | undefined;

      if (submitOnchain) {
        const provider = getPhantom();
        if (!provider) {
          setCreateAdvancedOpen(true);
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
          taskId,
          budgetLamports: budgetUnits,
          perPaymentCapLamports: capUnits,
          allowedWorker: newAllowedWorker.trim() ? new PublicKey(newAllowedWorker.trim()) : undefined,
          allowedServiceId: newAllowedServiceId.trim() || undefined,
          expiry,
          mint,
        });

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction();
        if (mint) {
          // The vault holds a token budget in its own associated token account.
          const [vault] = deriveVaultPda(deriveTaskCapabilityPda(ownerPubkey, taskId)[0]);
          tx.add(createAssociatedTokenAccountIdempotentInstruction(ownerPubkey, vault, mint));
        }
        tx.add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = ownerPubkey;

        const { signature } = await provider.signAndSendTransaction(tx as any);
        txSignature = signature;
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );
        if (confirmation.value.err) {
          throw new Error(dict.taskVault.toasts.transactionFailed);
        }
      }

      const res = await api.createTask({
        taskId,
        budgetLamports: budgetUnits,
        perPaymentCapLamports: capUnits,
        mint: newAsset || undefined,
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

    if (!paymentService.trim()) {
      setPaymentAdvancedOpen(true);
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.serviceRequired });
      return;
    }

    if (detail.task.allowedWorker && worker !== detail.task.allowedWorker) {
      setPaymentAdvancedOpen(true);
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
      setPaymentAdvancedOpen(true);
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
        amountLamports: Math.round(amountSol * 10 ** assetOf(detail.task).decimals),
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
        resultHash: payment.delivery.resultHash, amountLamports: payment.amountLamports, mint: detail.task.mint,
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
      if (!provider) throw new Error(dict.taskVault.toasts.phantomNotFound);
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
      if (confirmation.value.err) throw new Error(dict.taskVault.toasts.transactionFailed);
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
        if (!props.owner) throw new Error(dict.taskVault.toasts.ownerWalletRequired);
        const provider = getPhantom();
        if (!provider) throw new Error(dict.taskVault.toasts.phantomNotFound);
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
        if (confirmation.value.err) throw new Error(dict.taskVault.toasts.transactionFailed);
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
        if (!props.owner) throw new Error(dict.taskVault.toasts.ownerWalletRequired);
        const provider = getPhantom();
        if (!provider) throw new Error(dict.taskVault.toasts.phantomNotFound);
        const connection = new Connection(props.rpcUrl, 'confirmed');
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, taskId);
        const mint = detail.task.mint ? new PublicKey(detail.task.mint) : undefined;
        const ix = refundAndCloseInstruction({
          taskCapability: taskPda,
          owner: ownerPubkey,
          caller: ownerPubkey,
          mint,
        });
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction();
        // The remainder goes to the owner's associated token account, recreated if it was closed.
        if (mint) tx.add(createAssociatedTokenAccountIdempotentInstruction(ownerPubkey, ownerPubkey, mint));
        tx.add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = ownerPubkey;
        const { signature } = await provider.signAndSendTransaction(tx as any);
        const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (confirmation.value.err) throw new Error(dict.taskVault.toasts.transactionFailed);
        txSignature = signature;
      }
      const res = await api.refundTask(taskId, txSignature);
      props.onToast({
        tone: 'ok',
        text: interpolate(txSignature ? dict.taskVault.toasts.vaultClosedRefunded : dict.taskVault.toasts.vaultClosedSimulated, {
          amount: amountOf(res.refundedLamports, res.task),
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
  const createOpen = showCreate;

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


  /** Display unit and decimals of a task's budget asset. */
  function assetOf(task: TaskCapabilityRecord) {
    if (!task.mint) return { unit: 'SOL', decimals: 9 };
    const label = props.allowedMints.find((entry) => entry.address === task.mint)?.label ?? shorten(task.mint, 4);
    return { unit: label, decimals: task.mintDecimals ?? 0 };
  }
  /** A base-unit amount of the task's asset with its unit. */
  function amountOf(baseUnits: number, task: TaskCapabilityRecord) {
    const asset = assetOf(task);
    return `${formatUnits(BigInt(baseUnits), asset.decimals)} ${asset.unit}`;
  }
  const explorerTx = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

  const renderPaymentAction = (p: TaskPaymentRecord) => {
    const receipt = detail?.receipts.find((r) => r.paymentId === p.paymentId);
    if (receipt) {
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 size={13} className="text-accent" />
            <Mono title={receipt.resultHash}>
              {dict.taskVault.escrows.proof} {shorten(receipt.resultHash, 4)}
            </Mono>
          </span>
          <span className="text-muted">
            {dict.taskVault.escrows.settledAt} <DateTime value={receipt.settledAt * 1000} />
          </span>
          {receipt.txSignature ? (
            <a href={explorerTx(receipt.txSignature)} target="_blank" rel="noreferrer">
              <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
            </a>
          ) : (
            <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>
          )}
          {receipt.isSimulated === false && !receipt.isClosed && detail?.task.isClosed ? (
            <span className="text-muted" title={dict.taskVault.escrows.receiptWorkerOnlyHint}>
              {dict.taskVault.escrows.receiptWorkerOnly}
            </span>
          ) : receipt.isSimulated === false && !receipt.isClosed && !receiptsClosable ? (
            <span className="text-muted" title={dict.taskVault.escrows.receiptLockedHint}>
              {dict.taskVault.escrows.receiptLocked}
            </span>
          ) : receipt.isSimulated === false && !receipt.isClosed ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              title={dict.taskVault.escrows.closeReceiptHint}
              disabled={Boolean(busyAction) || locked}
              onClick={() => void handleCloseReceipt(receipt.paymentId, receipt.worker)}
            >
              <XCircle size={13} />
              {busyAction === `close-receipt-${receipt.paymentId}` ? dict.taskVault.escrows.closingReceipt : dict.taskVault.escrows.closeReceipt}
            </Button>
          ) : receipt.isClosed ? (
            <span className="text-muted">{dict.taskVault.escrows.receiptClosed}</span>
          ) : null}
        </div>
      );
    }
    if (p.status === 'held' && p.delivery) {
      const reviewed = reviewedOutputs.has(reviewKey(p));
      return (
        <div className="space-y-2.5 rounded-md border border-line bg-surface-muted/40 p-3 text-xs">
          <details open>
            <summary className="cursor-pointer font-medium text-ink">{dict.taskVault.escrows.reviewOutput}</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded border border-line bg-panel p-2 font-mono text-[11px]">
              {JSON.stringify(p.delivery.resultPayload, null, 2)}
            </pre>
          </details>
          <Mono title={p.delivery.resultHash} className="block text-muted">
            {shorten(p.delivery.resultHash, 8)}
          </Mono>
          <p className="text-[11px] text-muted">{dict.taskVault.escrows.reviewLimitation}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-ink">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-accent"
                checked={reviewed}
                disabled={Boolean(busyAction) || paymentActionsLocked}
                onChange={(event) => setReviewedOutputs((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(reviewKey(p));
                  else next.delete(reviewKey(p));
                  return next;
                })}
              />
              <span>{dict.taskVault.escrows.reviewedConfirmation}</span>
            </label>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={Boolean(busyAction) || paymentActionsLocked || !reviewed}
              onClick={() => void handleAcceptPayment(p)}
            >
              {busyAction === `settle-${p.paymentId}` ? dict.taskVault.escrows.settling : dict.taskVault.escrows.acceptAndSettle}
            </Button>
          </div>
        </div>
      );
    }
    if (p.status === 'held') {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={Boolean(busyAction) || paymentActionsLocked}
          onClick={() => void handleSubmitMockOutput(p.paymentId, p.serviceId)}
        >
          {busyAction === `output-${p.paymentId}` ? dict.taskVault.escrows.submittingOutput : dict.taskVault.escrows.submitOutput}
        </Button>
      );
    }
    return <span className="text-xs text-muted">{dict.taskVault.escrows.refunded}</span>;
  };

  return (
    <div className="space-y-4">
      {locked ? (
        <p className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
          {dict.taskVault.connectToOperate}
        </p>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <Card
          title={dict.taskVault.list.title}
          titleIcon={<Layers size={15} />}
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title={dict.taskVault.list.refresh}
                aria-label={dict.taskVault.list.refresh}
                onClick={() => void loadTasks()}
                disabled={loading}
              >
                <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
              </Button>
              {!createOpen ? (
                <Button type="button" variant="default" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setShowCreate(true)}>
                  <Plus size={12} />
                  {dict.taskVault.list.newTask}
                </Button>
              ) : null}
            </>
          }
        >
          {tasks.length === 0 ? (
            <Empty>{dict.taskVault.list.empty}</Empty>
          ) : (
            <ul className="-mx-1 space-y-1">
              {tasks.map((t) => {
                const isSelected = !createOpen && t.taskId === selectedTaskId;
                const rowStatus = effectiveStatus(t);
                const ratio = t.budgetLamports > 0 ? Math.min(100, (t.spentLamports / t.budgetLamports) * 100) : 0;
                return (
                  <li key={t.taskId}>
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setShowCreate(false);
                        void selectTask(t.taskId);
                      }}
                      className={cn(
                        'w-full space-y-2 rounded-md px-3 py-2.5 text-left transition-colors',
                        isSelected ? 'bg-accent-soft' : 'hover:bg-surface-muted',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn('truncate text-sm font-medium', isSelected ? 'text-accent-strong' : 'text-ink')}>
                          {t.taskId}
                        </span>
                        <Pill tone={statusTone(rowStatus)}>{dict.taskVault.statuses[rowStatus]}</Pill>
                      </span>
                      <span className="block h-1 w-full overflow-hidden rounded-full bg-line">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${ratio}%` }} />
                      </span>
                      <span className="flex items-center justify-between text-xs text-muted tabular-nums">
                        <span>{formatUnits(BigInt(t.spentLamports), assetOf(t).decimals)} / {amountOf(t.budgetLamports, t)}</span>
                        <span>{dict.taskVault.list.cap} {formatUnits(BigInt(t.perPaymentCapLamports), assetOf(t).decimals)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {createOpen ? (
            <Card
              title={dict.taskVault.create.title}
              titleIcon={<Plus size={15} />}
              actions={
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowCreate(false)}>
                  {dict.taskVault.create.cancel}
                </Button>
              }
            >
              <form onSubmit={handleCreateTask} className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={dict.taskVault.create.asset} required>
                    <select
                      className="flex h-9 w-full rounded-md border border-line-strong bg-panel px-3 py-1.5 text-sm text-ink transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
                      value={newAsset}
                      onChange={(e) => setNewAsset(e.target.value)}
                    >
                      <option value="">SOL</option>
                      {props.allowedMints.map((entry) => (
                        <option key={entry.address} value={entry.address}>{entry.label}</option>
                      ))}
                    </select>
                  </Field>
                  {props.owner ? (
                    <p className="self-end pb-2 text-xs text-muted tabular-nums sm:col-span-2">
                      {dict.taskVault.create.ownerBalance}:{' '}
                      {ownerBalance?.asset === newAsset
                        ? `${formatUnits(ownerBalance.baseUnits, ownerBalance.decimals)} ${newAssetUnit}`
                        : '…'}
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label={dict.taskVault.create.totalBudget} required>
                    <UnitInput unit={newAssetUnit} min="0.000001" value={newBudgetSol} onChange={setNewBudgetSol} />
                  </Field>
                  <Field label={dict.taskVault.create.perPaymentCap} required>
                    <UnitInput unit={newAssetUnit} min="0.000001" value={newCapSol} onChange={setNewCapSol} />
                  </Field>
                  <Field label={dict.taskVault.create.expiryDuration} required>
                    <UnitInput unit={dict.taskVault.create.hoursUnit} min="0.05" max="168" value={newHours} onChange={setNewHours} />
                  </Field>
                </div>

                <details
                  className="text-xs"
                  open={createAdvancedOpen}
                  onToggle={(e) => setCreateAdvancedOpen(e.currentTarget.open)}
                >
                  <summary className="cursor-pointer font-medium text-muted hover:text-ink">
                    {dict.taskVault.create.advanced}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                      <Field label={dict.taskVault.create.allowedWorker} required={submitOnchain}>
                        <Input
                          type="text"
                          value={newAllowedWorker}
                          onChange={(e) => setNewAllowedWorker(e.target.value)}
                          placeholder={dict.taskVault.create.allowedWorkerPlaceholder}
                        />
                      </Field>
                      <Field label={dict.taskVault.create.allowedService}>
                        <Input
                          type="text"
                          value={newAllowedServiceId}
                          onChange={(e) => setNewAllowedServiceId(e.target.value)}
                          placeholder={dict.taskVault.create.allowedServicePlaceholder}
                        />
                      </Field>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-accent"
                        checked={submitOnchain}
                        onChange={(e) => setSubmitOnchain(e.target.checked)}
                      />
                      <span>{dict.taskVault.create.broadcastOnChain}</span>
                    </label>
                  </div>
                </details>

                <div className="flex justify-end border-t border-line pt-4">
                  <Button type="submit" variant="default" disabled={busyAction === 'create' || !props.owner || locked}>
                    {busyAction === 'create' ? dict.taskVault.create.submittingBtn : dict.taskVault.create.submitBtn}
                  </Button>
                </div>
                {!props.owner ? <p className="text-xs text-warn">{dict.taskVault.create.connectHint}</p> : null}
              </form>
            </Card>
          ) : detail ? (
            <>
              <Card
                title={detail.task.taskId}
                titleIcon={<Coins size={15} />}
                titleAction={<Pill tone={statusTone(detailStatus!)}>{dict.taskVault.statuses[detailStatus!]}</Pill>}
                actions={
                  <>
                    {taskOpen ? (
                      <Button
                        type="button"
                        variant="destructiveOutline"
                        size="sm"
                        disabled={Boolean(busyAction) || locked}
                        onClick={() => void handleRevoke(detail.task.taskId)}
                      >
                        {dict.taskVault.detail.revoke}
                      </Button>
                    ) : null}
                    {!detail.task.isClosed ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={Boolean(busyAction) || hasHeldEscrow || locked}
                        aria-describedby={hasHeldEscrow ? 'refund-blocked-note' : undefined}
                        onClick={() => void handleRefund(detail.task.taskId)}
                      >
                        {dict.taskVault.detail.refundAndClose}
                      </Button>
                    ) : null}
                  </>
                }
              >
                <div className="space-y-2">
                  <span className="block text-xs font-medium text-muted">{dict.taskVault.detail.remaining}</span>
                  <strong className="block text-2xl font-semibold text-ink tabular-nums [font-stretch:112%]">
                    {amountOf(vaultRemainingLamports, detail.task)}
                  </strong>
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${detail.task.budgetLamports > 0 ? Math.min(100, (detail.task.spentLamports / detail.task.budgetLamports) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="block text-xs text-muted tabular-nums">
                    {dict.taskVault.detail.totalSpent}: {formatUnits(BigInt(detail.task.spentLamports), assetOf(detail.task).decimals)} / {amountOf(detail.task.budgetLamports, detail.task)}
                    {detail.task.isClosed
                      ? ` · ${detail.task.isSimulated === false ? dict.taskVault.detail.refunded : dict.taskVault.detail.refundedSimulated}: ${amountOf(refundedLamports, detail.task)}`
                      : null}
                  </span>
                </div>

                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line pt-3 text-sm sm:grid-cols-3">
                  <div className="space-y-1">
                    <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.perPaymentCap}</dt>
                    <dd className="text-ink tabular-nums">{amountOf(detail.task.perPaymentCapLamports, detail.task)}</dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.expiresAt}</dt>
                    <dd className="text-ink tabular-nums">
                      <DateTime value={detail.task.expiry * 1000} />
                    </dd>
                  </div>
                  <div className="space-y-1">
                    <dt className="text-xs font-medium text-muted">{dict.taskVault.detail.executionMode}</dt>
                    <dd>
                      {detail.task.txSignature ? (
                        <a href={explorerTx(detail.task.txSignature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
                          <Pill tone="ok">{dict.taskVault.detail.devnetTx}</Pill>
                          <ExternalLink size={12} className="text-accent" />
                        </a>
                      ) : (
                        <Pill tone="neutral">{dict.taskVault.detail.simulated}</Pill>
                      )}
                    </dd>
                  </div>
                </dl>

                {detailStatus === 'expired' && !detail.task.isClosed ? (
                  <p className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
                    {dict.taskVault.detail.expiredNote}
                  </p>
                ) : null}
                {hasHeldEscrow && !detail.task.isClosed ? (
                  <p id="refund-blocked-note" className="rounded-md border border-warn-line bg-warn-soft px-3 py-2 text-xs text-warn" role="status">
                    {dict.taskVault.detail.refundBlockedPending}
                  </p>
                ) : null}

                <details className="text-xs">
                  <summary className="cursor-pointer font-medium text-muted hover:text-ink">
                    {dict.taskVault.detail.technicalDetails}
                  </summary>
                  <dl className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-line bg-surface-muted/40 p-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">{dict.taskVault.detail.allowedWorker}</dt>
                      <dd className="inline-flex items-center gap-1">
                        <Mono title={detail.task.allowedWorker ?? undefined}>
                          {detail.task.allowedWorker ? shorten(detail.task.allowedWorker, 4) : dict.taskVault.detail.any}
                        </Mono>
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">{dict.taskVault.detail.allowedService}</dt>
                      <dd><Mono>{detail.task.allowedServiceId || dict.taskVault.detail.any}</Mono></dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">{dict.taskVault.detail.capabilityPda}</dt>
                      <dd className="inline-flex items-center gap-1">
                        <Mono title={detail.task.pda ?? undefined}>{shorten(detail.task.pda ?? '—', 8)}</Mono>
                        {detail.task.pda ? <CopyAddressButton value={detail.task.pda} label={dict.taskVault.detail.copyCapPda} /> : null}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted">{dict.taskVault.detail.vaultPda}</dt>
                      <dd className="inline-flex items-center gap-1">
                        <Mono title={detail.task.vaultPda ?? undefined}>{shorten(detail.task.vaultPda ?? '—', 8)}</Mono>
                        {detail.task.vaultPda ? <CopyAddressButton value={detail.task.vaultPda} label={dict.taskVault.detail.copyVaultPda} /> : null}
                      </dd>
                    </div>
                    {detail.task.txSignature ? (
                      <div className="flex items-center justify-between gap-2 sm:col-span-2">
                        <dt className="text-muted">{dict.taskVault.detail.devnetTxLabel}</dt>
                        <dd>
                          <a
                            href={explorerTx(detail.task.txSignature)}
                            target="_blank"
                            rel="noreferrer"
                            title={detail.task.txSignature}
                            className="inline-flex items-center gap-1 text-accent hover:underline"
                          >
                            {shorten(detail.task.txSignature, 8)}
                            <ExternalLink size={12} />
                          </a>
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
              </Card>

              {taskOpen ? (
                <Card title={dict.taskVault.payment.title} titleIcon={<Play size={15} />}>
                  <form onSubmit={handleExecutePayment} className="space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="sm:w-48">
                        <Field label={dict.taskVault.payment.amount} required>
                          <UnitInput unit={assetOf(detail.task).unit} min="0.000001" value={paymentAmountSol} onChange={setPaymentAmountSol} />
                        </Field>
                      </div>
                      <Button type="submit" variant="default" disabled={busyAction === 'execute_payment' || locked}>
                        {busyAction === 'execute_payment' ? dict.taskVault.payment.submittingBtn : dict.taskVault.payment.submitBtn}
                      </Button>
                    </div>
                    <details
                      className="text-xs"
                      open={paymentAdvancedOpen}
                      onToggle={(e) => setPaymentAdvancedOpen(e.currentTarget.open)}
                    >
                      <summary className="cursor-pointer font-medium text-muted hover:text-ink">
                        {dict.taskVault.payment.advanced}
                      </summary>
                      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                        <Field label={dict.taskVault.payment.workerAddress}>
                          <Input
                            type="text"
                            value={paymentWorker}
                            onChange={(e) => setPaymentWorker(e.target.value)}
                            placeholder={dict.taskVault.payment.workerPlaceholder}
                          />
                        </Field>
                        <Field label={dict.taskVault.payment.serviceId} required>
                          <Input type="text" value={paymentService} onChange={(e) => setPaymentService(e.target.value)} />
                        </Field>
                      </div>
                    </details>
                  </form>
                </Card>
              ) : null}

              <Card
                title={dict.taskVault.escrows.title}
                titleIcon={<Clock size={15} />}
                actions={detail.payments.length > 0 ? <Pill tone="neutral">{detail.payments.length}</Pill> : null}
              >
                {detail.payments.length === 0 ? (
                  <Empty>{dict.taskVault.escrows.empty}</Empty>
                ) : (
                  <ul className="divide-y divide-line">
                    {detail.payments.map((p) => (
                      <li key={p.paymentId} className="space-y-3 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <Mono className="text-sm font-medium text-ink">{p.paymentId}</Mono>
                              <Pill tone={p.status === 'settled' ? 'ok' : 'warn'}>{dict.taskVault.escrowStatuses[p.status]}</Pill>
                              {p.txSignature ? (
                                <a href={explorerTx(p.txSignature)} target="_blank" rel="noreferrer">
                                  <Pill tone="ok">{dict.taskVault.escrows.onChainDevnet}</Pill>
                                </a>
                              ) : (
                                <Pill tone="neutral">{dict.taskVault.escrows.simulated}</Pill>
                              )}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
                              <span>{p.serviceId}</span>
                              <span aria-hidden="true">·</span>
                              <span title={p.worker}>{dict.taskVault.escrows.colWorker} {shorten(p.worker, 4)}</span>
                              {p.createdAt ? (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <DateTime value={p.createdAt} />
                                </>
                              ) : null}
                            </span>
                          </div>
                          <strong className="text-sm font-semibold text-ink tabular-nums whitespace-nowrap">
                            {amountOf(p.amountLamports, detail.task)}
                          </strong>
                        </div>
                        {renderPaymentAction(p)}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Base units as an exact decimal string, trailing zeros dropped. */
function formatUnits(baseUnits: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const fraction = (baseUnits % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${baseUnits / divisor}.${fraction}` : (baseUnits / divisor).toString();
}

function Field(props: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-xs font-medium text-ink">
        {props.label}
        {props.required ? (
          <span className="ml-0.5 text-bad" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {props.children}
    </label>
  );
}

function UnitInput(props: { unit: string; value: string; onChange: (value: string) => void; min?: string; max?: string }) {
  return (
    <div className="relative">
      <Input
        type="number"
        step="any"
        min={props.min}
        max={props.max}
        className="tabular-nums"
        // Asset labels vary in length; reserve room so typed digits never run under the unit.
        style={{ paddingRight: `calc(${props.unit.length * 0.5}em + 1rem)` }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        required
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{props.unit}</span>
    </div>
  );
}
