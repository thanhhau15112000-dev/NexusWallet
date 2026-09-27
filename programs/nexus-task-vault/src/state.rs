use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    Active = 0,
    Completed = 1,
    Revoked = 2,
    Expired = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Held = 0,
    Settled = 1,
    Refunded = 2,
}

#[account]
pub struct TaskCapability {
    pub owner: Pubkey,
    pub agent_signer: Pubkey,
    pub task_id: [u8; 32],
    pub budget_lamports: u64,
    pub spent_lamports: u64,
    pub per_payment_cap_lamports: u64,
    pub expiry: i64,
    pub status: TaskStatus,
    pub bump: u8,
    pub vault_bump: u8,
    pub pending_escrows: u32,
}

impl TaskCapability {
    pub const LEN: usize = 8 // discriminator
        + 32 // owner
        + 32 // agent_signer
        + 32 // task_id
        + 8  // budget_lamports
        + 8  // spent_lamports
        + 8  // per_payment_cap_lamports
        + 8  // expiry
        + 1  // status enum
        + 1  // bump
        + 1  // vault_bump
        + 4; // pending_escrows
}

#[account]
pub struct VaultAccount {
    pub task_capability: Pubkey,
    pub bump: u8,
}

impl VaultAccount {
    pub const LEN: usize = 8 // discriminator
        + 32 // task_capability
        + 1; // bump
}

#[account]
pub struct Escrow {
    pub task_capability: Pubkey,
    pub worker: Pubkey,
    pub service_id: [u8; 32],
    pub payment_id: [u8; 32],
    pub request_hash: [u8; 32],
    pub amount_lamports: u64,
    pub status: EscrowStatus,
    pub bump: u8,
}

impl Escrow {
    pub const LEN: usize = 8 // discriminator
        + 32 // task_capability
        + 32 // worker
        + 32 // service_id
        + 32 // payment_id
        + 32 // request_hash
        + 8  // amount_lamports
        + 1  // status
        + 1; // bump
}

#[account]
pub struct Receipt {
    pub task_capability: Pubkey,
    pub worker: Pubkey,
    pub payment_id: [u8; 32],
    pub service_id: [u8; 32],
    pub request_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub amount_lamports: u64,
    pub settled_at: i64,
    pub bump: u8,
}

impl Receipt {
    pub const LEN: usize = 8 // discriminator
        + 32 // task_capability
        + 32 // worker
        + 32 // payment_id
        + 32 // service_id
        + 32 // request_hash
        + 32 // result_hash
        + 8  // amount_lamports
        + 8  // settled_at
        + 1; // bump
}
