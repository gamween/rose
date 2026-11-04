# Architecture

This document describes how rose is built. `docs/spec.md` says what rose is and what "done" means; this file says how each part of the spec is implemented. Live facts (addresses, gas, latencies) are in `docs/verification.md`.

## Components

| Component | Where | Role |
|---|---|---|
| `rose-engine` | `contracts/engine`, NEAR testnet | Classes, positions, NEP-245 units, accrual ledger, liens, cash ledger, rounds, sealed bids, opening, clearing, settlement, foreign custody and payouts. Keyless after deployment, no upgrade path. |
| `rose-ibe` | `contracts/ibe` | Boneh-Franklin IBE against the NEAR MPC CKD key (ported from Sealwell). Compiled into the engine (host-function backend) and into the browser (wasm-bindgen). |
| `rose-tusdc` | `contracts/tusdc`, NEAR testnet | NEP-141 Test USDC with a public capped mint. The NEAR cash venue. |
| `RoseVault` | `contracts/evm`, Base Sepolia | Immutable custody of Sablier streams and Base USDC, releases funds only against EIP-712 authorizations signed by the engine's MPC-derived key. |
| `TestUSDC`, `DemoToken`, `DemoStreamFaucet` | `contracts/evm`, Base Sepolia | Demo funds and "mint me a demo vesting position". |
| Solana vault | Solana devnet | Ed25519 address derived by the MPC for the engine (path `vault/sol`); holds Streamflow streams and SPL tokens. `gas/sol` pays fees of every engine-built transaction. |
| `@rose/sdk` | `packages/sdk` | TypeScript bindings, chain adapters, unlock math and the clearing reference used by the "Verify" panel. |
| Web | `apps/web`, Vercel | Landing, app, docs, status. Reads chains directly. `/api/faucet` is a demo convenience, not part of the protocol. |

## Engine state

All amounts are integers. Token amounts are base units of the token. Cash amounts are base units of the round's cash token (6 decimals). Fractions are fixed point with 1e18 precision, rounded down.

- `config`: MPC account and domain ids (sign secp256k1, sign Ed25519, CKD, ForeignTx), CKD master public key, fee recipient, RoseVault address, canonical Sablier Lockup address, accepted Base cash tokens, Streamflow program id, NEAR cash token, derived foreign addresses (`vault/base`, `vault/sol`, `gas/sol`), filled once by a permissionless `bootstrap` that reads `derived_public_key` from the MPC contract.
- `classes`: `class_id -> Class { chain, token, decimals, schedule, positions, total_units }`. `class_id` is the hex SHA-256 of the borsh-encoded normalized schedule, chain and token, so the same economic position always maps to the same class.
- `positions`: `position_id -> Position { class_id, source (Base stream id or Streamflow metadata pubkey), allocation, depositor, deposited_at, state }`.
- `holdings`: `(account, class_id) -> Holding { balance, checkpoint, claimable, encumbered }`, the NEP-245 ledger with accrual accounting (spec 4). Every balance change accrues `balance * (f(now) - checkpoint)` into `claimable` first.
- `cash`: `(account, venue) -> free cash`. Venues: `Near` (tUSDC NEP-141) and `Base(token)` (USDC held by RoseVault).
- `rounds`: `round_id -> Round { kind, class_id, venue, creator, opens_at, closes_at, key_timeout, reveal_window, max_price, status, key, key_received_at, bids, result }`.
- `liens`: `lien_id -> Lien { class_id, holder, units, claim_total, delivered, checkpoint, shares }`.
- `payouts`: `payout_id -> Payout { chain, kind, beneficiary, amount, authorization }` with the MPC signature or the signed Solana transaction stored once produced.
- Replay sets: Base `(tx_hash, log_index)`, Solana stream metadata pubkeys, Solana nonce accounts.
- `events`: a bounded ring buffer of recent events (kind, round, account, amounts, timestamp, tx context) so the app needs no indexer.

## Round state machine

`Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled`

| Method | Who | Guard | Effect |
|---|---|---|---|
| `create_tender`, `create_exit`, `create_advance` | issuer, anyone, holder | parameters valid; Tender escrow (budget + 30 bps) and Advance units available | Round `Scheduled` or `Open` |
| `place_bid`, `place_ask` | anyone | `opens_at <= now < closes_at` | Stores the ciphertext, escrows cash or locks units, takes the bond |
| `cancel_round` | creator | before the first bid | `Cancelled`, everything refundable |
| `close` | anyone | `now >= closes_at` | Requests the round key from CKD (retries unbounded) |
| `on_round_key` (callback) / `submit_key` | MPC / anyone | key verifies with one pairing check | `Revealing` from `key_received_at` |
| `cancel_no_key` | anyone | no key by `closes_at + key_timeout` | `Cancelled`, everything refundable |
| `open_bid` | anyone | `Revealing` and inside the window | Full FO verification of `(plaintext, sigma)`; the bid becomes opened, or void if it breaks its collateral |
| `clear` | anyone | window over | Unopened bids void and slashed; clearing price and per-bid fills computed and stored; `Settled` or `Cancelled` when nothing crosses |
| `settle_bid` | anyone | `Settled` or `Cancelled` | Applies one bid's result to the ledger (units, cash, refund, bond); idempotent |

Settlement is paginated by construction: `clear` computes the result once (bounded number of bids per round), then each bid is settled by its own call, usually by the participant when they claim.

## Foreign custody

- Base deposits: the holder calls `RoseVault.depositStream`; the app then calls `register_base_deposit(tx_hash, log_index, values)`. The engine rebuilds the `StreamDeposited` log from `values`, computes the expected ForeignTx payload hash, calls `verify_foreign_transaction` with `expected_payload_hash`, and in the callback checks the hash, the emitter (RoseVault), the canonical lockup, the schedule and non-cancelability, then mints units. Base cash deposits (`depositCash`) follow the same path.
- Solana deposits: the holder moves the stream to its deposit address `dep/<account>/<class>`; `move_sol_deposit` has the engine sign `transfer_recipient` to the vault; `register_sol_deposit` proves the stream's metadata account with ForeignTx `AccountState` and mints units.
- Payouts are pull-based: the engine debits the ledger, asks the MPC for a signature (EIP-712 for RoseVault, Ed25519 for Solana durable-nonce transactions it builds itself), and stores the result. Anyone can submit it on the foreign chain; the beneficiary's browser does it. A callback refunds only when the MPC produced no signature.
