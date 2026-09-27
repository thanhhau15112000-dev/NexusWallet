use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct SettleWithReceiptParams {
    pub result_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct SettleWithReceipt<'info> {
    #[account(
        mut,
        seeds = [b"capability", task_capability.owner.as_ref(), task_capability.task_id.as_ref()],
        bump = task_capability.bump
    )]
    pub task_capability: Account<'info, TaskCapability>,

    #[account(
        mut,
        seeds = [b"escrow", task_capability.key().as_ref(), escrow.payment_id.as_ref()],
        bump = escrow.bump,
        has_one = task_capability,
        has_one = worker
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = worker,
        space = Receipt::LEN,
        seeds = [b"receipt", task_capability.key().as_ref(), escrow.payment_id.as_ref()],
        bump
    )]
    pub receipt: Account<'info, Receipt>,

    #[account(mut)]
    pub worker: Signer<'info>,

    /// CHECK: Agent signer who funded the escrow account rent and receives the rent refund upon settlement
    #[account(
        mut,
        address = task_capability.agent_signer
    )]
    pub agent_signer: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_settle_with_receipt(
    ctx: Context<SettleWithReceipt>,
    params: SettleWithReceiptParams,
) -> Result<()> {
    require!(
        ctx.accounts.task_capability.status == TaskStatus::Active,
        TaskVaultError::TaskNotActive
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < ctx.accounts.task_capability.expiry,
        TaskVaultError::TaskExpired
    );
    require!(
        ctx.accounts.escrow.status == EscrowStatus::Held,
        TaskVaultError::EscrowNotHeld
    );
    require!(
        params.result_hash != [0u8; 32],
        TaskVaultError::InvalidResultHash
    );

    let remaining_pending = ctx
        .accounts
        .task_capability
        .pending_escrows
        .checked_sub(1)
        .ok_or(TaskVaultError::CalculationOverflow)?;
    ctx.accounts.task_capability.pending_escrows = remaining_pending;

    // Initialize receipt record
    let receipt = &mut ctx.accounts.receipt;
    receipt.task_capability = ctx.accounts.task_capability.key();
    receipt.worker = ctx.accounts.worker.key();
    receipt.payment_id = ctx.accounts.escrow.payment_id;
    receipt.service_id = ctx.accounts.escrow.service_id;
    receipt.request_hash = ctx.accounts.escrow.request_hash;
    receipt.result_hash = params.result_hash;
    receipt.amount_lamports = ctx.accounts.escrow.amount_lamports;
    receipt.settled_at = now;
    receipt.bump = ctx.bumps.receipt;

    // Release escrowed payment to worker, return account rent to agent signer
    let payment_amount = ctx.accounts.escrow.amount_lamports;
    let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
    let rent_refund = escrow_lamports.saturating_sub(payment_amount);

    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? = 0;
    **ctx.accounts.worker.to_account_info().try_borrow_mut_lamports()? += payment_amount;
    if rent_refund > 0 {
        **ctx.accounts.agent_signer.to_account_info().try_borrow_mut_lamports()? += rent_refund;
    }

    // Zero out escrow data to close account
    let escrow_info = ctx.accounts.escrow.to_account_info();
    let mut escrow_data = escrow_info.try_borrow_mut_data()?;
    for byte in escrow_data.iter_mut() {
        *byte = 0;
    }

    // If all budget spent and no pending escrows remain, mark task completed
    if ctx.accounts.task_capability.spent_lamports >= ctx.accounts.task_capability.budget_lamports
        && remaining_pending == 0
    {
        ctx.accounts.task_capability.status = TaskStatus::Completed;
    }

    Ok(())
}
