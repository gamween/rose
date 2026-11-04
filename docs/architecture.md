# Architecture

This document describes how rose is built. `docs/spec.md` says what rose is and what "done" means; this file says how each part of the spec is implemented. Live facts (addresses, gas, latencies) are in `docs/verification.md`. Method names below are the engine's ABI (`cargo near build non-reproducible-wasm` writes `target/near/rose_engine/rose_engine_abi.json`, 95 functions).

## Components

| Component | Where | Role |
|---|---|---|
| `rose-engine` | `contracts/engine`, NEAR testnet | Classes, positions, NEP-245 units, accrual ledger, liens, cash ledger, rounds, sealed bids, opening, clearing, settlement, foreign custody and payouts. Keyless after deployment, no upgrade path. |
| `rose-ibe` | `contracts/ibe` | Boneh-Franklin IBE against the NEAR MPC CKD key (ported from Sealwell). Compiled into the engine (host-function backend) and into the browser (`packages/ibe-wasm`, wasm-bindgen). |
| `rose-tusdc` | `contracts/tusdc`, NEAR testnet | NEP-141 Test USDC with a public capped mint. The NEAR cash venue. |
| `RoseVault` | `contracts/evm`, Base Sepolia | Immutable custody of Sablier streams and Base USDC, releases funds only against EIP-712 authorizations signed by the engine's MPC-derived key. |
| `TestUSDC`, `DemoToken`, `DemoStreamFaucet` | `contracts/evm`, Base Sepolia | Demo funds and "mint me a demo vesting position". |
| Solana vault | Solana devnet | Ed25519 address derived by the MPC for the engine (path `vault/sol`); holds Streamflow streams and SPL tokens. `gas/sol` pays fees of every engine-built transaction. |
| `mock-mpc` | `contracts/mock-mpc` (tests only) | Replays recorded MPC responses in the NEAR sandbox integration tests. Never deployed. |
| `@rose/sdk` | `packages/sdk` | TypeScript bindings, chain adapters, unlock math and the clearing reference used by the "Verify" panel. |
| Web | `apps/web`, Vercel | Landing, app, docs, status. Reads chains directly. `/api/faucet` is a demo convenience, not part of the protocol. |
| Scripts | `scripts` | Deployment (`deploy-base.sh`, `deploy-engine.sh`, `derive-vault-signer.sh`) and real-testnet end-to-end runs (`e2e-base-tender.sh`, `e2e-solana-stream.mjs`), recorded in `deployments/`. |

## Engine modules (`contracts/engine/src`)

| Module | Public methods (ABI) | Notes |
|---|---|---|
| `lib.rs` | `new(args: InitArgs)` | Init only; validates the CKD key, addresses and `base_chain_id`. No upgrade, migrate, delete or generic call method. |
| `math.rs`, `unlock.rs`, `clearing/`, `ledger.rs` | none | Pure modules (no NEAR dependency): fixed-point arithmetic, the Sablier and Streamflow unlock functions, the Tender and uniform-price clearing, the accrual ledger. Property-tested natively. |
| `units.rs` | `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`, `mt_batch_transfer_call`, `mt_resolve_transfer`, `distribute_units`, `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`, `mt_token` | NEP-245 units with accrual accounting. Voluntary receipts check the receiver's NEP-145 capacity; engine-owed credits never do. |
| `storage.rs` | `storage_deposit`, `storage_withdraw`, `storage_unregister`, `storage_balance_bounds`, `storage_balance_of` | NEP-145. Withdrawals and unregistration are refused while the account has live bids, locked units, liens or custody actions in flight; a withdrawal always leaves the registration minimum; an owed credit to an unregistered account registers it with a zero deposit. |
| `cash.rs` | `ft_on_transfer`, `withdraw_near_cash`, `on_near_cash_withdrawn` | The NEAR cash venue (tUSDC NEP-141). |
| `rounds.rs` | `create_tender`, `create_exit`, `create_advance`, `cancel_round`, `place_bid`, `place_ask` | Round creation, sealed orders, bonds and storage deposits. |
| `sealing.rs` | `close`, `on_round_key`, `submit_key`, `cancel_no_key`, `open_bid` | CKD key request and callback, open key submission, fully verified openings. |
| `settlement.rs` | `clear`, `settle_bid`, `release_lien` | One bounded `clear` per round, per-bid settlement, liens. |
| `custody/mod.rs` | `bootstrap`, `on_bootstrap`, `registration_deposit_for`, `get_replay`, `get_refused_deposit`, `compute_base_class_id`, `compute_sol_class_id` | Derived addresses, replay keys, the per-account count of custody actions in flight, the MPC call helpers. |
| `custody/base.rs` | `register_base_deposit`, `on_base_deposit_verified`, `register_base_cash`, `on_base_cash_verified` | Base deposits attested through ForeignTx `Log` at `Safe`; refused deposits are recorded. |
| `custody/solana.rs` | `attribute_sol_deposit`, `on_sol_deposit_key`, `on_sol_deposit_attested`, `move_sol_deposit`, `register_sol_deposit`, `on_sol_deposit_verified`, `get_sol_deposit`, `get_sol_stream`, `get_vault_pool`, `deposit_path_of` | The three-step Solana deposit (spec 7.2) and the per-stream withdrawal accounting. |
| `custody/payouts.rs` | `claim_base_tokens`, `withdraw_base_cash`, `on_base_signed`, `retry_base_signature`, `claim_sol_tokens`, `redeem`, `on_sol_nonce_verified`, `on_sol_signed`, `resign_sol_gas`, `on_sol_gas_resigned`, `return_refused_deposit`, `get_payout`, `get_payouts`, `get_pending_release`, `payouts_total` | Signed foreign actions (spec 7.3): EIP-712 authorizations for RoseVault, durable-nonce Solana transactions with Streamflow withdrawals inside, in-kind redeems, returns of refused deposits. |
| `custody/types.rs` | none | Custody records and JSON argument types (`ReplayKey`, `Payout`, `SolTransaction`, `SolStreamInfo`, …). |
| `events.rs` | none | NEP-297 `rose` events (custody events included) and the 1,024-entry on-chain ring buffer. |
| `views.rs` | `stats`, `get_config`, `get_limits`, `get_class`, `get_classes`, `get_position`, `get_positions`, `get_round`, `get_rounds`, `get_bids`, `get_bid`, `get_order_id`, `get_round_result`, `get_holding`, `get_retired_lot`, `get_portfolio`, `get_cash`, `get_liens`, `get_lien`, `get_price_history`, `get_events`, `quote_buy`, `quote_sell`, `get_claimable` | Read-only methods; the app needs no indexer. |
| `foreign/` | none | Pure cross-chain library: the MPC wire formats and payload hash (`mpc.rs`), RoseVault events, EIP-712 and secp256k1 mapping (`evm.rs`), Solana messages, SPL and Streamflow instructions and account layouts (`solana.rs`). |

