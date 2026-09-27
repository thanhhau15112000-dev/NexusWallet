use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(Accounts)]
pub struct RefundAndClose<'info> {
    #[account(
        mut,
        seeds = [b"capability", task_capability.owner.as_ref(), task_capability.task_id.as_ref()],
        bump = task_capability.bump
    )]
    pub task_capability: Account<'info, TaskCapability>,

    #[account(
        mut,
        seeds = [b"vault", task_capability.key().as_ref()],
        bump = vault.bump,
        has_one = task_capability
    )]
    pub vault: Account<'info, VaultAccount>,

    /// CHECK: Task owner who receives all remaining funds and rent
    #[account(
        mut,
        address = task_capability.owner
    )]
    pub owner: AccountInfo<'info>,

    pub caller: Signer<'info>,
}

pub fn handle_refund_and_close(ctx: Context<RefundAndClose>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let is_owner = ctx.accounts.caller.key() == ctx.accounts.task_capability.owner;
    let is_expired = now >= ctx.accounts.task_capability.expiry;
    let is_revoked = ctx.accounts.task_capability.status == TaskStatus::Revoked;

    // Must be either owner, or permissionless after expiry or revoke
    require!(
        is_owner || is_expired || is_revoked,
        TaskVaultError::UnauthorizedSigner
    );

    // Reject refund and close if pending escrows exist
    require!(
        ctx.accounts.task_capability.pending_escrows == 0,
        TaskVaultError::PendingEscrowsExist
    );

    // Drain vault balance back to owner
    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? = 0;
    **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += vault_lamports;

    // Zero out vault data to close
    let vault_info = ctx.accounts.vault.to_account_info();
    let mut vault_data = vault_info.try_borrow_mut_data()?;
    for byte in vault_data.iter_mut() {
        *byte = 0;
    }

    // Drain task capability rent back to owner
    let task_lamports = ctx.accounts.task_capability.to_account_info().lamports();
    **ctx.accounts.task_capability.to_account_info().try_borrow_mut_lamports()? = 0;
    **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += task_lamports;

    // Zero out task capability data to close
    let task_info = ctx.accounts.task_capability.to_account_info();
    let mut task_data = task_info.try_borrow_mut_data()?;
    for byte in task_data.iter_mut() {
        *byte = 0;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct RefundExpiredEscrow<'info> {
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
        has_one = task_capability
    )]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: Task owner who receives the refunded escrow
    #[account(
        mut,
        address = task_capability.owner
    )]
    pub owner: AccountInfo<'info>,

    /// CHECK: Agent signer who funded the escrow account rent
    #[account(
        mut,
        address = task_capability.agent_signer
    )]
    pub agent_signer: AccountInfo<'info>,

    pub caller: Signer<'info>,
}

pub fn handle_refund_expired_escrow(ctx: Context<RefundExpiredEscrow>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let is_owner = ctx.accounts.caller.key() == ctx.accounts.task_capability.owner;
    let is_expired = now >= ctx.accounts.task_capability.expiry;
    let is_revoked = ctx.accounts.task_capability.status == TaskStatus::Revoked;

    require!(
        is_owner || is_expired || is_revoked,
        TaskVaultError::UnauthorizedSigner
    );
    require!(
        ctx.accounts.escrow.status == EscrowStatus::Held,
        TaskVaultError::EscrowNotHeld
    );

    let payment_amount = ctx.accounts.escrow.amount_lamports;
    let escrow_lamports = ctx.accounts.escrow.to_account_info().lamports();
    let rent_refund = escrow_lamports.saturating_sub(payment_amount);

    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? = 0;
    **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += payment_amount;
    if rent_refund > 0 {
        **ctx.accounts.agent_signer.to_account_info().try_borrow_mut_lamports()? += rent_refund;
    }

    let escrow_info = ctx.accounts.escrow.to_account_info();
    let mut escrow_data = escrow_info.try_borrow_mut_data()?;
    for byte in escrow_data.iter_mut() {
        *byte = 0;
    }

    // Decrement pending escrows on task capability
    ctx.accounts.task_capability.pending_escrows = ctx
        .accounts
        .task_capability
        .pending_escrows
        .checked_sub(1)
        .ok_or(TaskVaultError::CalculationOverflow)?;

    Ok(())
}
