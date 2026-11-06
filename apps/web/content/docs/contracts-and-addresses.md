---
title: Contracts and addresses
description: Every contract rose relies on, on NEAR testnet, Base Sepolia and Solana devnet.
order: 11
section: Reference
---

All addresses are testnet. Nothing is deployed on any mainnet. Live checks (engine access keys, balances, recent MPC requests) are on the [status page](/status).

## NEAR testnet

| Contract | Account | Notes |
|---|---|---|
| rose-engine | `{{ENGINE_ACCOUNT}}` | Rust, near-sdk 5.x. Classes, positions, NEP-245 units, liens, rounds, sealed bids, opening, clearing, settlement, cash ledger, foreign custody. No upgrade method, no delete-account path, no generic call method; new versions deploy to new accounts. The final engine, `engine.rose-app.testnet`, is keyless after init (`view_access_key_list` returns `[]`); the earlier staging engines kept a key, see below. |
| rose tUSDC | `tusdc.rose-app.testnet` | NEP-141 "Test USDC", 6 decimals, public mint capped at 10,000 tUSDC per account per 24 h. The NEAR cash venue. Keyless. |
| NEAR MPC | `v1.signer-prod.testnet` | Version 3.18.0. Domains: 0 Sign, CaitSith (secp256k1); 1 Sign, Frost (Ed25519); 2 Confidential Key Derivation (BLS12-381); 3 ForeignTx, CaitSith (secp256k1). Threshold 11. Foreign chains served include Base and Solana. |

Circle's USDC on NEAR testnet exists but is minted only through a captcha-gated faucet, so the NEAR cash venue is rose tUSDC.

The final engine `engine.rose-app.testnet` was deployed keyless from the reproducible build of commit `d5e1e0c`: its access keys were deleted after init, in the same run that checked its code hash and configuration. The staging engines before it (`engine-s1` to `engine-s5`) kept a full-access key held by the team; they are test history, not the trust model. The [status page](/status) shows the live access key check of the engine the app uses.

### Engine methods

Every lifecycle transition is a public method; there is no keeper.

