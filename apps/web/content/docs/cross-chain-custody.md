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

RoseVault is an immutable contract with no owner and no admin: no pause, no upgrade, no `receive`. It is the owner of every deposited Sablier stream and of the Base cash tokens used as a cash venue. The Sablier lockup and its signer, the MPC-derived address of the engine (path `vault/base`), are fixed in the constructor.

- `depositStream(lockup, streamId, nearAccount)`, payable: the caller must own the stream (an approval alone is not consent to a NEAR account). If the stream has a withdrawable balance, the vault first withdraws it to the sender (`withdrawMax`, forwarding Sablier's `calculateMinFeeWei` read in the same transaction and refunding the unused value), so the vested part stays with the depositor. It refuses a non-canonical lockup, an invalid NEAR account id, and streams that are not Lockup Linear, cancelable, non-transferable, canceled or depleted, or left with less than one whole token to lock; it pulls the NFT through `onERC721Received` and emits a `StreamDeposited` snapshot with the full schedule and the token's `decimals` read on chain.
- `createStreams(...)`: the issuer path. The vault pulls the tokens (refusing fee-on-transfer tokens: its balance must change by exactly the amount pulled), creates the cohort's Lockup Linear streams (non-cancelable, transferable, recipient = the vault) in one transaction, and emits one `StreamDeposited` per stream with the NEAR account of each holder.
- `depositCash(token, amount, nearAccount, roundId)`: pulls an ERC-20 that delivers exactly `amount` (fee-on-transfer and rebasing tokens are refused) and emits `CashDeposited`, which the engine verifies to credit the NEAR account's cash balance in the Base venue. Rounds only use the engine's accepted cash tokens (rose tUSDC and Circle USDC).
- `attest(streamId)`: emits the current state of a held stream, for refreshes.
- `executeTransfer(authorization, v, r, s)` and `executeRelease(authorization, v, r, s)`: the only ways assets leave the vault. Each takes an EIP-712 authorization (`Transfer(token, to, amount, id)` for ERC-20, `Release(lockup, streamId, to, vestedToRecipient, id)` for a stream NFT) signed by the engine's MPC-derived address. There is no deadline; a replay bitmap by `id` makes each authorization usable exactly once, and a failed execution leaves the id unused. A release first withdraws any withdrawable balance: to the vault for an in-kind redeem (`vestedToRecipient = false`), so already accrued tokens stay with unit holders, and to `to` for the return of a refused stream (`vestedToRecipient = true`), whose vested tokens belong to its owner. The flag is part of the signed message, so it cannot be changed by whoever submits the authorization. Anyone can submit an authorization; the claimant pays the gas.

The MPC signature maps to Ethereum's `(v, r, s)` as `v = 27 + recovery_id`, `r = big_R.x`, `s` low-s.

Only streams of the canonical Sablier Lockup v4 contract (`0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e`, Base Sepolia) are accepted. A stream sent to RoseVault with a plain `transferFrom` is unattributed: no units are minted and it can only leave through a `Release` authorization.

### Deposit flow

1. The holder connects an EVM wallet (or the in-app demo wallet). The app lists their Sablier v4 streams and flags each as eligible or not (transferable, non-cancelable or renounced, not canceled, not depleted, at least one whole token left to lock, token and schedule matching an existing class or creatable as a new one).
2. The holder approves RoseVault for the stream NFT and calls `depositStream`. The vault withdraws any vested balance to the holder, takes the NFT and emits `StreamDeposited(sender, nearAccount, lockup, streamId, token, decimals, deposited, withdrawn, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, timestamp)`.
3. The app waits until Base's `safe` head has passed the receipt's block (about 3 minutes after mining) plus about 30 s of margin, then calls `register_base_deposit` on the engine with the log's location (transaction hash, block hash, block number, transaction index, block-level log index) and its values. The engine asks the MPC network to verify the log (Base, `Log` extractor, finality `Safe`) **without** `expected_payload_hash`, so the nodes sign the values they actually read. In the callback it recomputes the payload hash from the caller's values and compares it with the response, then checks that the emitter is RoseVault, that the lockup is the canonical Sablier contract, that the stream is non-cancelable and transferable and that the schedule, built from the attested `decimals`, matches the class. It then mints `D = deposited` units (the full allocation of the stream) to `nearAccount` with checkpoint `f(timestamp)` raised to the withdrawn fraction `ceil(1e18 * withdrawn / deposited)` and capped at `f(now)`: the part that vested before the deposit was paid to the holder, so the units never accrue it a second time (100 deposited and 40 already vested give 100 units at checkpoint 0.4, which accrue the 60 tokens the stream will still pay into the vault). In the rare case where the withdrawn fraction is still above `f(now)` at registration, the units are reduced instead to the largest count whose lifetime claim fits `deposited - withdrawn`. A genuine log the engine refuses is recorded and the stream is returnable to its sender.

Replay protection: `(chain, tx_hash, log_index)` is marked pending when the request goes out, cleared on an MPC failure or a mismatch, and consumed only on a match. Every MPC-side failure (wrong values, unknown transaction, wrong log index, finality not reached) surfaces after about 2 minutes, and the app offers a retry. A successful round trip takes 6 to 9 s.

Base cash follows the same pattern: after `depositCash`, `register_base_cash` proves the `CashDeposited` log (0.015 NEAR of record storage) and credits the NEAR account's Base cash balance.

### Unlocked tokens

Anyone can call Sablier `withdrawMax(streamId, RoseVault)`, because Sablier allows a withdrawal to the stream's recipient from any caller. The app does it inside the claim flow. Tokens withdrawn this way sit in RoseVault and are released to unit holders through `Transfer` authorizations.

## Solana devnet

### Addresses

- Vault: an Ed25519 address derived by the MPC for the engine (path `vault/sol`). It is the recipient of every deposited Streamflow stream, the owner of the token account each payout passes through, and the authority of every payout nonce account.
- Gas payer: an MPC-derived Ed25519 address (path `gas/sol`), funded with devnet SOL. It is the fee payer of every transaction the engine builds, so anyone can broadcast them.
- Deposit addresses: one per holder and class (path `dep/<near_account>/<class>`), used for attribution.
- Payout nonce accounts: durable nonce accounts the claimant creates from their own wallet, authority = vault (see below).
- Streamflow program: `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ`.

### Deposit flow

A deposit is three engine calls: attribute, move, register. The proof of whose deposit a stream is comes first, because a request-only record could be front-run and `transfer_recipient` leaves no trace of the previous recipient.

1. The app computes the class id (`compute_sol_class_id`, a pure view: the first deposit of a class creates it at registration) and derives `dep/<near_account>/<class>` through the MPC contract's `derived_public_key`. The holder calls Streamflow `transfer_recipient` to that address from Phantom, Solflare or the demo wallet.
2. `attribute_sol_deposit` (0.015 NEAR of record storage, returned when nothing is recorded): the engine derives the deposit address of the caller itself, requires the stream's recipient to be that address, and proves the stream metadata and its mint account with one ForeignTx `AccountState` request at `Finalized` (about 7 s). An eligible stream is recorded as attributed to the caller. An ineligible one is recorded as refused and returnable to the holder's return address (`return_refused_deposit`).
3. `move_sol_deposit(stream, recent_blockhash)` (0.025 NEAR): the engine builds and signs the message itself: the vault's associated token account for the mint, created idempotently with `gas/sol` paying the rent, then Streamflow `transfer_recipient` from the deposit address to the vault, fee payer `gas/sol`. The caller supplies a recent blockhash: nothing is debited by this call, so an expired blockhash only means a retry. Anyone broadcasts it. If the stream is not at the deposit address the transaction simply fails on chain.
4. `register_sol_deposit(stream, anchor_tx, account_data)` (`registration_deposit_for`: 0.015 NEAR of record storage plus the holder's storage, whose unused part is returned): one ForeignTx `AccountState` proof at `Finalized` on the Streamflow metadata account (1,104 bytes; recipient at offset 113, mint at offset 177) shows that the recipient is the vault, that it pays the vault's token account, that the schedule matches the class and that the stream is still eligible. The app passes the account bytes it read at `finalized` right before the call; if the stream changed in flight the call fails in about 7 s and the app retries. A proof showing the stream anywhere but at the vault changes nothing. Units are minted to the attributed account.

Eligibility: not cancelable or transferable by the sender, transferable by the recipient, not closed or canceled, no automatic withdrawal, not pausable, no rate updates, no top-ups, no Streamflow or partner fee, at least one whole token left to lock, and a classic SPL Token mint without a freeze authority. Token-2022 mints are refused. A mint with a freeze authority is refused because whoever holds it could freeze the vault's token account, and with it every payout of the class.

Replay protection: the stream metadata pubkey, one registration per stream, ever. A stream refused at the vault is never attributed again.

### Payouts with durable nonces

The engine builds every Solana message itself; it never signs bytes supplied by a caller. A payout is two-phase, because a durable-nonce transaction that fails on chain still advances its nonce and only the chain can say whether it executed.

1. `claim_sol_tokens(source, draws, to_owner, nonce)` (0.025 NEAR, 200 Tgas): the claimant names the streams of the class to draw on, each at most what it can pay now, and the claim is their sum. The engine debits the claim and proves, with one ForeignTx `AccountState` request, the claimant's durable nonce account (authority = vault) and the recipient's existing associated token account. The message is `AdvanceNonceAccount`, one Streamflow `withdraw` per drawn stream, then SPL `transfer_checked` of the sum from the vault's token account to the recipient, fee payer `gas/sol`: the vault's token account receives in the same transaction exactly what it pays. `vault/sol` and `gas/sol` sign it, and the signed transaction is stored on NEAR.
2. Anyone broadcasts it, at any time (a durable-nonce transaction does not expire), and can re-broadcast it while it is unconfirmed.
3. The payout stays `Signed` until anyone calls `confirm_sol_payout`: one ForeignTx request proves that the nonce value changed (the transaction can no longer execute) and reads every drawn stream. One stream read as paid proves the transaction executed and the payout is `Landed`. Only when every stream reads exactly unchanged did it fail on chain, and the claim is refunded only on two such proofs, the second requested at least 150 blocks after the first one was answered.

Payout nonce accounts are created from the claimant's wallet with a seed (`createWithSeed(wallet, seed)`): the wallet is the base and the only signer, and the seed starts with the claimant's `nonce_seed_prefix_of` (a prefix of the hash of their NEAR account id), so a nonce account serves only the NEAR account its seed names and nobody can spend or front-run another claimant's nonce values. A nonce account is reused across claims, since its value changes after each. While a payout is unconfirmed, each stream it draws on carries it as its one unconfirmed payout and cannot be drawn on again; nothing else is blocked.

## ForeignTx verification

The engine never trusts a caller's description of a foreign event. It asks the MPC network (`verify_foreign_transaction`, domain 3) to inspect the transaction or account on the foreign chain and sign over the extracted payload. For Base it uses the `Log` extractor, which matches the block-level log index of the receipt; for Solana it uses `AccountState`, which signs the account as the nodes read it at request time.

The engine sends its requests without `expected_payload_hash`: measured on testnet, a mismatch with that field is silent and only times out after 200 blocks (about 2 minutes), whereas without it the nodes sign the true values in about 7 s. The callback recomputes the payload hash from the values the caller provided and compares it with the response before acting, so a mismatch is detected by the engine itself. Foreign state is therefore trusted to the MPC nodes' RPC quorum, not to any single RPC and not to the caller.

## Pull-based payouts and async safety

Every payout is pulled by its beneficiary; the protocol pushes nothing.

1. The engine accrues and debits the claimable balance (cash, tokens or a position) before asking for any signature. The debit happens first.
2. It asks the MPC to sign: an EIP-712 `Transfer` or `Release` for RoseVault, or a complete durable-nonce transaction for Solana. Every returned signature is verified against the derived key before it is stored.
3. The callback stores the signature on NEAR. The authorization or signed transaction is public and can be submitted to the foreign chain by anyone, at any time; the claimant's browser does it and pays the foreign gas (on Solana, `gas/sol` pays the fee).
4. A signature request never refunds: a failed request does not prove that no signature will ever surface, because an MPC response arriving after the yield timeout is public in its failed transaction. A Base authorization is retried until it is signed (`retry_base_signature`, 600 blocks after an unanswered request), since its id stays executable on RoseVault forever. A Solana action whose authority signature failed is cancelled on chain instead: the engine signs a transaction that only advances the same nonce, at most one of the two can execute, and the confirmation settles whichever did. Only a proof that failed before anything was signed, or a confirmation that the transaction did not execute, refunds. Callbacks are small with fixed gas.

Re-submitting an authorization is harmless: RoseVault's replay bitmap and the advanced Solana nonce make a second use fail.

## Cash

- On NEAR: `ft_transfer` (pull) of the cash token, rose tUSDC (NEP-141), from the engine to the claimant.
- On Base: the same RoseVault authorization flow for the round's cash token.

## Redeem in kind

`redeem(position_id, to, nonce?)` burns `D_p` class units (the position's allocation) from the caller's free units and authorizes the release of that position, which is `Releasing` meanwhile. On Base it is the ERC-721 release (withdrawing any withdrawable balance to the vault first), final once signed. On Solana the stream must carry no unconfirmed payout, and the caller also pays, from its own claimable tokens of the class, what the stream still owes the unit holders and takes away with it. The transaction is `AdvanceNonceAccount` then `transfer_recipient` from the vault to `to`, with no withdrawal, and it stays `Signed` until anyone calls `confirm_sol_redeem`. The burn is final only on evidence a stale read cannot show (another recipient, another token account, more withdrawn than the engine proved, or a closed or canceled stream). If two proofs, 150 blocks apart, show the stream exactly as registered, the transaction failed: the units and the claimable tokens paid come back and the position is held again. Liens and units locked in rounds cannot be redeemed, and a position has one release at a time.
