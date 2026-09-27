use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ExecuteTaskPaymentParams {
    pub payment_id: [u8; 32],
    pub amount_lamports: u64,
    pub service_id: [u8; 32],
    pub request_hash: [u8; 32],
}

#[derive(Accounts)]
#[instruction(params: ExecuteTaskPaymentParams)]
pub struct ExecuteTaskPayment<'info> {
    #[account(
        mut,
        seeds = [b"capability", task_capability.owner.as_ref(), task_capability.task_id.as_ref()],
        bump = task_capability.bump
    )]
    pub task_capability: Account<'info, TaskCapability>,

    #[account(
        mut,
        seeds = [b"vault", task_capability.key().as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(
        init,
        payer = agent_signer,
        space = Escrow::LEN,
        seeds = [b"escrow", task_capability.key().as_ref(), params.payment_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: Receipt PDA for this payment id; only its ownership is inspected to reject reuse.
    #[account(
        seeds = [b"receipt", task_capability.key().as_ref(), params.payment_id.as_ref()],
        bump
    )]
    pub receipt: UncheckedAccount<'info>,

    /// CHECK: Recipient worker for this escrow
    pub worker: AccountInfo<'info>,

    #[account(mut)]
    pub agent_signer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_execute_task_payment(
    ctx: Context<ExecuteTaskPayment>,
    params: ExecuteTaskPaymentParams,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.task_capability.status == TaskStatus::Active,
        TaskVaultError::TaskNotActive
    );
    require!(
        now < ctx.accounts.task_capability.expiry,
        TaskVaultError::TaskExpired
    );
    require!(
        ctx.accounts.agent_signer.key() == ctx.accounts.task_capability.agent_signer,
        TaskVaultError::UnauthorizedSigner
    );
    // A settled payment id keeps its receipt until the task stops accepting payments.
    require!(
        ctx.accounts.receipt.owner != ctx.program_id,
        TaskVaultError::PaymentIdAlreadyUsed
    );
    require!(params.amount_lamports > 0, TaskVaultError::InvalidPaymentCap);
    require!(
        params.amount_lamports <= ctx.accounts.task_capability.per_payment_cap_lamports,
        TaskVaultError::ExceedsPaymentCap
    );

    if ctx.accounts.task_capability.allowed_worker != Pubkey::default() {
        require!(
            ctx.accounts.worker.key() == ctx.accounts.task_capability.allowed_worker,
            TaskVaultError::UnauthorizedWorker
        );
    }

    if ctx.accounts.task_capability.allowed_service_id != [0u8; 32] {
        require!(
            params.service_id == ctx.accounts.task_capability.allowed_service_id,
            TaskVaultError::UnauthorizedService
        );
    }

    let new_spent = ctx
        .accounts
        .task_capability
        .spent_lamports
        .checked_add(params.amount_lamports)
        .ok_or(TaskVaultError::ExceedsTaskBudget)?;
    require!(
        new_spent <= ctx.accounts.task_capability.budget_lamports,
        TaskVaultError::ExceedsTaskBudget
    );

    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    require!(
        vault_lamports >= params.amount_lamports,
        TaskVaultError::InsufficientVaultBalance
    );

    // Update spent lamports and pending escrows on task capability
    ctx.accounts.task_capability.spent_lamports = new_spent;
    ctx.accounts.task_capability.pending_escrows = ctx
        .accounts
        .task_capability
        .pending_escrows
        .checked_add(1)
        .ok_or(TaskVaultError::CalculationOverflow)?;

    // Initialize escrow account
    let escrow = &mut ctx.accounts.escrow;
    escrow.task_capability = ctx.accounts.task_capability.key();
    escrow.worker = ctx.accounts.worker.key();
    escrow.service_id = params.service_id;
    escrow.payment_id = params.payment_id;
    escrow.request_hash = params.request_hash;
    escrow.amount_lamports = params.amount_lamports;
    escrow.status = EscrowStatus::Held;
    escrow.bump = ctx.bumps.escrow;

    // Direct lamport debit from vault PDA to escrow PDA
    **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= params.amount_lamports;
    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? += params.amount_lamports;

    Ok(())
}
