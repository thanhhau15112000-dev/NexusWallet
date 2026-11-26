//! Shared checks and CPIs for tasks whose budget is an SPL token (classic Token program only).
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TaskVaultError;

/// The mint and token program a token task must be called with.
pub fn require_token_program<'a, 'info>(
    task_mint: &Pubkey,
    mint: &'a Option<Account<'info, Mint>>,
    token_program: &'a Option<Program<'info, Token>>,
) -> Result<(&'a Account<'info, Mint>, &'a Program<'info, Token>)> {
    let (Some(mint), Some(token_program)) = (mint, token_program) else {
        return err!(TaskVaultError::TokenAccountsRequired);
    };
    require_keys_eq!(mint.key(), *task_mint, TaskVaultError::InvalidTokenAccount);
    Ok((mint, token_program))
}

/// The associated token account of `wallet` for `mint`, still owned by `wallet`.
pub fn require_ata<'a, 'info>(
    account: &'a Option<Account<'info, TokenAccount>>,
    wallet: &Pubkey,
    mint: &Pubkey,
) -> Result<&'a Account<'info, TokenAccount>> {
    let Some(account) = account else {
        return err!(TaskVaultError::TokenAccountsRequired);
    };
    require!(
        account.key() == get_associated_token_address(wallet, mint)
            && account.mint == *mint
            && account.owner == *wallet,
        TaskVaultError::InvalidTokenAccount
    );
    Ok(account)
}

pub fn transfer<'info>(
    token_program: &Program<'info, Token>,
    mint: &Account<'info, Mint>,
    from: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
    amount: u64,
) -> Result<()> {
    let accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority,
    };
    token::transfer_checked(
        CpiContext::new_with_signer(token_program.to_account_info(), accounts, signer_seeds),
        amount,
        mint.decimals,
    )
}

pub fn close<'info>(
    token_program: &Program<'info, Token>,
    account: &Account<'info, TokenAccount>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let accounts = CloseAccount {
        account: account.to_account_info(),
        destination,
        authority,
    };
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        accounts,
        signer_seeds,
    ))
}
