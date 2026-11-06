---
title: How a sealed round works
description: The round lifecycle, who can advance it, how bids are sealed and opened, and what stays hidden.
order: 3
section: Mechanism
---

## Lifecycle

```
Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled
```

Every transition is a public method. There is no keeper, no relayer and no privileged operator. Whoever cares about the outcome advances the round, and the UI shows the next available action ("Close round", "Finalize", "Claim") to whoever is looking at it.

| State | What happens | Who moves it forward |
|---|---|---|
| `Scheduled` | The round exists; bidding has not started. | Time: it becomes `Open` at `opens_at`. |
| `Open` | Bids and asks are accepted until `closes_at` (block timestamp), at most `MAX_BIDS_PER_ROUND = 64` per round and one per side per account. The creator can cancel only before the first bid, and never after `closes_at`. | Anyone calls `close` once `now >= closes_at` (a round without any sealed order is cancelled instead). |
| `KeyRequested` | The contract has asked the NEAR MPC network for the round's decryption key. Retries are unbounded because the key is deterministic. | The MPC callback, or anyone with the key through `submit_key`. If no key has arrived by `closes_at + key_timeout` (default 1 h), anyone calls `cancel_no_key` once no key request is in flight. |
| `Revealing` | Starts at `key_received_at`, lasts `reveal_window` (10 min in the demo, 24 h suggested in production). Openings are accepted. | Anyone can open any bid; the app opens everything for whoever clicks "Finalize". |
| `Clearing` | After the window, `clear` computes the clearing price and every fill in one bounded transaction (64 orders at most); `settle_bid` then applies one bid's result at a time, which is the pagination of settlement. | Anyone. |
| `Settled` | Units and cash have moved inside the NEAR ledger. Each participant pulls their cash, units or refunds. | Each participant claims. |
| `Cancelled` | No crossing, no sealed order at close, cancelled by the creator before the first bid, or no key in time. Every escrow, bond and locked unit is refundable. | Each participant claims their refund. |

Creation bounds every duration the creator chooses (`get_limits` reports them): `closes_at` in the future and at most 30 days after creation, `key_timeout` between 1 minute and 7 days, `reveal_window` between 5 minutes and 7 days. Without them any creator (an Exit is open to anyone) could freeze a round forever, since `clear` waits for the end of the reveal window, or slash every bond with a window too short to land an opening. The minimum key timeout leaves time for a `close` sent right after `closes_at`; the minimum reveal window leaves time to open a full book of 64 orders. The create forms check every bound inline.

## Sealing

Bids are encrypted in the browser with Boneh-Franklin identity-based encryption (IBE) over BLS12-381, against the NEAR MPC network's Confidential Key Derivation (CKD) key, domain 2. The identity is on G1, the master key on G2. The implementation is ported from Sealwell (`Godwin-web3/sealwell`, MIT OR Apache-2.0) with attribution. The same crate compiles to wasm for the browser and into the NEAR contract, so encryption and verification share one implementation.

- Identity per round: `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine_account || "," || "round/<id>")`. The contract derives the path from the round id, never from an argument, so nobody can request a key for a different identity.
- Plaintext: `(quantity: u128, limit_price: u128, salt: [u8; 16])`, bound to `(round_id, bidder, side)` as associated data. A ciphertext cannot be replayed into another round or by another bidder.

## Key release after the deadline only

The key request (`request_app_private_key` on `v1.signer-prod.testnet`, `AppPublicKeyPV` variant with a public scalar, 1 yocto) exists in exactly one function of the engine, `close`. It is callable by anyone and guarded by `require!(now >= round.closes_at)`; retries are unbounded until `closes_at + key_timeout`. Gas (measured): the MPC's live config requires 15 Tgas attached, but the request itself burns about 11.6 Tgas on top of the 7 Tgas reserved for the yield return, so the measured minimum is 19 Tgas and the engine attaches 25. The app attaches 80 Tgas to `close`. The MPC network derives the private key for the round identity and returns it to the contract.

The engine has no upgrade method, and the final engine is keyless, so on it there is no code path by which anyone, including the operator, can obtain the key before the deadline. A staging engine keeps a full-access key, so its operator could replace its code; the [status page](/status) shows whether the engine the app uses has any access key.

