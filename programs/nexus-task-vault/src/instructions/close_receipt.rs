use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    /// CHECK: The capability may already be closed by refund_and_close; the handler only
    /// deserializes it while it is still owned by this program.
    #[account(mut)]
    pub task_capability: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"receipt", task_capability.key().as_ref(), receipt.payment_id.as_ref()],
        bump = receipt.bump,
        has_one = task_capability
    )]
    pub receipt: Account<'info, Receipt>,

    pub authority: Signer<'info>,

    /// CHECK: Receipt rent always returns to the worker who paid it.
    #[account(mut, address = receipt.worker @ TaskVaultError::UnauthorizedSigner)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn handle_close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let capability_info = ctx.accounts.task_capability.to_account_info();

    if capability_info.owner != ctx.program_id {
        // Capability already closed: only the worker can recover its receipt rent.
        require_keys_eq!(authority, ctx.accounts.receipt.worker, TaskVaultError::UnauthorizedSigner);
        return Ok(());
    }

    let data = capability_info.try_borrow_data()?;
    let capability = TaskCapability::try_deserialize(&mut &data[..])?;
    require!(
        authority == ctx.accounts.receipt.worker || authority == capability.owner,
        TaskVaultError::UnauthorizedSigner
    );

    // Receipts are the on-chain replay guard for payment ids, so they stay open
    // while execute_task_payment can still succeed for this task.
    let now = Clock::get()?.unix_timestamp;
    require!(
        capability.status != TaskStatus::Active || now >= capability.expiry,
        TaskVaultError::ReceiptLockedWhileTaskActive
    );

    Ok(())
}