`contract_source_metadata` is added by cargo-near.

## Engine state

All amounts are integers. Token amounts are base units of the token. Cash amounts are base units of the round's cash token (6 decimals). Fractions are fixed point with 1e18 precision, rounded down.

- `config`: MPC account and domain ids (sign secp256k1, sign Ed25519, CKD, ForeignTx), CKD master public key, fee recipient, NEAR cash token, accepted Base cash tokens, RoseVault address and its chain id (the EIP-712 domain), canonical Sablier Lockup address, Streamflow program id, default key timeout and reveal window, derived foreign addresses (`vault/base`, `vault/sol`, `gas/sol`), filled once by the permissionless `bootstrap` that reads `derived_public_key` from the MPC contract.
- `classes`: `class_id -> Class { chain, token, decimals, schedule, positions, total_units, created_at }`. `class_id` is the hex SHA-256 of the borsh-encoded `(chain, token, decimals, normalized schedule)`, so the same economic position always maps to the same class.
- `positions`: `position_id -> Position { class_id, source (Base stream or Streamflow metadata pubkey), allocation, depositor, deposited_at, state }`.
- `holdings`: `(holder, class_id) -> Holding { balance, checkpoint, claimable, encumbered }`, the NEP-245 ledger with accrual accounting (spec 4); the holder is an account or a Tender's retired lot. Every balance change accrues `balance * (f(now) - checkpoint)` into `claimable` first.
- `storage_accounts`: NEP-145 deposits and bytes used per account (the account record plus one row per class held).
- `cash`: `(account, venue) -> free cash`. Venues: `Near` (tUSDC NEP-141) and `Base { token }` (an ERC-20 held by RoseVault; every token is credited, only accepted ones can host rounds).
- `rounds`, `bids`, `orders`: `round_id -> Round { kind, class_id, venue, creator, window, max_price, f_ts, phase, key, result, terms, … }`, one sealed order per `(round, bidder, side)`.
- `liens`, `lien_shares`: `lien_id -> LienRecord { class_id, round_id, holder, lien { units, claim_total, delivered, f_start, excess_credited }, released }` and `(lien_id, funder) -> LienShare { claim, claimed }`.
- `account_index`: per account, the unsettled bids, live Advances, liens held and lien shares (what the views cannot scan and what blocks storage withdrawals).
- `price_history`: per class, the clearing price points.
- `events`: the ring buffer of the last 1,024 events with sequence number, block height, timestamp and predecessor.
- `custody`: replay keys (`BaseLog { tx_hash, log_index }`, `SolStream { metadata }`, `SolNonce { account, value }`) with their pending or consumed state, refused deposits, payouts (`Payout { chain, kind, debit, requester, requested_block, status, digest, base signature, solana transaction }`) and their per-account lists, Solana deposit records and stream infos (`engine_withdrawn` per stream), the per-class list of Solana positions, the per-mint vault pool, positions with a release in flight, per Solana position the number of unsigned payouts withdrawing from it (a redeem waits for zero), the per-account count of custody actions in flight.