| Method | Who | Guard | Effect |
|---|---|---|---|
| `bootstrap` | anyone, once | | Reads `derived_public_key` from the MPC contract and fills the derived foreign addresses (`vault/base`, `vault/sol`, `gas/sol`). |
| `create_tender`, `create_exit`, `create_advance` | issuer, anyone, holder | parameters valid; `closes_at` at most 30 days away, `key_timeout` 1 min to 7 d, `reveal_window` 5 min to 7 d (`get_limits`); Tender escrow (budget + 30 bps) and Advance units available | Round `Scheduled` or `Open`, with its largest buy quantity fixed |
| `place_bid`, `place_ask` | anyone | `opens_at <= now < closes_at`, at most `MAX_BIDS_PER_ROUND = 64` orders, one per side per account; 0.02 NEAR of storage attached; an Exit buyer's NEP-145 storage has room for the class's holding row | Stores the ciphertext, escrows cash or locks units, takes the bond; an Exit bid reserves the buyer's holding row until it settles |
| `cancel_round` | creator | before the first bid | `Cancelled`, everything refundable |
| `close` | anyone | `closes_at <= now < closes_at + key_timeout` | Requests the round key from CKD (retries unbounded, 80 Tgas attached); a round without any sealed order is cancelled instead |
| `on_round_key` (callback), `submit_key` | MPC, anyone | key verifies with one pairing check | `Revealing` from `key_received_at` |
| `cancel_no_key` | anyone | no key by `closes_at + key_timeout`, and no key request in flight (250 blocks after the last `close`) | `Cancelled`, everything refundable |
| `open_bid` | anyone | `Revealing`, inside the window | Full verification of `(plaintext, sigma)`; the bid is opened, or void when its escrow does not cover `limit * quantity` plus fee, its quantity exceeds its locked units or the round's largest buy quantity, or an Advance reserve's quantity is not the claim |
| `clear` | anyone | window over | Unopened bids void and slashed; orders priced above `max_price` left out of the clearing (not void); clearing price and fills computed and stored; `Settled`, or `Cancelled` when nothing crosses |
| `settle_bid` | anyone | `Settled` or `Cancelled` | Applies one bid's result to the ledger (units, cash, refund, bond); idempotent |
| `register_base_deposit` | anyone | ForeignTx `Log` proof at `Safe`, sent without `expected_payload_hash`; the callback recomputes the payload hash | Mints units for a `StreamDeposited` log |
| `register_base_cash` | anyone | ForeignTx `Log` proof, as above; 0.015 NEAR of record storage | Credits cash in the Base venue for a `CashDeposited` log; a token outside the accepted list is credited too and listed by `get_cash` |
| `attribute_sol_deposit` | the depositing NEAR account | ForeignTx `AccountState` proof that the stream sits at the caller's deposit address; 0.015 NEAR of record storage | Records the stream as attributed to the caller, or as refused and returnable |
| `move_sol_deposit` | anyone | stream attributed, not registered; 0.025 NEAR | Engine signs the vault's token account creation and `transfer_recipient` from the deposit address to the vault, with the caller's recent blockhash |
| `register_sol_deposit` | anyone | ForeignTx `AccountState` proof at `Finalized` | Mints units for a Streamflow stream held by the vault |
| `claim_base_tokens`, `withdraw_base_cash` | claimant | claimable balance; 0.025 NEAR | Debits, then stores an MPC-signed RoseVault `Transfer` authorization |
| `claim_sol_tokens` | claimant | claimable balance, proven nonce, receipt and token accounts, drawn streams more than five minutes from their end; 0.025 NEAR, 200 Tgas | Debits, then stores a signed durable-nonce payout transaction (`Signed`), drawing on streams and on the class's swept balance |
| `confirm_sol_payout`, `confirm_sol_redeem` | anyone | ForeignTx proof that the nonce advanced and of the receipt account | `Landed` (or `Released`) when the receipt holds the nonce's new value; refunded only after two proofs, 150 blocks apart, that it stayed behind |
| `sync_sol_stream` | anyone | ForeignTx `AccountState` proof of the stream metadata at `Finalized`; no payout or release of the stream unsettled | Books what Streamflow's auto-claim withdrew into the vault's token account in the class's swept balance (`get_sol_swept`) |
| `retry_base_signature`, `retry_sol_payout` | anyone | request failed, or unanswered for 600 blocks | Signs again (never refunds a signature request); abandons a payout still waiting for its proof |
| `redeem` | unit holder | holds `D_p` free units | Burns the units and authorizes the release of the position; on Solana it stays `Signed` until `confirm_sol_redeem` |

Units follow NEP-245 (`mt_transfer`, `mt_transfer_call` and the batch variants; token id = class id). The contract keeps a bounded, paginated event history in state so the app needs no indexer: 1,024 entries of at most 448 bytes each (free texts cut at 192 bytes), paid by nobody, so `new` refuses to initialize an engine whose balance does not cover its code and state, that history and the 0.5 NEAR MPC reserve (about 15.4 NEAR; the deployment script funds 17 NEAR).

### Round identity

`app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine_account || "," || "round/<id>")`, derived by the contract from the round id.

## Base Sepolia (chain id 84532)

| Contract | Address | Notes |
|---|---|---|
| RoseVault | `{{ROSE_VAULT}}` | Immutable, no owner. Signer = the engine's MPC-derived address (path `vault/base`). Holds Sablier streams and Base USDC. `depositStream`, `depositCash`, `attest`, `executeTransfer`, `executeRelease`. |
| Sablier Lockup v4 | `0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e` | Canonical lockup (`Sablier Lockup NFT`, `SAB-LOCKUP`, release `lockup@v4.0.1`). Only Lockup Linear streams of this contract are accepted. |
| Test USDC (tUSDC) | `{{BASE_TUSDC}}` | ERC-20 "Test USDC", 6 decimals, public mint capped at 10,000 tUSDC per address per 24 h. |
| Circle USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Also accepted as a Base cash token when a user already has it. The demo never depends on Circle's faucet. |
| Demo token | `{{DEMO_TOKEN}}` | The fictional issuer's token, streamed by the demo faucet. |
| Demo stream faucet | `{{DEMO_STREAM_FAUCET}}` | "Mint me a demo vesting position": creates a transferable, non-cancelable Lockup Linear stream of the demo token to the caller, one per class (Seed, KOL) per address per day. No owner. |

