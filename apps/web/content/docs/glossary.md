---
title: Glossary
description: Definitions of every term used in rose, in alphabetical order.
order: 14
section: Reference
---

**Accrual accounting.** The per-class ledger `(balance, checkpoint, claimable, carry)` each account holds. On every balance change the contract first accrues `balance * (f(now) - checkpoint)` into `claimable` and sets `checkpoint = f(now)`, carrying the fraction below one base unit into the next accrual. Rounding always favors the pool.

**AccountState.** The ForeignTx extractor that proves the contents of a Solana account as the MPC nodes read it. rose uses it on a Streamflow stream's metadata account (recipient, schedule, flags, withdrawn amount), on its mint, on payout nonce and receipt accounts and on recipients' token accounts.

**Advance.** A round in which one holder sells a senior claim on the first `K` tokens that will unlock from `X` of their units (`K <= X * (1 - f(ts))`) to funders who bid sealed, per claimed token. Winners receive lien shares.

**app_id.** The per-round identity bids are encrypted to: `SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine_account || "," || "round/<id>")`, derived by the contract from the round id.

**Ask.** A sealed sell order in a Tender or Exit: a minimum price per locked token and a quantity, backed by units locked in the round.

**Bid.** A sealed buy order in an Exit or Advance: a limit price and a quantity, backed by a public cash escrow.

**Bond.** `max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's max price)`, posted in the round's cash token with every bid and refunded on a valid opening. Slashed if the bid is never opened or exceeds its collateral.

**Boneh-Franklin IBE.** The identity-based encryption scheme over BLS12-381 that seals bids, against the NEAR MPC CKD key (identity on G1, master key on G2). Ported from Sealwell.

**Candidate price.** In a Tender, a submitted ask price at or below the max price. `P*` is chosen among candidates.

**Cash venue.** Where a round's cash lives: NEAR tUSDC, or Base USDC held by RoseVault. One venue per round, declared at creation.

**Chain Signatures.** NEAR's MPC threshold signing for addresses on other chains. The engine's Base signer (`vault/base`) and Solana addresses (`vault/sol`, `gas/sol`, `dep/...`) are derived this way.

**CKD (Confidential Key Derivation).** Domain 2 of the NEAR MPC network: derives the private key of an identity on request of a contract. The engine requests a round's key only after `closes_at`.

**Claimable.** Tokens (or cash) an account can pull now: accrued unlocked tokens per class, seller proceeds, refunds.

**Class.** A set of economically identical positions: same chain, protocol, token, normalized unlock schedule, non-cancelable. Fungible. Identified by the hash of chain, token, decimals and normalized schedule.

**Clearing price (`P*`).** The single price, per locked token at `ts`, at which every fill of a round is settled.

**closes_at.** The block timestamp after which no bid is accepted and the key may be requested. Also the settlement time `ts`.

**Demand `D(P)`.** In an Exit or Advance, the sum of bid quantities with limit `>= P`.

**Deposit address.** On Solana, the MPC-derived address `dep/<near_account>/<class>` a holder transfers a stream to, so the deposit is attributed to that NEAR account and class.

**Durable nonce.** A Solana mechanism that makes a transaction valid until its nonce is advanced instead of expiring with a blockhash. A rose payout or redeem uses two nonce accounts of the claimant (authority = vault), created from their wallet with seeds that start with `nonce_seed_prefix_of` their NEAR account, and reused across claims: the transaction advances the durable nonce first and the receipt nonce account last. A durable-nonce transaction that fails on chain still advances its nonce but rolls back the receipt's advance, which is why Solana payouts are confirmed separately, on the receipt.

**Encumbered units.** Units pledged in an Advance. Non-transferable, cannot enter other rounds, cannot be redeemed, until the lien is delivered.

**Engine (rose-engine).** The NEAR contract holding classes, positions, units, liens, rounds, the cash ledger and the foreign custody logic. Keyless after init, no upgrade method.

