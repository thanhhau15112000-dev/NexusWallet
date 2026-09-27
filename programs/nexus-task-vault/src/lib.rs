use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("3N4GYuQXvqhDeFKLWh4GiXdD3pr3PWcNRtkUyxSYPaUK");

#[program]
pub mod nexus_task_vault {
    use super::*;

    pub fn create_and_fund_task(
        ctx: Context<CreateAndFundTask>,
        params: CreateAndFundTaskParams,
    ) -> Result<()> {
        instructions::handle_create_and_fund_task(ctx, params)
    }

    pub fn execute_task_payment(
        ctx: Context<ExecuteTaskPayment>,
        params: ExecuteTaskPaymentParams,
    ) -> Result<()> {
        instructions::handle_execute_task_payment(ctx, params)
    }

    pub fn settle_with_receipt(
        ctx: Context<SettleWithReceipt>,
        params: SettleWithReceiptParams,
    ) -> Result<()> {
        instructions::handle_settle_with_receipt(ctx, params)
    }

    pub fn revoke_task(ctx: Context<RevokeTask>) -> Result<()> {
        instructions::handle_revoke_task(ctx)
    }

    pub fn refund_and_close(ctx: Context<RefundAndClose>) -> Result<()> {
        instructions::handle_refund_and_close(ctx)
    }

    pub fn refund_expired_escrow(ctx: Context<RefundExpiredEscrow>) -> Result<()> {
        instructions::handle_refund_expired_escrow(ctx)
    }

    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        instructions::handle_close_receipt(ctx)
    }
}
