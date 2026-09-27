use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(
        mut,
        seeds = [b"capability", task_capability.owner.as_ref(), task_capability.task_id.as_ref()],
        bump = task_capability.bump
    )]
    pub task_capability: Account<'info, TaskCapability>,

    #[account(
        mut,
        close = rent_recipient,
        seeds = [b"receipt", task_capability.key().as_ref(), receipt.payment_id.as_ref()],
        bump = receipt.bump,
        has_one = task_capability
    )]
    pub receipt: Account<'info, Receipt>,

    pub authority: Signer<'info>,

    /// CHECK: The handler requires this to be the authorized signer before closing the receipt.
    #[account(mut)]
    pub rent_recipient: AccountInfo<'info>,
}

pub fn handle_close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.rent_recipient.key(),
        ctx.accounts.authority.key(),
        TaskVaultError::UnauthorizedSigner
    );

    // Only the worker who paid the rent or the task owner can close it
    require!(
        ctx.accounts.authority.key() == ctx.accounts.receipt.worker
            || ctx.accounts.authority.key() == ctx.accounts.task_capability.owner,
        TaskVaultError::UnauthorizedSigner
    );

    Ok(())
}