### EIP-712 authorizations

- Domain: RoseVault on chain 84532.
- `Transfer(address token, address to, uint256 amount, uint256 id)`: ERC-20 payout.
- `Release(address lockup, uint256 streamId, address to, bool vestedToRecipient, uint256 id)`: stream NFT release; `lockup` must be the canonical Sablier contract. The withdrawable balance goes first to the vault (`vestedToRecipient = false`, an in-kind redeem) or to `to` (`true`, the return of a refused stream).
- Signature from the MPC response: `v = 27 + recovery_id`, `r = big_R.x`, `s` (low-s). One replay bitmap for both types, 256 ids per storage word. No deadline.

### Events verified by the engine

`StreamDeposited(address sender, string nearAccount, address lockup, uint256 streamId, address token, uint8 decimals, uint128 deposited, uint128 withdrawn, uint40 start, uint40 cliff, uint40 end, uint40 granularity, uint128 startUnlock, uint128 cliffUnlock, bool cancelable, bool transferable, uint40 timestamp)` with `sender` and `streamId` indexed. The engine rebuilds the log byte by byte from the values the caller provides, verifies it through ForeignTx with the block-level log index, and compares the payload hash it recomputes with the one the MPC signed. `CashDeposited(address sender, address token, uint64 roundId, string nearAccount, uint128 amount, uint40 timestamp)`, with `sender`, `token` and `roundId` indexed, is verified the same way by `register_base_cash`.

## Solana devnet

| Account | Address | Notes |
|---|---|---|
| Streamflow program | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` | Streams must allow `transfer_recipient` for the recipient and must not be cancelable by the sender; classic SPL Token mints without a freeze authority only. |
| Vault | `{{SOLANA_VAULT}}` | MPC-derived Ed25519 address of the engine (path `vault/sol`). Recipient of deposited streams, owner of the token account each payout passes through, authority of payout nonce accounts. |
| Gas payer | `{{SOLANA_GAS_PAYER}}` | MPC-derived Ed25519 address (path `gas/sol`), funded with devnet SOL. Fee payer of every engine-built transaction. Balance on the status page. |
| Deposit addresses | derived per holder and class | Path `dep/<near_account>/<class>`, derived through the MPC contract's `derived_public_key`. |
| Payout nonce accounts | derived per claimant wallet | Two per payout or redeem, the durable nonce and the receipt: `createWithSeed(wallet, seed)`, the seed starting with `nonce_seed_prefix_of(near_account)` and adding up to 8 characters (the app uses no suffix for the nonce and `r` for the receipt); 80 bytes each, authority = vault, reused across claims, reserved to an action until it is settled. |

The engine proves a Streamflow stream with one ForeignTx `AccountState` read of the stream metadata account (1,104 bytes; recipient at offset 113, mint at offset 177), at deposit and in `sync_sol_stream`; payouts and redeems are settled on the nonce and receipt accounts alone.

## Explorers

Every transaction, account and address in the app links to a live explorer for its chain:

| Chain | Explorer | Links |
|---|---|---|
| NEAR testnet | [NEAR Rocks](https://testnet.near.rocks) (primary) | `/tx/<hash>`, `/account/<id>`, `/block/<height>` |
| NEAR testnet | [Near Validate](https://nearvalidate.org) (fallback, next to every NEAR transaction) | `/txns/<hash>?network=testnet` |
| Base Sepolia | [Basescan Sepolia](https://sepolia.basescan.org) | `/tx/<hash>`, `/address/<address>` |
| Solana devnet | [Solana Explorer](https://explorer.solana.com/?cluster=devnet) | `/tx/<signature>?cluster=devnet`, `/address/<address>?cluster=devnet` |

NearBlocks testnet stopped indexing in September 2026, so no link points to it.

## Third-party code

- `sealwell-ibe` by Sealwell (`Godwin-web3/sealwell`, MIT OR Apache-2.0): the Boneh-Franklin IBE implementation rose ports, with attribution.
- Sablier Lockup v4 and Streamflow are external protocols; rose only holds positions created by them.