**Escrow.** The public cash a buyer locks when placing a bid. The sealed `limit * quantity` plus its fee must not exceed it.

**Exit.** A round with sealed asks from holders and sealed bids from buyers, cleared at the price that maximizes traded volume.

**expected_payload_hash.** An optional field of a ForeignTx request that the engine deliberately omits: with it, a mismatch is silent and times out after 200 blocks (about 2 minutes). Without it the nodes sign the values they actually read, and the engine recomputes the payload hash in the callback and rejects a mismatch.

**Fee.** 30 bps of settled notional, charged to the buying side on top of the price, rounded up to the tick. Recipient fixed at init.

**Fill.** The quantity an order trades at `P*`, and the cash charged (buyer, rounded up) or paid (seller, rounded down) for it.

**ForeignTx.** Domain 3 of the NEAR MPC network: verification of a transaction or account on a foreign chain, signed over by the MPC nodes from their RPC quorum. Extractors used by rose: `Log` (Base) and `AccountState` (Solana).

**gas/sol.** The MPC-derived Solana address that pays the fees of every engine-built transaction, so anyone can broadcast them.

**Key timeout.** How long after `closes_at` the key may take to arrive before anyone can `cancel_no_key`, once no key request is in flight (default 1 h).

**Keyless.** A NEAR account with no access keys (`view_access_key_list` returns `[]`). Its code can only be driven through its public methods.

**Largest-remainder rationing.** The pro-rata rule at the marginal price level: each order gets `floor(remaining * qty / level_qty)`, then the leftover units go one each to the largest remainders, ties to the lower order id.

**Lien, lien share.** The senior claim created by an Advance. Funders hold lien shares in proportion to their fills; accruals of the encumbered units flow to them until the claim is delivered.

**Locked fraction.** `1 - f(ts)`: the locked tokens per unit at settlement time, the conversion between a price per locked token and a price per unit.

**Log.** The ForeignTx extractor that proves an EVM event by its transaction hash and block-level log index. Used for RoseVault's `StreamDeposited` and `CashDeposited` events.

**Marginal level.** The price level that does not fit entirely in the traded volume and is rationed pro rata.

**Max price.** The public price ceiling of a round, set by the issuer on a Tender. An order priced above it (a buyer's limit or a seller's minimum) takes no part in the clearing, and its bond, escrow and locked units come back at settlement. Also the valuation used for sellers' bonds.

**Midpoint rule.** In an Exit or Advance, after maximal volume and minimal imbalance, `P*` is the midpoint of the tied price interval, rounded down to a tick.

**Minimum fill.** The public lower bound an Advance holder sets on the volume; below it the round does not cross.

**MPC network.** The NEAR multi-party computation network (`v1.signer-prod.testnet` on testnet) that signs, derives keys and verifies foreign state under a threshold assumption, in TEEs.

**NEP-141.** NEAR's fungible token standard. rose tUSDC is NEP-141.

**NEP-245.** NEAR's multi-token standard. Units are NEP-245 tokens with the class id as token id.

**Non-inclusion property (ePrint 2025/2048).** Anything encrypted to a round identity, including ciphertexts never submitted, is readable once the round key is released.

**Opening.** Submitting `(plaintext, sigma)` for a sealed bid after the key is public. Fully verified by the contract; a malformed ciphertext can be opened by nobody.

**opens_at.** The block timestamp from which bids are accepted.

