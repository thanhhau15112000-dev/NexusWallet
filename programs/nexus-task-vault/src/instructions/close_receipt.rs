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
        seeds = [b"receipt", task_capability.key().as_ref(), receipt.payment_id.as_ref()],
        bump = receipt.bump,
        has_one = task_capability
    )]
    pub receipt: Account<'info, Receipt>,

    /// CHECK: Recipient of the receipt account rent (worker who paid it or owner)
    #[account(mut)]
    pub rent_recipient: AccountInfo<'info>,

    pub authority: Signer<'info>,
}

pub fn handle_close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    // Only the worker who paid the rent or the task owner can close it
    require!(
        ctx.accounts.authority.key() == ctx.accounts.receipt.worker
            || ctx.accounts.authority.key() == ctx.accounts.task_capability.owner,
        TaskVaultError::UnauthorizedSigner
    );

    let rent = ctx.accounts.receipt.to_account_info().lamports();
    **ctx.accounts.receipt.to_account_info().try_borrow_mut_lamports()? = 0;
    **ctx.accounts.rent_recipient.to_account_info().try_borrow_mut_lamports()? += rent;

    let receipt_info = ctx.accounts.receipt.to_account_info();
    let mut receipt_data = receipt_info.try_borrow_mut_data()?;
    for byte in receipt_data.iter_mut() {
        *byte = 0;
    }

    Ok(())
}
