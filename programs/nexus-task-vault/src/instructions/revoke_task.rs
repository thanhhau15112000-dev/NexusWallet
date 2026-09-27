use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(Accounts)]
pub struct RevokeTask<'info> {
    #[account(
        mut,
        seeds = [b"capability", owner.key().as_ref(), task_capability.task_id.as_ref()],
        bump = task_capability.bump,
        has_one = owner
    )]
    pub task_capability: Account<'info, TaskCapability>,

    pub owner: Signer<'info>,
}

pub fn handle_revoke_task(ctx: Context<RevokeTask>) -> Result<()> {
    require!(
        ctx.accounts.task_capability.status == TaskStatus::Active,
        TaskVaultError::TaskNotActive
    );
    ctx.accounts.task_capability.status = TaskStatus::Revoked;
    Ok(())
}