**Payout.** A pull-based transfer of cash or tokens to a beneficiary on a foreign chain, authorized by an MPC signature stored on NEAR. On Solana it is two-phase: the signed transaction stays `Signed` until `confirm_sol_payout` proves it landed (the receipt nonce account holds the nonce's new value), or proves twice, 150 blocks apart, that it did not execute (the receipt stays behind; then the claim is refunded).

**Position.** One locked allocation on a foreign chain held by rose's vault: a Sablier Lockup Linear stream on Base or a Streamflow stream on Solana.

**Pull-based.** The beneficiary (or anyone) submits a stored authorization on the foreign chain; the protocol pushes nothing.

**Q(P).** In a Tender, the volume bought at `P`: `min(S(P), floor(budget / cost per unit at P))`.

**Receipt nonce account.** The second nonce account of a Solana payout or redeem (authority = vault, created from the claimant's wallet like the durable nonce). The transaction advances it last, so it holds the nonce's new value only if the transaction executed: `confirm_sol_payout` and `confirm_sol_redeem` settle on it.

**Redeem (in kind).** Burning a position's allocation in units to take the position itself back to your own address.

**Reference price.** A public price an issuer may declare for a Tender. The Prices page shows the discount of `P*` to it, labeled as issuer-declared. There is no oracle.

**Remaining lock duration.** Time from a round's settlement to the end of the class schedule. Published with every clearing price.

**Reveal window.** The period after `key_received_at` during which openings are accepted (10 min in the demo, 24 h suggested in production).

**RoseVault.** The immutable Base contract that owns deposited Sablier streams and Base USDC and releases them only against EIP-712 authorizations signed by the engine's MPC-derived address.

**Round.** A sealed auction over units of one class: Tender, Exit or Advance.

**Sablier Lockup v4.** The Base vesting protocol rose supports, Lockup Linear model only, at `0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e` on Base Sepolia.

**Sealed book.** What the round page shows before close: the number of bids, each bid's escrow or locked units, and ciphertext hashes.

**Settlement time `ts`.** `closes_at`. Prices are quoted per locked token at `ts`; accruals switch from seller to buyer at `ts`.

**Slashing.** Forfeiture of a bid's bond when it is never opened or exceeds its collateral. Slashed bonds go to the fee treasury.

**Sputnik DAO.** The NEAR DAO framework. The issuer console builds a function-call proposal so a DAO can create and fund a Tender after a vote.

**Streamflow.** The Solana vesting protocol rose supports, program `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` on devnet. Its auto-claim withdraws every ended stream into its recipient's token account one second after the end, even with `automatic_withdrawal` = 0; rose books it for the vault's streams in the class's swept balance.

**submit_key.** The public engine method that accepts a round key from anyone, verified with a pairing check, so a lost MPC callback cannot freeze a round.

**Supply `S(P)`.** The sum of ask quantities with minimum price `<= P`.

**Swept balance.** Per Solana class, the tokens Streamflow's auto-claim moved from the vault's ended streams into the vault's token account, booked by anyone's `sync_sol_stream` and read with `get_sol_swept`. A claim can take from it (`swept` in `claim_sol_tokens`), paid with `transfer_checked` alone.

**Tender.** A round with one public buyer (the issuer), a public budget and max price, and sealed asks. Bought units are retired.

**Tick.** 0.000001 USDC, the price and cash resolution.

**tUSDC.** rose's valueless "Test USDC", 6 decimals, public mint capped per account per 24 h, on NEAR testnet and Base Sepolia.

**Uniform price.** Every fill of a round settles at the same `P*`, regardless of the individual limits and minimums.

**Unit.** One allocation unit of a class: a claim on one base unit of the class token under the class schedule. `D` units per position of allocation `D` (in base units).

**Unlock function `f(t)`.** The fraction of the allocation unlocked at `t`, an exact port of the protocol's own unlock math over the attested schedule, 1e18 fixed point, a lower bound of what every stream of the class has unlocked.

**vault/base, vault/sol.** The MPC derivation paths of the engine's Base signer and Solana vault address.

**Volume `V(P)`.** `min(D(P), S(P))` in an Exit or Advance.

**withdrawMax.** The Sablier call that moves a stream's withdrawable balance to its recipient. Callable by anyone when the destination is the recipient; the app calls it inside the claim flow with RoseVault as destination.
