# Solana Vault & Policy Guard: P3 technical specification

This document is a design boundary for a future Anchor program. It is not a
claim that an on-chain program has been deployed or that the current agent has
become non-custodial.

## Account model

- `VaultConfig` PDA: seeds `['vault', authority]`; stores authority, bump,
  spending policy version, per-transaction lamport cap, and pause state.
- `Vault` PDA: seeds `['vault-balance', vault_config]`; owns the SOL and SPL
  token accounts used by the program.
- `Approval` PDA: seeds `['approval', vault_config, request_nonce]`; stores the
  request hash, recipient, asset/mint, amount, policy version, expiry, and a
  consumed flag.
- Token accounts use the canonical associated token program and retain the mint
  program id so Token-2022 extensions cannot be silently treated as legacy SPL.

## Instructions

1. `initialize_vault(authority, policy)` creates the config and vault PDAs.
2. `propose_transfer(request)` validates the request hash and writes a single
   use `Approval` account; it does not move funds.
3. `approve_transfer(request_nonce, owner_signature)` checks authority,
   policy version, expiry, amount, recipient, and `consumed == false`.
4. `execute_transfer(request_nonce)` performs the SOL or checked token transfer
   through the vault PDA, then marks the approval consumed in the same atomic
   instruction set.
5. `pause_vault` and `rotate_authority` are authority-gated recovery paths.

## Invariants

- Every executable transfer is bound to one request hash, policy version,
  nonce, recipient, mint/program id, and expiry.
- A consumed or expired approval cannot execute again.
- The vault PDA is the only transfer authority; the web server cannot sign an
  on-chain transfer with a private key.
- Policy changes invalidate older approval accounts by version mismatch.
- `execute_transfer` must fail atomically if the destination ATA cannot be
  created idempotently, the mint program is unexpected, or the vault balance is
  insufficient.

## Migration and proof gates

The current product still uses an encrypted off-chain agent key and Devnet
JSON state. Migration requires an Anchor workspace, an audited program, a
devnet deployment address, instruction-level tests, an upgrade authority plan,
and a recovery procedure for existing pending approvals. ZK Compression for
audit data is a separate experiment and must not replace the append-only local
audit until inclusion proofs, retention, and failure recovery are specified.
