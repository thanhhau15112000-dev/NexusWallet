use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::TaskVaultError;
use anchor_lang::solana_program::{ed25519_program, instruction::Instruction, sysvar::instructions::{load_current_index_checked, load_instruction_at_checked}};

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

    /// CHECK: Its address is constrained; only the runtime instruction sysvar is accepted.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_settle_with_receipt(
    ctx: Context<SettleWithReceipt>,
    params: SettleWithReceiptParams,
) -> Result<()> {
    // Revoke stops new payments; escrows already held stay settleable until expiry.
    let status = ctx.accounts.task_capability.status;
    require!(
        status == TaskStatus::Active || status == TaskStatus::Revoked,
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

    let expected_message = format!(
        "NEXUS_TASK_ACCEPTANCE_V1\nProgram: {}\nTask: {}\nEscrow: {}\nRequest: {}\nOutput: {}\nAmount (lamports): {}",
        ctx.program_id, ctx.accounts.task_capability.key(), ctx.accounts.escrow.key(),
        hex(&ctx.accounts.escrow.request_hash), hex(&params.result_hash),
        ctx.accounts.escrow.amount_lamports,
    );
    let instructions = ctx.accounts.instructions.to_account_info();
    let index = load_current_index_checked(&instructions)?;
    require!(index > 0, TaskVaultError::OwnerAcceptanceRequired);
    let verification = load_instruction_at_checked(usize::from(index - 1), &instructions)?;
    require!(
        matches_owner_acceptance(&verification, &ctx.accounts.task_capability.owner, expected_message.as_bytes()),
        TaskVaultError::OwnerAcceptanceRequired
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
    if status == TaskStatus::Active
        && ctx.accounts.task_capability.spent_lamports >= ctx.accounts.task_capability.budget_lamports
        && remaining_pending == 0
    {
        ctx.accounts.task_capability.status = TaskStatus::Completed;
    }

    Ok(())
}

fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{:02x}", byte)).collect()
}

// Accept only the self-contained, single-signature layout used by web3.js.
// The native Ed25519 program verifies the signature before this instruction executes.
fn matches_owner_acceptance(ix: &Instruction, owner: &Pubkey, message: &[u8]) -> bool {
    let data = &ix.data;
    if ix.program_id != ed25519_program::id() || !ix.accounts.is_empty()
        || data.len() != 112 + message.len() || data[0..2] != [1, 0] {
        return false;
    }
    let offsets: Vec<u16> = data[2..16].chunks_exact(2)
        .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]])).collect();
    offsets == [48, u16::MAX, 16, u16::MAX, 112, message.len() as u16, u16::MAX]
        && data[16..48] == owner.to_bytes()
        && data[112..] == *message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verification(owner: Pubkey, message: &[u8]) -> Instruction {
        let mut data = vec![1, 0];
        for value in [48u16, u16::MAX, 16, u16::MAX, 112, message.len() as u16, u16::MAX] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(owner.as_ref());
        data.extend_from_slice(&[7u8; 64]);
        data.extend_from_slice(message);
        Instruction { program_id: ed25519_program::id(), accounts: vec![], data }
    }

    #[test]
    fn accepts_only_owner_and_exact_message_in_self_contained_verification() {
        let owner = Pubkey::new_unique();
        let message = b"accept this output and amount";
        let ix = verification(owner, message);
        assert!(matches_owner_acceptance(&ix, &owner, message));
        assert!(!matches_owner_acceptance(&ix, &Pubkey::new_unique(), message));
        assert!(!matches_owner_acceptance(&ix, &owner, b"accept other output and amount"));
        let mut unrelated = ix.clone();
        unrelated.program_id = Pubkey::new_unique();
        assert!(!matches_owner_acceptance(&unrelated, &owner, message));
        for offset in [2, 4, 6, 8, 10, 12, 14] {
            let mut malformed = ix.clone();
            malformed.data[offset] ^= 1;
            assert!(!matches_owner_acceptance(&malformed, &owner, message));
        }
        for length in [0, 1, 15, 111, ix.data.len() - 1] {
            let mut truncated = ix.clone();
            truncated.data.truncate(length);
            assert!(!matches_owner_acceptance(&truncated, &owner, message));
        }
    }
}