`submit_key(sk)` is open to anyone and verified with `bls12381_pairing_check`, so a lost callback can never freeze a round: anyone who obtained the key from the MPC can hand it to the contract.

Measured on testnet (rose, consistent with Sealwell's 4.3 to 6.1 s): 4.1 to 5.4 s from the close transaction to the stored key, 37.4 to 37.5 Tgas in total including the callback (the closes of staging deployments 4 and 5).

## Opening: fully verified, no keeper, no challenge game

1. Once the key is public, anyone can open any bid by submitting `(plaintext, sigma)`. The contract fully verifies the opening: it recomputes `V` from the public key with one pairing in wasm and checks `U`, `V` and `W` (Sealwell measured 119.8 Tgas, 124 Tgas per receipt; rose measured 124.3 to 124.4 Tgas per transaction), so each opening fits in one transaction under the 300 Tgas wallet cap.
2. A ciphertext with an inconsistent `V` can be opened by nobody, its author included. This matters: a bidder cannot submit a malformed bid and then decide after seeing the book whether to reveal it. There is no free option, so no challenge window is needed.
3. The key being public, every participant's browser can decrypt every bid locally. The app opens all remaining bids in sequence for whoever clicks "Finalize". Each opening is a separate transaction prepaid with 200 Tgas, about 1.5 times the 132 Tgas the staging engine burns, because prepaid gas is charged up front at the pessimistic gas price; the opener pays about 0.0132 NEAR of gas per bid.
4. After the reveal window, bids that nobody opened (malformed) are void and their bond is slashed. An opened bid is also void and slashed if a buyer's `limit * quantity` plus its 30 bps fee exceeds its escrow, a buyer's quantity exceeds the round's largest buy quantity (`max_buy_quantity`, fixed at creation and shown with the round: the class supply then in an Exit, the claim in an Advance, so a redeem after the bid was sealed never voids a covered bid), a seller's quantity exceeds its locked units, or an Advance holder's reserve seals a quantity other than the claim `K` (the app fixes the reserve quantity to `K`). An opened order priced above the round's max price is not void: it takes no part in the clearing, and its bond, escrow and locked units come back at settlement.

## Collateral, bonds and slashing

- Buyers escrow a public budget (cash) at bid time. The sealed bid holds their limit price and quantity.
- Sellers lock units into the round at ask time. This is public, because positions are public anyway. The sealed ask holds their minimum price and the quantity they actually sell (at most the locked amount).
- Each bid posts a bond in the round's cash token, refunded on a valid opening: `max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's public max price)`.
- Slashed bonds go to the fee treasury fixed at init.

## What is hidden and what is public

Hidden until close: every price and every exact quantity.

Public at all times: the number of bids, each bid's escrow or locked amount, and the ciphertext hashes. The round detail page shows exactly this and nothing else before the key is released.

After close: everything is public. Opened plaintexts, the clearing price, every fill, and the settlement transactions on NEAR, Base and Solana. A "Verify" panel on the round page recomputes the clearing price in the browser from the opened bids.

## Known property: non-inclusion (ePrint 2025/2048)

Anything encrypted to a round identity, including ciphertexts that were never submitted to the contract, is readable once the round key is public. Two practical consequences:

- Do not encrypt a bid to a round identity and share the ciphertext anywhere unless you intend to submit it. After close, anyone holding that ciphertext can read it.
- Round identities are never reused. Each round has its own `app_id`, so the key of one round reveals nothing about another.

## cancel_no_key

If the MPC network does not deliver the key within `key_timeout` after `closes_at` (default 1 h), anyone can call `cancel_no_key(round)` once no key request is in flight (250 blocks after the last `close`, past the MPC's 200-block yield, so the engine can never store a key, nor open or clear anything, for a cancelled round). The round becomes `Cancelled`; every escrow, bond and locked unit is refundable.

The key itself may still become public: MPC nodes that answer after the yield timeout publish `(big_y, big_c)` in their failed `respond_ckd` transaction, which anyone unwraps with the round's public scalar, and a response whose callback failed is public while the round waits in `KeyRequested`. The sealed orders of a cancelled round can therefore become readable after the fact. No funds move after `Cancelled`, so the consequence is privacy only; it is the same property as the non-inclusion one above.

## Gas

Every user-facing method stays under 300 Tgas, the wallet cap. The 1 PGas protocol limit is used only by scripts and the in-app demo wallet.
