use anchor_lang::prelude::*;

#[error_code]
pub enum TaskVaultError {
    #[msg("Invalid budget: must be greater than zero")]
    InvalidBudget,
    #[msg("Invalid per-payment cap: must be greater than zero and <= budget")]
    InvalidPaymentCap,
    #[msg("Expiry must be in the future")]
    InvalidExpiry,
    #[msg("Task is not active")]
    TaskNotActive,
    #[msg("Task has expired")]
    TaskExpired,
    #[msg("Task has not expired yet")]
    TaskNotExpired,
    #[msg("Payment amount exceeds per-payment cap")]
    ExceedsPaymentCap,
    #[msg("Payment amount exceeds remaining task budget")]
    ExceedsTaskBudget,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Unauthorized signer")]
    UnauthorizedSigner,
    #[msg("Unauthorized worker for this escrow")]
    UnauthorizedWorker,
    #[msg("Unauthorized service for this task capability")]
    UnauthorizedService,
    #[msg("Escrow is not in held status")]
    EscrowNotHeld,
    #[msg("Escrow payment already settled")]
    AlreadySettled,
    #[msg("Cannot refund or close: pending escrows exist")]
    PendingEscrowsExist,
    #[msg("Result hash must not be empty or zero")]
    InvalidResultHash,
    #[msg("Calculation overflow")]
    CalculationOverflow,
    #[msg("Payment id already has a settlement receipt")]
    PaymentIdAlreadyUsed,
    #[msg("Receipt cannot be closed while the task can still accept payments")]
    ReceiptLockedWhileTaskActive,
    #[msg("Allowed worker must be set and differ from the agent signer")]
    InvalidAllowedWorker,
    #[msg("A verified owner acceptance signature for this output is required")]
    OwnerAcceptanceRequired,
}
