---
title: Contracts and addresses
description: Every contract rose relies on, on NEAR testnet, Base Sepolia and Solana devnet.
order: 11
section: Reference
---

All addresses are testnet. Nothing is deployed on any mainnet. Live checks (keyless engine, balances, recent MPC requests) are on the [status page](/status).

## NEAR testnet

| Contract | Account | Notes |
|---|---|---|
| rose-engine | `{{ENGINE_ACCOUNT}}` | Rust, near-sdk 5.x. Classes, positions, NEP-245 units, liens, rounds, sealed bids, opening, clearing, settlement, cash ledger, foreign custody. Keyless after init (`view_access_key_list` returns `[]`), no upgrade method, no delete-account path, no generic call method. New versions deploy to new accounts. |
| rose tUSDC | `tusdc.rose-app.testnet` | NEP-141 "Test USDC", 6 decimals, public mint capped at 10,000 tUSDC per account per 24 h. The NEAR cash venue. Keyless. |
| NEAR MPC | `v1.signer-prod.testnet` | Version 3.18.0. Domains: 0 Sign, CaitSith (secp256k1); 1 Sign, Frost (Ed25519); 2 Confidential Key Derivation (BLS12-381); 3 ForeignTx, CaitSith (secp256k1). Threshold 11. Foreign chains served include Base and Solana. |

Circle's USDC on NEAR testnet exists but is minted only through a captcha-gated faucet, so the NEAR cash venue is rose tUSDC.

### Engine methods

Every lifecycle transition is a public method; there is no keeper.

| Method | Who | Guard | Effect |
|---|---|---|---|
| `bootstrap` | anyone, once | | Reads `derived_public_key` from the MPC contract and fills the derived foreign addresses (`vault/base`, `vault/sol`, `gas/sol`). |
| `create_tender`, `create_exit`, `create_advance` | issuer, anyone, holder | parameters valid; Tender escrow (budget + 30 bps) and Advance units available | Round `Scheduled` or `Open` |
| `place_bid`, `place_ask` | anyone | `opens_at <= now < closes_at` | Stores the ciphertext, escrows cash or locks units, takes the bond |
| `cancel_round` | creator | before the first bid | `Cancelled`, everything refundable |
| `close` | anyone | `now >= closes_at` | Requests the round key from CKD (retries unbounded) |
| `on_round_key` (callback), `submit_key` | MPC, anyone | key verifies with one pairing check | `Revealing` from `key_received_at` |
| `cancel_no_key` | anyone | no key by `closes_at + key_timeout` | `Cancelled`, everything refundable |
| `open_bid` | anyone | `Revealing`, inside the window | Full verification of `(plaintext, sigma)`; the bid is opened, or void if it exceeds its collateral |
| `clear` | anyone | window over | Unopened bids void and slashed; clearing price and fills computed and stored; `Settled`, or `Cancelled` when nothing crosses |
| `settle_bid` | anyone | `Settled` or `Cancelled` | Applies one bid's result to the ledger (units, cash, refund, bond); idempotent |
| `register_base_deposit` | anyone | ForeignTx `Log` proof with `expected_payload_hash` | Mints units for a `StreamDeposited` log, or credits cash for a `CashDeposited` log |
| `move_sol_deposit` | anyone | | Engine signs `transfer_recipient` from the deposit address to the vault |
| `register_sol_deposit` | anyone | ForeignTx `AccountState` proof | Mints units for a Streamflow stream held by the vault |
| `redeem` | unit holder | holds `D_p` free units | Burns the units and authorizes the release of the position |

Units follow NEP-245 (`mt_transfer`, `mt_transfer_call` and the batch variants; token id = class id). The contract keeps a bounded, paginated event history in state so the app needs no indexer.

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
- `Release(address lockup, uint256 streamId, address to, uint256 id)`: stream NFT release; `lockup` must be the canonical Sablier contract.
- Signature from the MPC response: `v = 27 + recovery_id`, `r = big_R.x`, `s` (low-s). One replay bitmap for both types, 256 ids per storage word. No deadline.

### Events verified by the engine

`StreamDeposited(address sender, string nearAccount, address lockup, uint256 streamId, address token, uint128 deposited, uint128 withdrawn, uint40 start, uint40 cliff, uint40 end, uint40 granularity, uint128 startUnlock, uint128 cliffUnlock, bool cancelable, bool transferable, uint40 timestamp)` with `sender` and `streamId` indexed. The engine rebuilds the log byte by byte from the values the caller provides and verifies it through ForeignTx with the block-level log index.

## Solana devnet

| Account | Address | Notes |
|---|---|---|
| Streamflow program | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` | Streams must allow `transfer_recipient` for the recipient and must not be cancelable by the sender. |
| Vault | `{{SOLANA_VAULT}}` | MPC-derived Ed25519 address of the engine (path `vault/sol`). Recipient of deposited streams, holder of withdrawn SPL tokens, authority of payout nonce accounts. |
| Gas payer | `{{SOLANA_GAS_PAYER}}` | MPC-derived Ed25519 address (path `gas/sol`), funded with devnet SOL. Fee payer of every engine-built transaction. Balance on the status page. |
| Deposit addresses | derived per holder and class | Path `dep/<near_account>/<class>`, derived through the MPC contract's `derived_public_key`. |

The engine proves a Streamflow stream with one ForeignTx `AccountState` read of the stream metadata account (1,104 bytes; recipient at offset 113, mint at offset 177).

## Explorers

Every transaction in the app links to a live explorer for its chain. NearBlocks testnet is frozen, so the app links to a live NEAR testnet explorer.

## Third-party code

- `sealwell-ibe` by Sealwell (`Godwin-web3/sealwell`, MIT OR Apache-2.0): the Boneh-Franklin IBE implementation rose ports, with attribution.
- Sablier Lockup v4 and Streamflow are external protocols; rose only holds positions created by them.
