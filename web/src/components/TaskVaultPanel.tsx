import { useEffect, useRef, useState } from 'react';
import {
  type TaskCapabilityRecord,
  type TaskPaymentRecord,
  type TaskReceiptRecord,
  createAndFundTaskInstruction,
  closeReceiptInstruction,
  refundAndCloseInstruction,
  refundExpiredEscrowInstruction,
  revokeTaskInstruction,
  deriveTaskCapabilityPda,
  deriveReceiptPda,
  deriveEscrowPda,
  computeTaskAcceptanceMessage,
  createAssociatedTokenAccountIdempotentInstruction,
  deriveVaultPda,
} from '@nexus/shared';
import { PublicKey, Transaction } from '@solana/web3.js';
import { signAndSendWithWallet, signMessageWithWallet, type ConnectedWallet } from '../solanaWallets.js';
import { api, ApiError } from '../api.js';
import { errorText } from '../lib/errors.js';
import { getSolanaConnection } from '../lib/solana.js';
import { Notice, shorten } from './ui.js';
import { useI18n } from '../i18n/context.js';
import { CreateTaskCard } from './task-vault/CreateTaskCard.js';
import { EscrowListCard } from './task-vault/EscrowListCard.js';
import { TaskDetailCard } from './task-vault/TaskDetailCard.js';
import { TaskListCard } from './task-vault/TaskListCard.js';
import { TaskPaymentForm } from './task-vault/TaskPaymentForm.js';
import { amountOf, assetOf, effectiveStatus, formatUnits, parseDecimalToBaseUnits } from './task-vault/units.js';

