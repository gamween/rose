---
title: Cross-chain custody
description: How positions on Base and Solana are held, proven and paid out from the NEAR engine.
order: 5
section: Mechanism
---

## Principle

Positions never leave their chain. A Sablier stream stays on Base; a Streamflow stream stays on Solana. What moves is the ownership of the stream: into a vault that only the NEAR engine can instruct. The engine controls each vault through NEAR Chain Signatures (the MPC network signs for addresses derived for the engine) and learns about foreign state through the same network's foreign transaction verification (ForeignTx). There is no custodian, bridge, relayer or keeper.

MPC contract: `v1.signer-prod.testnet`, version 3.18.0. Domains: 0 Sign (secp256k1, for Base), 1 Sign (Ed25519, for Solana), 2 Confidential Key Derivation (BLS12-381, for sealing), 3 ForeignTx (foreign state verification). Threshold 11.

## Base Sepolia

### RoseVault

RoseVault is an immutable contract with no owner and no admin. It is the owner of every deposited Sablier stream and of the Base USDC used as a cash venue. Its signer, the MPC-derived address of the engine (path `vault/base`), is fixed in the constructor.

- `depositStream(lockup, streamId, nearAccount)`: if the stream has a withdrawable balance, the vault first withdraws it to the sender (`withdrawMax`, forwarding Sablier's `calculateMinFeeWei`), so the vested part stays with the depositor. It refuses streams that are not Lockup Linear, cancelable, non-transferable or depleted, pulls the NFT through `onERC721Received`, and emits a `StreamDeposited` snapshot with the full schedule.
- `depositCash(token, amount, nearAccount, roundId)`: pulls USDC and emits an event the engine verifies to credit the NEAR account's cash balance in the Base venue.
- `attest(streamId)`: emits the current state of a held stream, for refreshes.
- `executeTransfer(authorization, v, r, s)` and `executeRelease(authorization, v, r, s)`: the only ways assets leave the vault. Each takes an EIP-712 authorization (`Transfer(token, to, amount, id)` for ERC-20, `Release(lockup, streamId, to, id)` for a stream NFT) signed by the engine's MPC-derived address. There is no deadline; a replay bitmap by `id` makes each authorization usable exactly once. A release first withdraws any withdrawable balance to the vault so that already accrued tokens stay with unit holders. Anyone can submit an authorization; the claimant pays the gas.

The MPC signature maps to Ethereum's `(v, r, s)` as `v = 27 + recovery_id`, `r = big_R.x`, `s` low-s.

Only streams of the canonical Sablier Lockup v4 contract (`0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e`, Base Sepolia) are accepted.

### Deposit flow

1. The holder connects an EVM wallet (or the in-app demo wallet). The app lists their Sablier v4 streams and flags each as eligible or not (transferable, non-cancelable or renounced, token and schedule matching an existing class or creatable as a new one).
2. The holder approves RoseVault for the stream NFT and calls `depositStream`. The vault withdraws any vested balance to the holder, takes the NFT and emits `StreamDeposited(sender, nearAccount, lockup, streamId, token, deposited, withdrawn, start, cliff, end, unlockAmounts, cancelable, transferable, timestamp)`.
3. The app calls `register_base_deposit(tx_hash, log_index, values)` on the engine. The engine rebuilds the log from the provided values, computes the expected payload hash, and asks the MPC network to verify the transaction (Base, `Log` extractor) with `expected_payload_hash`, so a mismatch fails fast instead of timing out. In the callback it checks the hash, that the emitter is RoseVault, that the lockup is the canonical Sablier contract, that the stream is non-cancelable and that the schedule matches the class. It then mints `D` units to `nearAccount` with checkpoint `f(timestamp)`.

Replay protection: `(chain, tx_hash, log_index)` is recorded once.

### Unlocked tokens

Anyone can call Sablier `withdrawMax(streamId, RoseVault)`, because Sablier allows a withdrawal to the stream's recipient from any caller. The app does it inside the claim flow. Tokens withdrawn this way sit in RoseVault and are released to unit holders through `Transfer` authorizations.

## Solana devnet

### Addresses

- Vault: an Ed25519 address derived by the MPC for the engine (path `vault/sol`). It is the recipient of every deposited Streamflow stream and holds withdrawn SPL tokens.
- Gas payer: an MPC-derived Ed25519 address (path `gas/sol`), funded with devnet SOL. It is the fee payer of every transaction the engine builds, so anyone can broadcast them.
- Deposit addresses: one per holder and class (path `dep/<near_account>/<class>`), used for attribution.
- Streamflow program: `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ`.

### Deposit flow

1. The app derives `dep/<near_account>/<class>` through the MPC contract's `derived_public_key`. The holder calls Streamflow `transfer_recipient` to that address from Phantom, Solflare or the demo wallet.
2. `move_sol_deposit(stream)`: the engine builds and signs `transfer_recipient` from the deposit address to the vault, fee payer `gas/sol`; anyone broadcasts it. If the stream is not at the deposit address the transaction simply fails on chain. Attribution comes from the engine's own signed request, not from a caller-supplied claim.
3. `register_sol_deposit(stream, account_data)`: one ForeignTx `AccountState` proof on the Streamflow metadata account (1,104 bytes; recipient at offset 113, mint at offset 177) shows that the recipient is the vault, that the schedule matches the class, that the stream is not closed and not cancelable by the sender. Units are minted to the depositor.

Replay protection: the stream metadata pubkey, one registration per stream.

### Payouts with durable nonces

The engine builds every Solana message itself; it never signs bytes supplied by a caller. A payout transaction is: `AdvanceNonceAccount` on the payout's own durable nonce account (created by the claimant, authority = vault), then Streamflow `withdraw` and/or SPL `transfer` from the vault, fee payer `gas/sol`.

One signed transaction per payout nonce, stored on NEAR so anyone can broadcast it. A durable-nonce transaction does not expire and its fee payer is the engine's own address, so the stored transaction can be broadcast at any time and is never re-signed. A payout that nobody broadcasts blocks only its own nonce, nothing else.

## ForeignTx verification

The engine never trusts a caller's description of a foreign event. It asks the MPC network (`verify_foreign_transaction`, domain 3) to inspect the transaction or account on the foreign chain and sign over the extracted payload. For Base it uses the `Log` extractor, which matches the block-level log index of the receipt; for Solana it uses `AccountState`.

The engine always sends an `expected_payload_hash`, recomputed from the values the caller provided. If the foreign state does not match, the request fails immediately instead of timing out, and the callback checks the returned hash against its own recomputation before acting. Foreign state is therefore trusted to the MPC nodes' RPC quorum, not to any single RPC and not to the caller.

## Pull-based payouts and async safety

Every payout is pulled by its beneficiary; the protocol pushes nothing.

1. The engine accrues and debits the claimable balance (cash, tokens or a position) before asking for any signature. The debit happens first.
2. It asks the MPC to sign: an EIP-712 `Transfer` or `Release` for RoseVault, or a complete durable-nonce transaction for Solana.
3. The callback stores the signature on NEAR. The authorization or signed transaction is public and can be submitted to the foreign chain by anyone, at any time; the claimant's browser does it and pays the foreign gas.
4. The callback refunds the debit only on `PromiseError`, that is, when no signature was produced. If the MPC responded, the signature exists and is valid, so refunding would create a double spend; the callback therefore never refunds in that case. Callbacks are small with fixed gas.

Re-submitting an authorization is harmless: RoseVault's replay bitmap and the consumed Solana nonce make a second use fail.

## Cash

- On NEAR: `ft_transfer` (pull) of the cash token, rose tUSDC (NEP-141), from the engine to the claimant.
- On Base: the same RoseVault authorization flow for USDC.

## Redeem in kind

`redeem(position_id)` burns `D_p` class units (the position's allocation) from the caller and authorizes the release of that position: on Base the ERC-721 release (withdrawing any withdrawable balance to the vault first), on Solana `withdraw` then `transfer_recipient`. Liens and units locked in rounds cannot be redeemed.