## Round state machine

`Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled`

| Method | Who | Guard | Effect |
|---|---|---|---|
| `create_tender`, `create_exit`, `create_advance` | issuer, anyone, holder | parameters valid; Tender escrow (budget + 30 bps) and Advance units available; 0.05 NEAR attached | Round `Scheduled` or `Open` |
| `place_bid`, `place_ask` | anyone | `opens_at <= now < closes_at`, fewer than 64 orders, one order per side per account; 0.02 NEAR attached | Stores the ciphertext, escrows cash or locks units, takes the bond |
| `cancel_round` | creator | before the first bid and before `closes_at` | `Cancelled`, everything refundable |
| `close` | anyone | `now >= closes_at` | Requests the round key from CKD (retries unbounded); a round without orders is cancelled instead |
| `on_round_key` (callback) / `submit_key` | MPC / anyone | the round still waits for a key; the key verifies with one pairing check | `Revealing` from `key_received_at`; a late callback after `cancel_no_key` is ignored |
| `cancel_no_key` | anyone | no key by `closes_at + key_timeout` | `Cancelled`, everything refundable |
| `open_bid` | anyone | `Revealing` and inside the window | Full FO verification of `(plaintext, sigma)`; the bid becomes opened, or void if it breaks its collateral |
| `clear` | anyone | window over | Unopened bids void and slashed; clearing price and per-bid fills computed and stored; `Settled` or `Cancelled` when nothing crosses |
| `settle_bid` | anyone | `Settled` or `Cancelled` | Applies one bid's result to the ledger (units, cash, refund, bond, storage deposit); idempotent |
| `release_lien` | anyone | the lien's claim is delivered | Returns the encumbered units to the holder |

Settlement is paginated by construction: `clear` computes the result once (at most 64 orders per round), then each bid is settled by its own call, usually by the participant when they claim.

## Foreign custody

- Bootstrap: `bootstrap` asks the MPC contract for `derived_public_key` of `vault/base` (domain 0), `vault/sol` and `gas/sol` (domain 1) in three joined calls and stores the three addresses once; `scripts/derive-vault-signer.sh` computes the same addresses off chain so RoseVault can be deployed with the right signer before the engine exists.
- Base deposits: the holder calls `RoseVault.depositStream` (or the issuer `createStreams`); the app then calls `register_base_deposit(location, fields)` with the holder's registration deposit. The engine rebuilds the `StreamDeposited` log from the fields, computes the ForeignTx payload hash of its own request (`Log` extractor at `Safe`, no `expected_payload_hash`), and in the callback compares the attested hash, then checks the emitter (RoseVault), the canonical lockup, non-cancelability and transferability, builds the class from the attested schedule and decimals, and mints the units from the deposit checkpoint. A genuine log the engine refuses is recorded and returnable to its sender (`return_refused_deposit`). Base cash deposits (`depositCash`) follow the same path through `register_base_cash`.
- Solana deposits: `attribute_sol_deposit` proves the stream sits at the caller's deposit address (`dep/<account>/<class>`), `move_sol_deposit` has the engine sign `transfer_recipient` to the vault, `register_sol_deposit` proves the stream at the vault with ForeignTx `AccountState` and mints the units (spec 7.2).
- Payouts are pull-based: the engine debits the ledger, asks the MPC for a signature (EIP-712 for RoseVault; Ed25519 over a durable-nonce transaction it builds itself for Solana, with the Streamflow withdrawals that feed the transfer inside it) and stores the result. Anyone can submit it on the foreign chain; the beneficiary's browser does it. A callback refunds only when the MPC produced no signature; a Base authorization whose callback was lost can be re-requested after 600 blocks with `retry_base_signature` (whichever callback arrives first resolves the payout; later ones change nothing), a Solana transaction missing only its fee-payer signature is completed with `resign_sol_gas`.
- Every custody action in flight (a payout not yet signed or failed, a deposit registration not yet resolved) holds the account it will credit, which cannot withdraw its storage deposit meanwhile.

## Tests

- `cargo test --workspace`: unit and property tests of the pure modules, contract tests on the near-sdk mocked VM (`src/tests`), the recorded live vectors (`tests/vectors`: clearing, unlock, Sablier `streamedAmountOf` triples, ForeignTx round trips, MPC signatures, web3.js messages).
- `ROSE_SANDBOX=1 cargo test -p rose-engine --test 'sandbox_*'`: NEAR sandbox integration tests with the real engine wasm, the `mock-mpc` contract replaying recorded MPC responses and real transactions with their gas (spec 10); see `docs/verification.md`.
- `forge test` (from the repo root): RoseVault and the demo contracts, including fork tests against the live Sablier Lockup.