export function TaskVaultPanel(props: {
  owner: string | null;
  /** Wallet connected in this browser; on-chain owner actions sign with it when it is the owner. */
  wallet: ConnectedWallet | null;
  agentPubkey: string;
  mockWorkerPubkey: string | null;
  /** Demo merchant worker; it can only work on Devnet tasks, where its escrow is on-chain. */
  merchantWorkerPubkey: string | null;
  /** Policy mints a task budget may use besides SOL. */
  allowedMints: { label: string; address: string }[];
  rpcUrl: string;
  onToast: (toast: { tone: 'ok' | 'warn' | 'bad'; text: string }) => void;
}) {
  const { dict, interpolate } = useI18n();
  const ownerWallet = props.wallet && props.wallet.address === props.owner ? props.wallet : null;

  /** Signs with the owner's wallet, submits, and waits for confirmation. */
  const sendAsOwner = async (transaction: Transaction): Promise<string> => {
    if (!ownerWallet) throw new Error(dict.taskVault.toasts.connectOwnerFirst);
    const connection = getSolanaConnection(props.rpcUrl);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = new PublicKey(ownerWallet.address);
    const signature = await signAndSendWithWallet(ownerWallet, transaction);
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) throw new Error(dict.taskVault.toasts.transactionFailed);
    return signature;
  };

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
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  // Create form state
  const [newBudgetSol, setNewBudgetSol] = useState('0.5');
  const [newCapSol, setNewCapSol] = useState('0.2');
  const [newHours, setNewHours] = useState('24');
  const [newAllowedServiceId, setNewAllowedServiceId] = useState('');
  const [submitOnchain, setSubmitOnchain] = useState(true);
  // The mode picks the worker: Devnet tasks go to the demo merchant (the mock worker when it is unreachable),
  // simulated tasks to the mock worker, since the merchant only works where it can see its escrow on-chain.
  const defaultWorker = (submitOnchain ? props.merchantWorkerPubkey ?? props.mockWorkerPubkey : props.mockWorkerPubkey) ?? '';
  const [newAllowedWorker, setNewAllowedWorker] = useState(defaultWorker);
  const lastDefaultWorker = useRef(defaultWorker);
  useEffect(() => {
    const previous = lastDefaultWorker.current;
    lastDefaultWorker.current = defaultWorker;
    // An address the owner typed stays; only the previous default is replaced.
    setNewAllowedWorker((current) => (current === previous ? defaultWorker : current));
  }, [defaultWorker]);
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
    setNowSeconds(Math.floor(Date.now() / 1000));
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

  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(timer);
  }, []);

  // The budget comes from the owner's wallet, so read its balance of the selected asset.
  useEffect(() => {
    setOwnerBalance(null);
    if (!props.owner) return;
    let cancelled = false;
    const owner = new PublicKey(props.owner);
    const connection = getSolanaConnection(props.rpcUrl);
    const read = newAsset
      ? connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(newAsset) }).then((res) => {
          const amounts = res.value.map(
            (account) => account.account.data.parsed.info.tokenAmount as { amount: string; decimals: number },
          );
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
    const hours = Number(newHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.invalidExpiry });
      return;
    }
    const mint = newAsset ? new PublicKey(newAsset) : undefined;
    const balance = ownerBalance?.asset === newAsset ? ownerBalance : null;
    if (mint && (!balance || balance.baseUnits === 0n)) {
      props.onToast({ tone: 'warn', text: interpolate(dict.taskVault.toasts.noOwnerTokens, { unit: newAssetUnit }) });
      return;
    }
    const decimals = mint ? balance!.decimals : 9;
    const budgetUnits = parseDecimalToBaseUnits(newBudgetSol, decimals);
    const capUnits = parseDecimalToBaseUnits(newCapSol, decimals);
    if (budgetUnits === null || capUnits === null) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.enterValidSol });
      return;
    }
    if (capUnits > budgetUnits) {
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.capExceedsBudget });
      return;
    }
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
    if (newAllowedWorker.trim()) {
      let worker: string;
      try {
        worker = new PublicKey(newAllowedWorker.trim()).toBase58();
      } catch {
        setCreateAdvancedOpen(true);
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.validWorkerAddress });
        return;
      }
      const isMerchant = worker === props.merchantWorkerPubkey;
      if (submitOnchain && !isMerchant && worker !== props.mockWorkerPubkey) {
        setCreateAdvancedOpen(true);
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.useSigningWorker });
        return;
      }
      if (!submitOnchain && isMerchant) {
        setCreateAdvancedOpen(true);
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.merchantWorkerOnchainOnly });
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
        if (!ownerWallet) {
          setCreateAdvancedOpen(true);
          props.onToast({ tone: 'warn', text: dict.taskVault.toasts.connectOwnerFirst });
          setBusyAction(null);
          return;
        }
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

        const tx = new Transaction();
        if (mint) {
          // The vault holds a token budget in its own associated token account.
          const [vault] = deriveVaultPda(deriveTaskCapabilityPda(ownerPubkey, taskId)[0]);
          tx.add(createAssociatedTokenAccountIdempotentInstruction(ownerPubkey, vault, mint));
        }
        tx.add(ix);
        txSignature = await sendAsOwner(tx);
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
        text: errorText(err, dict.taskVault.toasts.createFailed),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleExecutePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const amountUnits = parseDecimalToBaseUnits(paymentAmountSol, assetOf(detail.task, props.allowedMints).decimals);
    if (amountUnits === null) {
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
        amountLamports: amountUnits,
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

  const handleSubmitMockOutput = async (
    paymentId: string,
    scenario: 'valid' | 'invalid_schema' = 'valid',
  ) => {
    if (!detail) return;
    setBusyAction(`output-${scenario}-${paymentId}`);
    try {
      // Submission saves the output for review; it does not release escrow.
      const mockResult = await api.runTaskWorker(detail.task.taskId, paymentId, scenario);
      const res = await api.submitTaskOutput(detail.task.taskId, paymentId, {
        resultHash: mockResult.resultHash,
        resultPayload: mockResult.resultPayload,
        workerPubkey: mockResult.workerPubkey,
        workerSignature: mockResult.workerSignature,
      });
      if (res.payment.delivery?.verification?.verdict === 'fail') {
        props.onToast({ tone: 'warn', text: dict.taskVault.toasts.outputVerificationFailed });
      } else {
        props.onToast({ tone: 'ok', text: dict.taskVault.toasts.outputSubmitted });
      }
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: err instanceof ApiError ? err.message : dict.taskVault.toasts.outputFailed });
    } finally {
      setBusyAction(null);
    }
  };

  const reviewKey = (payment: TaskPaymentRecord) =>
    `${props.owner}:${payment.taskId}:${payment.paymentId}:${payment.delivery?.resultHash}`;

  const handleRejectOutput = async (payment: TaskPaymentRecord) => {
    if (!detail) return;
    const paymentId = payment.paymentId;
    setBusyAction(`reject-${paymentId}`);
    try {
      const reason = rejectReasons[paymentId]?.trim() || undefined;
      await api.rejectTaskOutput(detail.task.taskId, paymentId, reason);
      setRejectReasons((current) => {
        const next = { ...current };
        delete next[paymentId];
        return next;
      });
      setReviewedOutputs((current) => {
        const next = new Set(current);
        next.delete(reviewKey(payment));
        return next;
      });
      props.onToast({ tone: 'warn', text: dict.taskVault.toasts.outputRejected });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.taskVault.toasts.rejectFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleRefundExpiredEscrow = async (payment: TaskPaymentRecord) => {
    if (!detail) return;
    const paymentId = payment.paymentId;
    setBusyAction(`refund-escrow-${paymentId}`);
    try {
      let txSignature: string | undefined;
      if (detail.task.isSimulated === false) {
        if (!props.owner) throw new Error(dict.taskVault.toasts.ownerWalletRequired);
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, detail.task.taskId);
        const [escrowPda] = deriveEscrowPda(taskPda, paymentId);
        const ix = refundExpiredEscrowInstruction({
          taskCapability: taskPda,
          escrow: escrowPda,
          owner: ownerPubkey,
          agentSigner: new PublicKey(detail.task.agentSigner),
          caller: ownerPubkey,
        });
        txSignature = await sendAsOwner(new Transaction().add(ix));
      }
      await api.refundExpiredEscrow(detail.task.taskId, paymentId, txSignature);
      props.onToast({
        tone: 'ok',
        text: txSignature
          ? interpolate(dict.taskVault.toasts.escrowRefundedDevnet, { sig: shorten(txSignature, 4) })
          : dict.taskVault.toasts.escrowRefundedSimulated,
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.taskVault.toasts.refundExpiredFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const handleAcceptPayment = async (payment: TaskPaymentRecord) => {
    if (!detail || !payment.delivery || !reviewedOutputs.has(reviewKey(payment))) return;
    const paymentId = payment.paymentId;
    setBusyAction(`settle-${paymentId}`);
    try {
      if (!ownerWallet || ownerWallet.address !== detail.task.owner) {
        throw new Error(dict.taskVault.toasts.connectOwnerFirst);
      }
      const [taskCapability] = deriveTaskCapabilityPda(new PublicKey(detail.task.owner), detail.task.taskId);
      const [escrow] = deriveEscrowPda(taskCapability, paymentId);
      const ownerSignature = await signMessageWithWallet(
        ownerWallet,
        computeTaskAcceptanceMessage({
          taskCapability,
          escrow,
          requestHash: payment.requestHash,
          resultHash: payment.delivery.resultHash,
          amountLamports: payment.amountLamports,
          mint: detail.task.mint,
        }),
      );
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
        text: errorText(err, dict.taskVault.toasts.settleFailed),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCloseReceipt = async (paymentId: string, worker: string) => {
    if (!detail || !props.owner) return;
    setBusyAction(`close-receipt-${paymentId}`);
    try {
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
      const signature = await sendAsOwner(new Transaction().add(instruction));
      await api.closeTaskReceipt(detail.task.taskId, paymentId, signature);
      props.onToast({
        tone: 'ok',
        text: interpolate(dict.taskVault.toasts.receiptClosedRentReturned, { sig: shorten(signature, 4) }),
      });
      await selectTask(detail.task.taskId);
    } catch (err) {
      props.onToast({
        tone: 'bad',
        text: errorText(err, dict.taskVault.toasts.closeReceiptFailed),
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
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, taskId);
        txSignature = await sendAsOwner(new Transaction().add(revokeTaskInstruction({ taskCapability: taskPda, owner: ownerPubkey })));
      }
      await api.revokeTask(taskId, txSignature);
      props.onToast({
        tone: 'warn',
        text: interpolate(dict.taskVault.toasts.taskRevoked, { taskId }),
      });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.taskVault.toasts.revokeFailed) });
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
        const ownerPubkey = new PublicKey(props.owner);
        const [taskPda] = deriveTaskCapabilityPda(ownerPubkey, taskId);
        const mint = detail.task.mint ? new PublicKey(detail.task.mint) : undefined;
        const ix = refundAndCloseInstruction({
          taskCapability: taskPda,
          owner: ownerPubkey,
          caller: ownerPubkey,
          mint,
        });
        const tx = new Transaction();
        // The remainder goes to the owner's associated token account, recreated if it was closed.
        if (mint) tx.add(createAssociatedTokenAccountIdempotentInstruction(ownerPubkey, ownerPubkey, mint));
        tx.add(ix);
        txSignature = await sendAsOwner(tx);
      }
      const res = await api.refundTask(taskId, txSignature);
      props.onToast({
        tone: 'ok',
        text: interpolate(txSignature ? dict.taskVault.toasts.vaultClosedRefunded : dict.taskVault.toasts.vaultClosedSimulated, {
          amount: amountOf(res.refundedLamports, res.task, props.allowedMints),
        }),
      });
      await selectTask(taskId);
    } catch (err) {
      props.onToast({ tone: 'bad', text: errorText(err, dict.taskVault.toasts.refundFailed) });
    } finally {
      setBusyAction(null);
    }
  };

  const locked = !props.wallet;
  const paymentActionsLocked = locked || Boolean(detail?.task.isClosed) || Boolean(detail && nowSeconds >= detail.task.expiry);

  // Mirrors refund_and_close: it reverts with PendingEscrowsExist while any escrow is held.
  const hasHeldEscrow = Boolean(detail?.payments.some((p) => p.status === 'held'));

  // A closed task's vault is drained back to the owner, so nothing remains in it.
  // For SPL tasks, refunded expired escrows never left the vault ATA and return on close.
  const refundedEscrowTokens = detail?.task.mint
    ? detail.payments.filter((p) => p.status === 'refunded').reduce((sum, p) => sum + p.amountLamports, 0)
    : 0;
  const unspentLamports = detail
    ? Math.max(0, detail.task.budgetLamports - detail.task.spentLamports + refundedEscrowTokens)
    : 0;
  const vaultRemainingLamports = detail?.task.isClosed ? 0 : unspentLamports;
  const refundedLamports = detail?.task.isClosed ? unspentLamports : 0;

  // Mirrors close_receipt: the capability must still exist and no longer accept payments.
  const detailStatus = detail ? effectiveStatus(detail.task, nowSeconds) : null;
  const taskOpen = detailStatus === 'active';
  const receiptsClosable = Boolean(detail) && !detail!.task.isClosed && !taskOpen;

  return (
    <div className="space-y-4">
      {locked ? (
        <Notice tone="warn" role="status">
          {dict.taskVault.connectToOperate}
        </Notice>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <TaskListCard
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          showCreate={showCreate}
          loading={loading}
          nowSeconds={nowSeconds}
          allowedMints={props.allowedMints}
          onRefresh={() => void loadTasks()}
          onOpenCreate={() => setShowCreate(true)}
          onSelectTask={(taskId) => {
            setShowCreate(false);
            void selectTask(taskId);
          }}
        />

        <div className="space-y-4">
          {showCreate ? (
            <CreateTaskCard
              owner={props.owner}
              locked={locked}
              busy={busyAction === 'create'}
              allowedMints={props.allowedMints}
              newAsset={newAsset}
              newAssetUnit={newAssetUnit}
              ownerBalance={ownerBalance}
              newBudgetSol={newBudgetSol}
              newCapSol={newCapSol}
              newHours={newHours}
              createAdvancedOpen={createAdvancedOpen}
              newAllowedWorker={newAllowedWorker}
              newAllowedServiceId={newAllowedServiceId}
              submitOnchain={submitOnchain}
              onAssetChange={setNewAsset}
              onBudgetChange={setNewBudgetSol}
              onCapChange={setNewCapSol}
              onHoursChange={setNewHours}
              onAdvancedOpenChange={setCreateAdvancedOpen}
              onAllowedWorkerChange={setNewAllowedWorker}
              onAllowedServiceIdChange={setNewAllowedServiceId}
              onSubmitOnchainChange={setSubmitOnchain}
              onClose={() => setShowCreate(false)}
              onSubmit={handleCreateTask}
            />
          ) : detail ? (
            <>
              <TaskDetailCard
                task={detail.task}
                detailStatus={detailStatus!}
                taskOpen={taskOpen}
                hasHeldEscrow={hasHeldEscrow}
                vaultRemainingLamports={vaultRemainingLamports}
                refundedLamports={refundedLamports}
                busyAction={busyAction}
                locked={locked}
                allowedMints={props.allowedMints}
                onRevoke={(taskId) => void handleRevoke(taskId)}
                onRefund={(taskId) => void handleRefund(taskId)}
              />

              {taskOpen ? (
                <TaskPaymentForm
                  unit={assetOf(detail.task, props.allowedMints).unit}
                  amount={paymentAmountSol}
                  worker={paymentWorker}
                  service={paymentService}
                  advancedOpen={paymentAdvancedOpen}
                  busy={busyAction === 'execute_payment'}
                  locked={locked}
                  onAmountChange={setPaymentAmountSol}
                  onWorkerChange={setPaymentWorker}
                  onServiceChange={setPaymentService}
                  onAdvancedOpenChange={setPaymentAdvancedOpen}
                  onSubmit={handleExecutePayment}
                />
              ) : null}

              <EscrowListCard
                task={detail.task}
                payments={detail.payments}
                receipts={detail.receipts}
                nowSeconds={nowSeconds}
                busyAction={busyAction}
                locked={locked}
                paymentActionsLocked={paymentActionsLocked}
                receiptsClosable={receiptsClosable}
                reviewedOutputs={reviewedOutputs}
                rejectReasons={rejectReasons}
                allowedMints={props.allowedMints}
                reviewKey={reviewKey}
                onToggleReviewed={(payment, checked) =>
                  setReviewedOutputs((current) => {
                    const next = new Set(current);
                    if (checked) next.add(reviewKey(payment));
                    else next.delete(reviewKey(payment));
                    return next;
                  })
                }
                onRejectReasonChange={(paymentId, reason) =>
                  setRejectReasons((current) => ({ ...current, [paymentId]: reason }))
                }
                onAcceptPayment={(payment) => void handleAcceptPayment(payment)}
                onRejectOutput={(payment) => void handleRejectOutput(payment)}
                onSubmitMockOutput={(paymentId, scenario) => void handleSubmitMockOutput(paymentId, scenario)}
                onRefundExpiredEscrow={(payment) => void handleRefundExpiredEscrow(payment)}
                onCloseReceipt={(paymentId, worker) => void handleCloseReceipt(paymentId, worker)}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
