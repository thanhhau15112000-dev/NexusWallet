use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::*;
use crate::errors::TaskVaultError;

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct CreateAndFundTaskParams {
    pub task_id: [u8; 32],
    pub budget_lamports: u64,
    pub per_payment_cap_lamports: u64,
    pub expiry: i64,
    pub agent_signer: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: CreateAndFundTaskParams)]
pub struct CreateAndFundTask<'info> {
    #[account(
        init,
        payer = owner,
        space = TaskCapability::LEN,
        seeds = [b"capability", owner.key().as_ref(), params.task_id.as_ref()],
        bump
    )]
    pub task_capability: Account<'info, TaskCapability>,

    #[account(
        init,
        payer = owner,
        space = VaultAccount::LEN,
        seeds = [b"vault", task_capability.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_and_fund_task(
    ctx: Context<CreateAndFundTask>,
    params: CreateAndFundTaskParams,
) -> Result<()> {
    require!(params.budget_lamports > 0, TaskVaultError::InvalidBudget);
    require!(
        params.per_payment_cap_lamports > 0
            && params.per_payment_cap_lamports <= params.budget_lamports,
        TaskVaultError::InvalidPaymentCap
    );
    let now = Clock::get()?.unix_timestamp;
    require!(params.expiry > now, TaskVaultError::InvalidExpiry);

    let task = &mut ctx.accounts.task_capability;
    task.owner = ctx.accounts.owner.key();
    task.agent_signer = params.agent_signer;
    task.task_id = params.task_id;
    task.budget_lamports = params.budget_lamports;
    task.spent_lamports = 0;
    task.per_payment_cap_lamports = params.per_payment_cap_lamports;
    task.expiry = params.expiry;
    task.status = TaskStatus::Active;
    task.bump = ctx.bumps.task_capability;
    task.vault_bump = ctx.bumps.vault;
    task.pending_escrows = 0;

    let vault = &mut ctx.accounts.vault;
    vault.task_capability = task.key();
    vault.bump = ctx.bumps.vault;

    // Deposit budget lamports from owner to vault PDA
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        params.budget_lamports,
    )?;

    Ok(())
}
