# rose: product and technical specification

Version 1.2, 2026-11-04 (after day-1 de-risking). This document is the source of truth for what rose is and what "done" means. Every claim about an external system (address, version, gas figure, API) must be re-verified live before it is relied on in code; figures marked "measured" come from testnet reads on 2026-11-03 and from the day-1 spikes of 2026-11-04, recorded with their commands in `docs/verification.md`.

## 0. One line

rose runs sealed, uniform-price liquidity rounds for locked token allocations: a project buys back its insiders' locked tokens without guessing a price, holders of the same allocation exit together without dumping, and nobody, not even the operator, can read a bid before the round closes. Positions stay where they live (Base, Solana); NEAR holds them through Chain Signatures and settles everything in one ledger.

Tagline (landing): **What was locked, rose.**

Status: testnet only (NEAR testnet, Base Sepolia, Solana devnet). Nothing touches mainnet.

## 1. Problem (evidence)

- Foundations already buy back locked allocations from their early investors, always bilaterally and at a fixed, unpublished price: Omni Foundation (6.77% of supply, May 2025), LayerZero Foundation (5% of supply, Sep 2025), Ethena Foundation (Aug 2026), Monad Foundation (up to $60M, Aug 2026). Sources: https://www.nomina.io/blog/omni-foundation-repurchase, https://unchainedcrypto.com/layerzero-foundation-buys-back-5-of-zro-token-supply-from-early-investors/, https://www.kucoin.com/blog/ethena-ena-tokenomics-buyback-vc-unlocks, https://monad.xyz/blog/early-investor-liquidity-program
- A fixed price fails because holders value the lock differently: Monad's offer was declined by "nearly all" approached holders (Monad's own program page above, and https://tokenomist.ai/research/monad-tokenomics-60m-exit-offer). A single price only finds the few sellers whose reservation price is below it.
- Open-market buybacks are large ($638M in Jan-Aug 2026, https://crypto.news/crypto-token-buybacks-hit-record-638m-in-2026/) and criticized for being predictable (front-run), for insiders selling into them, and for thin books (Lido planned ~$20M against ~$90k of on-chain depth at +/-2%, https://www.coindesk.com/markets/2026/03/30/lido-dao-proposes-usd20-million-ldo-buyback-to-boost-price-after-95-slide).
- Corporate finance solved this decades ago with the modified Dutch auction tender offer: holders submit sealed asks, the company pays one uniform price. Reported median premium 12.6% vs 16.0% for fixed-price offers (Comment and Jarrell, 1991, as cited by later studies). No live sealed tender exists in crypto (Sidelot has announced "Sealed Offer Rounds" for memecoin OTC, not live, not on NEAR).
- Locked tokens trade OTC at 20-40% typical discounts (STIX, $200-400M per month) and up to 70%, bilaterally, with no public price (https://alearesearch.io/podcast-digest/blockworks/otc-arbitrage-and-the-hidden-yield-in-cryptos-secondary-markets-or-das-nyc-2026-or-day-3-or-insights). 90% of 16,000+ unlocks are followed by a price decline starting ~30 days before (https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/).

## 2. Users and jobs

| User | Job | Today | With rose |
|---|---|---|---|
| Issuer (foundation, project treasury, DAO) | Buy back locked or vesting allocations before a cliff, fairly and verifiably | Private OTC offers at a guessed price, investor by investor | Launches a Tender round: public budget and max price, sealed asks, one uniform price, a public report |
| Holder (VC, angel, KOL round, sale participant, ex-team with a transferable position) | Get liquidity on a locked position without dumping at unlock | OTC desk at 20-70% discount, or wait and sell into the unlock | Deposits the position once, then sells in Tender or Exit rounds, or sells an Advance on its first unlocks |
| Buyer (fund, OTC desk, long-term believer) | Buy locked supply at a discount and hold the lock | Bilateral OTC, counterparty and settlement risk | Bids sealed in Exit and Advance rounds, receives units that inherit the exact schedule, claims unlocked tokens |

Primary user for the product and the demo: the issuer. Holders are the supply side. Buyers are the demand side of secondary rounds.

Most real team vestings are not transferable, so the primary onboarding path is the issuer path: the issuer calls RoseVault `createStreams(...)`, which pulls the tokens and creates the cohort's Sablier LL streams directly in custody in one transaction (non-cancelable, transferable, recipient = vault), emitting one `StreamDeposited` per stream with the NEAR account that receives the units (a stream created to the vault by a third party would carry no attribution). The issuer then distributes units to holders with `engine.distribute_units(token_id, receivers)`, a bounded batch that emits NEP-245 events (NEP-245 `mt_batch_transfer` has a single receiver, so a dedicated method is needed). Holder self-deposit of an existing transferable position is the second path.

## 3. Why blockchain, why NEAR (only load-bearing reasons)

1. **Delivery versus payment across chains without an escrow agent.** A seller is paid only if the position actually changes hands, and the position lives on Base or Solana. rose's NEAR contract controls a vault on each chain through Chain Signatures and proves foreign state through the MPC network's foreign transaction verification. On EVM-only stacks this needs a custodian or a bridge.
2. **Bids nobody can read early, including the operator.** Bids are encrypted to an identity whose key the NEAR MPC network releases (Confidential Key Derivation, domain 2) only when the round contract asks for it, and the contract can only ask after the deadline.
3. **A public, verifiable result.** Clearing price, allocations and fills are computed on-chain from opened bids. An issuer buying from its own insiders can show its community exactly what happened.
4. **One ledger for positions on several chains.** Units of a position class are NEP-245 multi-tokens on NEAR, transferable and composable, while the underlying stream never moves.

Where blockchain adds nothing, and we do not pretend otherwise: finding buyers (a cold-start problem), and the clearing algorithm itself (it runs fine off-chain in TradFi).

## 4. Product concepts

- **Class**: a set of positions that are economically identical: same chain, same protocol, same token, same normalized unlock schedule, non-cancelable. Class key (also the NEP-245 token id): lowercase hex SHA-256 of the Borsh encoding of (chain, token address or mint, decimals, normalized schedule). Normalized schedule: for Sablier, `(start, cliff, end, granularity)` kept as attested and `(deposited, startUnlock, cliffUnlock)` divided by their gcd; for Streamflow, the effective start (`cliff` when non-zero, else `start_time`, the only start the program's math reads), `end_time` and `period` kept, and `(net_amount_deposited, cliff_amount, amount_per_period)` divided by their gcd. Usually one cohort of one sale (same start, cliff, end). Positions in a class are fungible, which is what allows N sellers against M buyers at one price.
- **Position**: one locked allocation on a foreign chain, held by rose's vault. Supported in v1: Sablier Lockup v4 streams on Base Sepolia (ERC-721, Lockup Linear model only, any `granularity` (seconds per unlock step; v4 stores at least 1 and the unlock function models it), must be created `transferable = true`, non-cancelable or renounced, not canceled, not depleted, and still holding at least one whole token (`10^decimals` base units) after the deposit-time withdrawal; Dynamic, Tranched and Price-Gated streams are refused) and Streamflow streams on Solana devnet (`transfer_recipient` allowed for the recipient; `cancelable_by_sender`, `transferable_by_sender`, `pausable`, `can_update_rate` and `can_topup` all 0, `closed` 0, `canceled_at` 0, classic SPL Token mint). Cancelable positions are rejected.
- **Unit**: one allocation unit of a class, i.e. a claim on one base unit of the class token under the class schedule. A holder who deposits a position with allocation `D` (in base units) receives `D` units. Units are NEP-245 tokens, token id = class id. Holding units requires a NEP-145 storage registration on the engine (`storage_deposit`, minimum = the account record plus one holding row, about 0.00216 NEAR; each further class held costs one more row): a voluntary receipt (`mt_transfer`, `mt_transfer_call`, `distribute_units`, the mint of a deposit the holder requested) is refused unless the receiver is registered with capacity for the row, while everything the engine owes an account (settled units, returned locks, refunds, lien releases, `mt_transfer_call` refunds) always lands, the engine paying a missing row (an owed credit to an account that is not registered registers it with a zero deposit, so its rows stay accounted for). An account cannot withdraw or unregister its storage while it has live bids, locked units, liens or custody actions in flight, so an owed credit never finds an unfunded account, and `storage_withdraw` always leaves the registration minimum (`storage_balance_bounds().min`), so a registered account can always receive one class.
- **Unlock function**: each class has a deterministic `f(t)` in [0, 1], the fraction of the allocation unlocked at time `t`, stored as fixed point with 1e18 precision. It is an exact port of the protocol's own math over the attested schedule: for Sablier, `LockupMath.calculateStreamedAmountLL` of `lockup@v4.0.1` (start unlock at `start`, cliff unlock at `cliff`, then a linear segment floored to whole multiples of `granularity`, plain integer arithmetic, not UD60x18), lowered on the linear segment by a margin of `ceil(1e18 / 10^decimals)` because Sablier floors per stream and that floor does not scale across members (this is why a position must hold at least one whole token); for Streamflow, `cliff_amount + floor((t - start) / period) * amount_per_period` capped at the deposit, with no margin because it is exactly proportional. `f` is a lower bound: `D_p * f(t) <= 1e18 * streamed_p(t)` for every member `p` of the class (property-tested, and the Sablier port matches 197 of 197 live `streamedAmountOf` reads). A unit's accrued entitlement between two times is `f(t2) - f(t1)` tokens. Locked tokens per unit at time `t` = `1 - f(t)`.
- **Accrual accounting**: every account holds `(balance, checkpoint, claimable)` per class. On every balance change (mint, `mt_transfer`, `mt_transfer_call` refund, lock into a round, settlement, burn) the contract first accrues `balance * (f(now) - checkpoint)` into `claimable` and sets `checkpoint = f(now)`. Units locked in a round keep accruing to the seller until `ts = closes_at`; sold units accrue to the buyer from `ts`; unsold units return to the seller with their accrual. All amounts use 256-bit arithmetic; rounding always favors the pool (dust stays in the vault).
- **Round**: a sealed auction over units of one class. Three types:
  - **Tender**: one public buyer (the issuer) with a public budget and a public max price; sealed asks from any number of holders. Units bought are retired (their unlocked tokens go to the issuer's chosen address or a burn address).
  - **Exit**: sealed asks from any number of holders of the class, sealed bids from any number of buyers. Uniform price at the intersection.
  - **Advance**: one holder sells a senior claim on the first `K` tokens that will unlock from `X` of their units, with `K <= X * (1 - f(ts))`; sealed bids from funders. Winners receive lien shares; accruals of the encumbered units flow to lien holders until `K` tokens are delivered, then the encumbrance ends. Encumbered units are non-transferable and cannot enter other rounds. No oracle, no liquidation.
- **Clearing prices**: every settled round publishes its clearing price per locked token, its remaining lock duration and its volume. The Prices page shows the history per class and price versus remaining lock time across classes of the same token. There is no spot oracle on testnet, so no implied discount is computed on-chain; when an issuer declares a public reference price for a Tender, the page shows the discount to that declared reference, labeled as such.

## 5. Mechanism

### 5.1 Sealing

- Scheme: Boneh-Franklin IBE over BLS12-381 against the NEAR MPC CKD domain 2 key (identity on G1, master key on G2), as implemented and proven on testnet by Sealwell (`Godwin-web3/sealwell`, MIT OR Apache-2.0). We depend on or port its `sealwell-ibe` crate with attribution (README "Third-party code" section). The same crate compiles to wasm for the browser and to the NEAR contract, so encryption and verification share one implementation.
- Identity per round: `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" || engine_account || "," || "round/<id>")`. The contract derives the path from the round id, never from an argument.
- Plaintext: `(quantity: u128, limit_price: u128, salt: [u8; 16])`, bound to `(round_id, bidder, side)` as associated data.
- The key request (`request_app_private_key` on `v1.signer-prod.testnet`, `AppPublicKeyPV` variant with a public scalar, 1 yocto) exists in exactly one function, callable by anyone, guarded by `require!(now >= round.closes_at)`. Gas (measured): the live config requires 15 Tgas attached and reserves 7 Tgas for the yield return, and the request itself burns about 11.6 Tgas, so 15 to 18 Tgas fail with "Exceeded the prepaid gas"; the measured minimum is 19 Tgas and the engine attaches 25. The callback (unwrap of `big_c - a * big_y`, then the pairing check) costs 12.4 Tgas and gets a fixed 15 Tgas; `close` attaches about 60 Tgas in total. Retries are unbounded (the key is deterministic). `submit_key(sk)` is open to anyone and verified with `bls12381_pairing_check` (10.2 Tgas), so a lost callback can never freeze a round: the MPC response (`big_y`, `big_c`) is public in the receipt and anyone can unwrap it with the public scalar. Untrusted BLS points never rely on host decompression for subgroup checks (NEP-488 `bls12381_p1/p2_decompress` do not check membership); they go through `g1_multiexp` or `pairing_check`.
- Measured on testnet (rose spike, consistent with Sealwell's 4.3 to 6.1 s): 4.2 to 4.8 s from the close transaction to the stored key, 35.0 Tgas in total including the callback; 12 to 17 ms per encryption in the browser, 192-byte ciphertexts.

### 5.2 Opening (fully verified, no keeper, no challenge game)

1. Once the key is public, anyone can open any bid by submitting `(plaintext, sigma)`. The contract fully verifies the opening: it recomputes `V` from the public key with one pairing in wasm and checks `U`, `V` and `W` (Sealwell measured 119.8 Tgas, 124 Tgas per receipt; rose measured 124.3 to 124.4 Tgas per transaction, 0.0124 NEAR), so each opening fits one transaction under the 300 Tgas wallet cap. A ciphertext with an inconsistent `V` can therefore be opened by nobody, its author included (shown live: the author's own sigma and plaintext fail on chain while the key is public): there is no free option to reveal or withhold after seeing the book, and no challenge window. A ciphertext copied from another bidder fails at the `U` check (4.4 Tgas) because the associated data binds `(round_id, bidder, side)`.
2. The key being public, every participant's browser can decrypt every bid locally; the app opens all remaining bids in sequence for whoever clicks "Finalize" (each opening is a separate transaction prepaid with 200 Tgas, about 1.5 times the 132 Tgas the staging engine burns, because prepaid gas is charged up front at the pessimistic gas price and 300 Tgas would require 0.30 NEAR of balance from a small demo account; the opener pays about 0.0132 NEAR of gas per bid).
3. After the reveal window, bids that nobody opened (malformed) are void and their bond is slashed. An opened bid is also void (and slashed) if a buyer's `limit * quantity` exceeds its escrow or a seller's quantity exceeds its locked units.
4. Known property (ePrint 2025/2048): anything encrypted to a round identity, including ciphertexts that were never included, is readable after close. Documented in the security model.

### 5.3 Collateral and what stays hidden

- Buyers escrow a public budget (cash) at bid time; the sealed bid holds their limit price and quantity. Sellers lock units into the round at ask time (publicly, because positions are public anyway); the sealed ask holds their minimum price and the quantity they actually sell (<= locked).
- Hidden until close: every price and every exact quantity. Public: number of bids, each bid's escrow or locked amount.
- Each bid posts a bond in the round's cash token, refunded on a valid opening: max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's public max price).

### 5.4 Clearing (computed on-chain, bounded)

Prices are quoted per locked token at the round's settlement time `ts = closes_at`; the contract converts to per-unit using `1 - f(ts)`. Ties are resolved deterministically; ticks of 1e-6 USDC.

- **Tender**: candidate prices are the submitted asks `<= max_price`. Supply `S(P)` = sum of quantities with ask `<= P`. Volume bought at `P` is `Q(P) = min(S(P), floor(budget / P))`. `P*` = argmax of `Q` over candidates, ties to the lowest `P`. Asks are filled in ascending order of price; the marginal price level is filled pro rata; every filled seller receives `P*`; the unspent budget is refunded. Example: asks 100 @ 9 and 10 @ 10, budget 950: `Q(9) = 100`, `Q(10) = 95`, so `P* = 9`, 100 units bought for 900, 50 refunded. Property-tested against a brute-force reference.
- **Exit**: demand `D(P)` = sum of bid quantities with limit `>= P`, supply `S(P)` as above, volume `V(P) = min(D, S)`. `P*` maximizes `V`; ties broken by minimal `|D - S|`, then by the midpoint of the tie interval (which is contiguous, since `D` is non-increasing and `S` non-decreasing) rounded down to a tick. Fill rule (as implemented in `contracts/engine/src/clearing/uniform.rs`): the short side fills fully; on the long side, orders are taken by price priority (bids by descending limit, asks by ascending minimum, then ascending id) in whole price levels while the cumulative quantity fits `V(P*)`; the first level that does not fit is rationed pro rata by largest remainder (ties to the lower id); every level below it is unfilled. Because `P*` usually lies strictly inside the tie interval where no order sits, "strictly better limits fill fully" holds level by level, not by comparison with `P*`: the rationed level may be above `P*`. Unfilled buyer escrow is refundable.
- **Advance**: the holder's sealed reserve price is one ask for the `K`-token claim; funders' bids are per claimed token. Same price and fill rule as Exit with a single ask, partial fill allowed down to a holder-chosen minimum (`min_fill <= K`; below it, no crossing). When demand is short the price follows the Exit rule literally: the midpoint of the tie interval, possibly above the holder's reserve (one bid of 50 @ 20 against a reserve of 10 clears at 15). This is intended: the reserve is a floor, not a price, and the midpoint shares the surplus between the holder and the funders.
- A round cannot be created on a class that is fully unlocked at `ts` (`f(ts) = 1`): there is no locked token to price.
- Settlement: `clear(round)` computes `P*` and every fill in one bounded transaction (a round accepts at most `MAX_BIDS_PER_ROUND = 64` bids, so `clear` always fits), then `settle_bid(round, bid)` applies one bid's result at a time (idempotent, callable by anyone): units or lien shares to buyers, cash to sellers, refunds, bond refund or slash, storage deposit refund. This per-bid settlement is the pagination; there is no multi-page `clear`. Units and cash move inside the NEAR ledger; payouts to foreign chains are pull-based (section 7). A round with no crossing is `Cancelled` and everything unlocks.
- Cash venue: each round declares exactly one cash venue at creation (NEAR tUSDC, the rose NEP-141 at `tusdc.rose-app.testnet`, or a Base ERC-20 held by RoseVault from the engine's accepted list: rose tUSDC and Circle USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). All escrows, bonds, fees and seller proceeds of that round live in that venue and are claimable only there. The bid form shows the venue.

### 5.5 Fees

30 bps of settled notional, charged to the buying side on top of the price, shown before every bid and in every receipt. The issuer in a Tender escrows `budget + 30 bps of budget` at creation; the fee actually charged is 30 bps of the notional actually bought, so at settlement the unspent budget and the unused part of the fee are both refunded. Exit and Advance buyers escrow `limit * quantity` plus its fee and get back everything above their charge plus fee. This undercuts OTC desk spreads by an order of magnitude. Fee recipient is fixed at init. Slashed bonds go to the same treasury.

### 5.6 Round lifecycle (every transition is a public method; there is no keeper)

`Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled`

- `Open`: bids and asks accepted until `closes_at` (block timestamp), at most `MAX_BIDS_PER_ROUND = 64` per round. A round can be cancelled by its creator only before its first bid; never after `closes_at`. Exit rounds can be created by anyone (`create_exit`); a Tender by its issuer; an Advance by the holder.
- `close(round)`: anyone, after `closes_at`; requests the key (retries unbounded).
- `KeyRequested`: ends when the key arrives (callback or `submit_key`). If no key has arrived by `closes_at + key_timeout` (default 1 h), anyone can call `cancel_no_key(round)`: the round is `Cancelled` and every escrow, bond and locked unit is refundable.
- `Revealing`: starts at `key_received_at`, lasts `reveal_window` (default 10 min in the demo, 24 h suggested in production). Openings are accepted during the window and the app opens everything automatically.
- `clear(round)`: anyone, after the window; computes `P*` and every fill in one bounded transaction (section 5.4) and sets `Settled` or `Cancelled`.
- `settle_bid(round, bid)`: anyone, idempotent; applies one bid's result (the pagination of settlement).
- Claims: each participant pulls their cash, units or refunds.

The UI shows the next available action to whoever is looking at the round ("Close round", "Finalize", "Claim"), so the people who care about the outcome advance it themselves. The contract keeps a bounded, paginated event history in state so the app needs no indexer.

## 6. Architecture

```
NEAR testnet
  engine.<root>.testnet   rose-engine (Rust 1.95.0 pinned in rust-toolchain.toml, near-sdk 5.30),
                          keyless after init, no upgrade method
    - classes, positions, NEP-245 units, liens
    - NEP-145 storage: unit holders register once (storage_deposit) and pay one row per class
      held; a sealed order attaches 0.02 NEAR (refunded at settlement net of the bytes kept for
      its outcome), a round 0.05 NEAR (kept with the round record, which stays as public history)
    - rounds, sealed bids, opening, clearing, settlement
    - cash ledger per venue (NEP-141 tUSDC on NEAR, or Base USDC held by RoseVault; one venue per round)
    - foreign custody: Chain Signatures requests, ForeignTx verification, replay protection;
      every signed action record attaches 0.02 NEAR of storage
  v1.signer-prod.testnet  MPC: sign (domains 0 and 1), CKD (domain 2), verify_foreign_transaction

Base Sepolia
  RoseVault.sol           immutable, no admin; owner of deposited Sablier streams and Base cash tokens
    - depositStream(lockup, streamId, nearAccount), payable: caller must be ownerOf(streamId)
      (an approval alone is not consent to a NEAR account); refuse a non-canonical lockup, an
      invalid NEAR account id, non-LL, cancelable, non-transferable, canceled or depleted streams;
      if withdrawable > 0, withdrawMax to the sender forwarding calculateMinFeeWei read in the
      same transaction (0 today on Base Sepolia, admin-controlled) and refund the unused value;
      refuse a stream left depleted by that withdrawal (fully vested, nothing to lock) and any
      stream below one whole token (deposited, and remaining after the vested withdrawal); pull
      the NFT (onERC721Received accepts only the pending stream id); emit StreamDeposited
      (with the token's decimals read on-chain)
    - createStreams(...): issuer path; pulls the tokens (refusing fee-on-transfer tokens: the
      vault's balance must change by exactly the amount pulled), creates the cohort's LL streams
      (non-cancelable, transferable, recipient = vault) in one transaction, withdraws any
      already vested amount to the issuer and reports it as `withdrawn`, and emits
      StreamDeposited with the NEAR account of each holder
    - depositCash(token, amount, nearAccount, roundId): pull any ERC-20 that delivers exactly
      `amount` (fee-on-transfer and rebasing tokens refused), emit CashDeposited; the engine
      credits only tokens on its accepted list, so the immutable vault needs no list
    - attest(streamId): emit current stream state (for refreshes); reverts unless held
    - executeTransfer(Transfer, v, r, s) / executeRelease(Release, v, r, s): ERC-20 transfer or
      ERC-721 release authorized by an EIP-712 signature from the MPC-derived address of the
      engine (path "vault/base"); Transfer(token, to, amount, id), Release(lockup, streamId,
      to, id); no deadline; one shared replay bitmap by id (the engine uses a single counter),
      the id is consumed before any external call and a failed execution leaves it unused;
      a release first withdraws any withdrawable balance to the vault so accrued tokens stay
      with unit holders, then transfers the NFT with transferFrom (a recipient without a
      receiver hook cannot strand a signed authorization); anyone can submit, the claimant
      pays gas. v must be exactly 27 or 28 and s must be low (InvalidSignatureV/S).
      MPC signature mapping: r = big_R.x, s (the MPC guarantees low-s), v = 27 + recovery_id
      (never derived from the big_R prefix: all four prefix/recovery_id combinations occur);
      the digest signed must be below the secp256k1 group order n.
      A stream sent to the vault with a plain transferFrom is unattributed: no units are
      minted and it can only leave through a Release authorization.
  Sablier Lockup v4       0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e (measured live 2026-11-03/04),
                          source tag lockup@v4.0.1 (no lockup/src change from v4.0.0), deployed at
                          block 38,985,887; comptroller 0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399;
                          the Lockup withdrawal fee is admin-controlled, oracle-based and 0 today
  tUSDC                   rose test USDC (6 decimals, public capped mint, clearly labeled "Test USDC");
                          Circle's Base Sepolia USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e) is
                          also accepted when a user has it, but the demo never depends on a
                          captcha-gated faucet

Solana devnet
  Streamflow              HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ
  vault                   MPC-derived Ed25519 address of the engine (path "vault/sol")
  gas payer               MPC-derived Ed25519 address (path "gas/sol"), funded with devnet SOL,
                          fee payer of every engine-built transaction so anyone can broadcast it
  payout nonces           one durable nonce account per pending payout, authority = vault, proven
                          with a ForeignTx AccountState before signing, so a payout that is never
                          broadcast only blocks itself
  deposit move            caller-supplied recent blockhash (nothing is debited, so an expired
                          blockhash only means a retry), see 7.2
  per-holder deposit addresses (path "dep/<near_account>/<class>") for attribution

Web (Vercel)              Next.js app: landing, app, docs, status; reads chains directly
  /api/faucet             demo convenience only: sends a little Base Sepolia ETH for gas and a
                          little Solana devnet SOL from server-side testnet hot wallets (keys in
                          Vercel env, never in git); the devnet RPC faucet is closed (HTTP 410),
                          so no airdrop is requested; rate-limited; not part of the protocol
```

No database, no indexer, no keeper, no relayer in the protocol. The app reads contract views (including the bounded on-chain event history) and public RPCs (NEAR: FastNEAR RPC). Explorer links: NEAR `https://testnet.near.rocks/tx/<hash>` (primary; NearBlocks testnet is frozen at block 270,420,307 and `explorer.testnet.near.org` is only a selector page) with `https://nearvalidate.org/txns/<hash>?network=testnet` as the fallback, Base `https://sepolia.basescan.org/tx/<hash>`, Solana `https://explorer.solana.com/tx/<sig>?cluster=devnet`. The only off-chain component is the demo faucet route.

## 7. Cross-chain flows

### 7.1 Deposit a Sablier position (Base Sepolia)

1. Holder connects an EVM wallet (or the in-app demo wallet), the app lists their Sablier v4 streams and flags each as eligible (transferable, non-cancelable or renounced, not canceled, not depleted, at least one whole token left to lock, token and schedule matching an existing class or creatable as a new class).
2. Holder approves RoseVault for the stream NFT, then calls `depositStream` (payable: `calculateMinFeeWei(streamId)` plus a margin, the unused part is refunded). RoseVault withdraws any vested balance to the holder, takes the NFT, and emits `StreamDeposited(sender, nearAccount, lockup, streamId, token, decimals, deposited, withdrawn, start, cliff, end, granularity, startUnlock, cliffUnlock, cancelable, transferable, timestamp)` (`sender` and `streamId` indexed; `decimals` read on-chain with `IERC20Metadata.decimals()` because the engine needs it for the class key and the margin and must not trust the caller; `withdrawn` includes the amount this deposit just withdrew; `cancelable` is always false and `transferable` always true because the vault refuses anything else, and both are emitted so the engine checks them). `StreamAttested` carries the same `decimals` field after `token`. The issuer path (`createStreams`) emits the same event per stream.
3. The app waits until Base's `safe` head has passed the receipt's block (observed about 3 min after mining, head jumps every 3 to 4 min) plus about 30 s of margin because the MPC nodes' own providers can lag the public RPC, then calls `engine.register_base_deposit(tx_hash, block_hash, block_number, transaction_index, log_index, values)`. The engine requests `verify_foreign_transaction` (domain 3, Base, `Log` extractor, finality `Safe`, exactly 15 Tgas attached (the live floor) plus 1 yocto, a fixed 15 Tgas callback; the whole call fits in 50 Tgas) **without** `expected_payload_hash`: measured, a mismatch with that field is silent and times out after 200 blocks (about 2 min), whereas without it the nodes sign the true values in about 7 s and the engine detects the mismatch itself. In the callback the engine recomputes `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))` from the caller-supplied `EvmLog { removed = false, log_index, transaction_index, transaction_hash, block_hash, block_number, address, data, topics }` (`log_index` is the receipt's block-level `logIndex`, not the position within the transaction; `data` is the RPC string, `0x` plus lowercase hex) and compares it with the response's `payload_hash`; then it checks emitter = RoseVault, lockup = canonical Sablier, non-cancelable, transferable, schedule = class schedule (built from the attested `decimals`, never from a caller-supplied value), and mints `D = deposited` units (the full allocation of the stream) to `nearAccount` with checkpoint `f(timestamp)`. `D` is the full allocation and not `deposited - withdrawn`: the already-vested part was withdrawn to the holder before the deposit, and the checkpoint at `f(timestamp)` is what excludes it from accrual. With 100 deposited and 40 already vested, `D = 100` units at checkpoint 0.4 accrue the 60 tokens the stream will pay into the vault; `D = 60` would accrue only 36 and orphan 24. Replay key `(chain, tx_hash, log_index)`: marked pending when the request goes out, cleared on `PromiseError` or mismatch, consumed only on a match. Every MPC-side failure (wrong values, unknown transaction, wrong log index, finality not reached) surfaces as one `PromiseError` after about 2 min, so the UI shows "verification timed out, retry" with those causes; retries are user-initiated. Measured round trip on success: 6 to 9 s, 8 to 13 NEAR blocks.

### 7.2 Deposit a Streamflow position (Solana devnet)

The deposit is three engine calls: attribute, move, register. A deposit address exists per `(holder, class)` so that the engine can prove whose deposit a stream is; the proof is taken before anything is recorded, because a request-only move record could be front-run (the engine would sign a useless move for an attacker, and `transfer_recipient` leaves no trace of the previous recipient, so a later registration could not tell whose deposit address the stream came from).

1. The app computes the class id (`compute_sol_class_id(mint, decimals, schedule)`, a pure view: the class need not exist yet, the first deposit of a class creates it at registration) and derives `dep/<near_account>/<class>` (Ed25519 via `derived_public_key`); the holder calls `transfer_recipient` to it from Phantom (or the demo wallet).
2. `engine.attribute_sol_deposit(stream, class_id, return_to, anchor_tx, metadata_data, mint_data)` (about 80 Tgas): the engine derives the deposit address itself (`derived_public_key` of `dep/<caller>/<class_id>`), requires `recipient == deposit address` and proves the stream metadata and its mint account with one ForeignTx `AccountState` request at `Finalized` (two extractors, owners Streamflow program and SPL Token program; Token-2022 mints are refused). An eligible stream (flags below, class not fully unlocked) is recorded as attributed to the caller with the class recomputed from the attested metadata; an ineligible one is recorded as refused at the deposit address and returnable to `return_to` (`return_refused_deposit`, signed by the deposit key). Cost: one ForeignTx round trip (about 7 s).
3. `engine.move_sol_deposit(stream, recent_blockhash)` (0.02 NEAR, about 50 Tgas): the engine builds and signs the message itself: `create_associated_token_account_idempotent(payer = gas/sol, ATA(vault, mint))` then Streamflow `transfer_recipient` from the deposit address to the vault (the program would otherwise charge the ATA rent to the deposit address, which holds no SOL), fee payer = `gas/sol`, two joined `sign` promises (`dep/...` and `gas/sol`, about 38 Tgas burnt). The caller supplies a recent blockhash rather than a durable nonce: nothing is debited by this call, so a wrong or expired blockhash only means a retry (callable again while the stream is not registered), and it avoids one nonce account per deposit (MPC `sign` median 4.9 s fits the blockhash lifetime). Anyone broadcasts. If the stream is not at the deposit address the transaction simply fails on chain.
4. `engine.register_sol_deposit(stream, anchor_tx, account_data)` (the holder's registration deposit, about 50 Tgas): one ForeignTx `AccountState` proof (domain 3, finality `Finalized`, 15 Tgas plus 1 yocto, no `expected_payload_hash`) on the Streamflow metadata account (1,104 bytes, little-endian, no discriminator; offsets verified on a stream created with distinctive values: `canceled_at` 25, `recipient` 113, `mint` 177, `start_time` 409, `net_amount_deposited` 417, `period` 425, `amount_per_period` 433, `cliff` 441, `cliff_amount` 449, `cancelable_by_sender` 457, `automatic_withdrawal` 459, `transferable_by_sender` 460, `transferable_by_recipient` 461, `can_topup` 462, `pausable` 539, `can_update_rate` 540, `closed` 671) shows owner = Streamflow program, recipient = vault, mint = the attributed mint, schedule = class, `transferable_by_recipient` 1 (the vault must be able to release or return the stream), and `closed`, `canceled_at`, `cancelable_by_sender`, `transferable_by_sender`, `automatic_withdrawal`, `pausable`, `can_update_rate`, `can_topup` and the pause and rate-change history all 0 (top-ups would change the deposit and end after registration; automatic withdrawals would move unlocked tokens outside the engine's accounting, see 7.3). `AccountState` signs the account's current state as the nodes read it (slot >= the anchor transaction's slot), not the state as of the transaction, so the app reads `getAccountInfo` at `finalized` right before the call and passes those exact bytes; the anchor is the `move_sol_deposit` transaction (or any successful finalized transaction not newer than the read). If the stream changed in flight the recomputed hash differs and the call fails in about 7 s; the app retries with fresh bytes. Units are minted to the attributed account: `net_amount_deposited` units when the attested `amount_withdrawn / net_amount_deposited` is below `f(now)` (checkpoint = that withdrawn fraction, so what unlocked between the holder's last withdrawal and the registration accrues to the depositor), otherwise the largest unit count whose lifetime claim fits `net_amount_deposited - amount_withdrawn`; the attested `amount_withdrawn` seeds the engine's per-stream withdrawal accounting. Replay key: the stream metadata pubkey (one registration per stream). A stream refused here is returnable from the vault.

### 7.3 Unlocked tokens and payouts

- Base: anyone calls Sablier `withdrawMax(streamId, RoseVault)` (allowed because `to == recipient`); the app does it inside the claim flow. A unit holder's claim: the engine accrues and debits the claimable balance, asks the MPC to sign an EIP-712 `Transfer(token, to, amount, id)` for RoseVault (domain 0, path `vault/base`; measured 12.7 Tgas burnt, 21 Tgas prepaid minimum, median 4.9 s), stores `(v, r, s)` in its callback; the claimant's browser submits `executeTransfer` (or `executeRelease` for an in-kind redeem) and pays the gas. The authorization is stored on NEAR and can be re-submitted at any time; RoseVault's bitmap prevents double use. If a request is still unanswered 600 blocks later (its callback starved or the MPC timed out without an error reaching the engine), anyone calls `retry_base_signature(payout_id)`: the same digest and id are signed again and nothing is debited; whichever callback arrives first completes or refunds the payout, and any later callback changes nothing.
- Solana: the engine builds the message itself (never signs bytes supplied by a caller): `AdvanceNonceAccount` on the payout's own durable nonce account (created by the claimant, 80 bytes, authority = vault, rent read live with `getMinimumBalanceForRentExemption(80)`, 1,056,640 lamports today), then one Streamflow `withdraw(amount)` per stream of the class the payout draws on, then `create_associated_token_account_idempotent` paid by `gas/sol` for the recipient's token account, then SPL `transfer_checked` of the claimed amount from the vault's token account, fee payer = `gas/sol`. The withdrawals are chosen by the engine from its own per-stream accounting (`engine_withdrawn`, seeded with the attested `amount_withdrawn` at registration and increased by every withdrawal it signs; exact because automatic withdrawal is refused at deposit and only the engine signs for the vault): a payout of `claim` tokens takes first from the vault's tracked pool (what earlier in-kind redeems withdrew, see below), then from streams with `unlocked(now) - engine_withdrawn > 0`, so the vault's token account receives in the same transaction exactly what it pays out and a signed payout can never fail on chain for lack of balance. The number of withdrawals is capped by the 1,232-byte packet: when the streams that fit cannot cover `claim`, the call fails naming the amount one payout can carry and the holder claims the rest in another payout. There is no separate withdraw action: nothing moves out of a stream's escrow except inside a payout or a release. Before signing, the nonce account is proven with a ForeignTx `AccountState` (owner System, initialized, authority at bytes 8..40 = vault, nonce value at 40..72), because a wrong nonce value after the debit would strand the payout. The two signatures (`vault/sol`, `gas/sol`) are requested as joined `sign` promises on domain 1 (38 Tgas prepaid measured). One signed transaction per payout nonce, stored on NEAR so anyone can broadcast it (wire format `[2] || sig(gas) || sig(vault) || message`). A durable-nonce transaction does not expire (measured: landed 534 slots, 127 s, after the nonce value was read) and its fee payer is the engine's own `gas/sol` address, so the stored transaction can be broadcast by anyone at any time and is never re-signed; a payout that nobody broadcasts blocks nothing else (the ledger then runs ahead of the chain by that transaction until someone broadcasts it: the one case the accounting does not cover). Message serialization follows web3.js `TransactionMessage.compileToLegacyMessage()` byte for byte; classic SPL Token mints only (Token-2022 transfer hooks are not modeled).
- Async safety: debit before every `sign` promise; each `sign` gets 15 Tgas (the live floor; the MPC README's 10 Tgas is stale) and the callback a fixed 5 Tgas; refund in the callback only on `PromiseError` (no signature produced). If the MPC responded, the signature is public and valid, so the callback never refunds; for a joined pair, never refund once the vault signature exists: if only the fee-payer signature failed, keep the vault signature and re-request `gas/sol` over the same stored message. EVM digests are checked to be below the secp256k1 group order n before the request (the MPC rejects payloads >= n, not >= p as its README says).
- Cash: on NEAR, `ft_transfer` (pull) of rose tUSDC (NEP-141, `tusdc.rose-app.testnet`; Circle's NEAR testnet USDC exists but is only minted through a captcha-gated faucet, so it is not used). On Base, the same RoseVault authorization flow for the round's cash token.
- Position exit in kind: `redeem(position_id, to, nonce?)` burns `D_p` class units (the position's allocation) from the caller's free units (its accrued claimable stays with it) and authorizes the release of that position: on Base the ERC-721 release (with the withdraw-first rule above); on Solana a durable-nonce transaction that first withdraws the stream's unlocked, not yet withdrawn tokens (`unlocked(now) - engine_withdrawn`, which belong to the other unit holders) into the vault's token account and then `transfer_recipient`s the stream from the vault to `to`. Once that transaction is signed the withdrawn amount joins the vault's tracked pool, which later payouts of the class spend before any withdrawal; the stream itself is no longer drawn on, and a stream whose release is in flight is not drawn on either. Liens and units locked in rounds cannot be redeemed, and one release per position at a time; a Solana redeem also waits until no payout withdrawing from that stream is awaiting its signature (otherwise a payout that then fails would hand back withdraw accounting on a stream that has left the vault).

### 7.4 Trust model (README must state it plainly)

- NEAR MPC network: threshold signing and CKD in TEEs; collusion of a threshold of nodes breaks custody and sealing. Foreign state is trusted to the MPC nodes' RPC quorum.
- rose-engine: keyless after init (verifiable: `view_access_key_list` returns `[]`), no upgrade or migrate method, no delete-account path, no generic call/execute method, CKD request only after the deadline. New versions deploy to new accounts.
- Gas: every user-facing method stays under 300 Tgas (wallet cap); the 1 PGas protocol limit is used only by scripts and the in-app demo wallet.
- RoseVault: immutable, no owner, no pause, no upgrade, no `receive`; lockup and signer fixed in the constructor. A stream sent to it with a plain `transferFrom` (bypassing `depositStream`) is unattributed and can only leave through a Release authorization; the docs say so.
- No other party can move funds, see bids early or stop a round.

## 8. Frontend

### 8.1 Visual direction

Dark, ember accent, dithered voxel aesthetic ("dither / cubism, Minecraft-like"). Palette: near-black background, warm greys, ember orange and rose red accents; ordered (Bayer) dithering for gradients, glows and illustrations; voxel iconography. Typography: a pixel or bitmap display face for headings (open license, e.g. Departure Mono or Pixelify Sans, pick after testing legibility), a clean sans for body, a mono face for numbers. The app itself is clean and data-dense (reference quality: Hyperliquid, Linear, Nasdaq Private Market); the dither and voxel language is used for accents, empty states, illustrations and loading states, never at the cost of legibility. Target viewport: 1470 px wide MacBook; fully responsive down to 375 px.

### 8.2 Landing (scroll-driven, three.js + post-processing dither)

A pinned scroll sequence (~400 vh), rendered in WebGL with a final ordered-dither pass; the phrase is rendered in the scene so it receives the same lighting and dithering (accessible DOM copy for screen readers and SEO).

1. Black screen. The phrase "What was locked, rose." sits in deep shadow, barely legible. Only the letters of "rose" smolder like embers.
2. Scrolling, a voxel dragon slowly emerges behind the phrase, eyes first.
3. The dragon breathes fire in pulses driven by scroll. The fire washes over the phrase; each letter lights up as the flame reaches it, and "rose" glows brighter and brighter.
4. The phrase grows and leaves through the top of the screen.
5. The dragon falls back asleep: only smoke drifting from its mouth and the tip of its tail still glowing.
6. Hovering the dragon or the glowing tail reveals a "Launch app" button (also reachable by keyboard focus, always visible on touch devices, and in the top navigation).
7. Below the sequence: a short "How rose works" strip (Tender, Exit, Advance in one line each), live protocol stats read from the contract, and a footer with Docs, GitHub, Contracts, Status.

Requirements: 60 fps on an M-series MacBook, adaptive quality on weaker GPUs, `prefers-reduced-motion` shows a static final frame with the button, the voxel dragon is authored by us (procedural or hand-authored voxel data, no third-party model licensing issue), total landing payload kept small and lazy-loaded.

### 8.3 App information architecture (every element functional, no placeholder)

Global: top bar (logo, Rounds, Portfolio, Issuer, Prices, Docs, network badge "Testnet", connected wallets NEAR / EVM / Solana with balances, Connect button), testnet banner with a "Get test funds" panel, toasts with explorer links, a global activity feed, contextual "Learn more" links into the docs, first-visit guided tour (dismissable), command palette.

- **Portfolio** (`/app`): units per class with locked and claimable amounts, unlock timelines, open bids and asks, liens (as holder and as funder), claimable cash and tokens per chain with "Claim" buttons, history with explorer links.
- **Rounds** (`/app/rounds`): filterable list (type, class, status), countdowns, round cards, and a "Create Exit round" action (class, window, cash venue; `create_exit` is open to anyone).
- **Round detail** (`/app/rounds/[id]`): public parameters, status timeline with the next action button for the current user, sealed book (count of sealed bids and their public collateral, ciphertext hashes, nothing else), "Place bid" or "Place ask" form with live fee and collateral preview, my bids, and after close: key release event, opening progress, supply and demand curves animating into the clearing price, fills table, settlement and payout links on NEAR, Base and Solana. A "Verify" panel lets anyone recompute the clearing price in the browser from the opened bids.
- **Deposit** (`/app/deposit`): wizard: choose chain, list eligible streams, explain eligibility failures, approve and deposit, live proof progress (MPC verification), units minted.
- **Issuer console** (`/app/issuer`): create a class from a stream or schedule, create the cohort's streams in custody (`createStreams`, one transaction, one `StreamDeposited` per holder) and register them, distribute units (`distribute_units`, bounded batch with NEP-245 events), launch Tender (budget, max price or max discount, window), fund it (NEAR USDC or Base USDC), "Run via DAO" that builds a Sputnik DAO function-call proposal (and a Trezu custom template) for treasuries that need approval, results page with an exportable tender report (CSV and printable page).
- **Advance** (`/app/advance`): holders create an Advance (units to encumber, `K`, reserve, window); funders browse and bid.
- **Prices** (`/app/prices`): clearing price history per class, price versus remaining lock time across classes of a token, discount to an issuer-declared reference when one exists, methodology note.
- **Docs** (`/docs`): Overview, Concepts, How a sealed round works, Clearing rules with worked examples, Cross-chain custody, Trust and security model, Fees, Guides (issuer, holder, buyer), Contracts and addresses, SDK, FAQ, Glossary.
- **Status** (`/status`): engine account keyless check, contract versions, MPC latency of recent requests (from the on-chain event history timestamps), RoseVault, Solana vault and `gas/sol` balances, recent ForeignTx verifications.

Every async action has loading, success and failure states, human-readable errors (wallet rejected, insufficient balance, MPC timeout with retry, expired blockhash with retry), and an explorer link. Empty states explain what to do next.

### 8.4 Wallets and onboarding

- NEAR: NEAR Wallet Selector (verify the current package and supported testnet wallets), plus an in-app demo wallet (ed25519 key in the browser, account created on testnet) for judges.
- EVM: injected wallets via wagmi/viem on Base Sepolia, plus an in-app demo wallet.
- Solana: wallet adapter (Phantom, Solflare) on devnet, plus an in-app demo wallet.
- "Get test funds": NEAR testnet account and NEAR, Base Sepolia gas and Solana devnet SOL via `/api/faucet` (server-side hot wallets; the Solana devnet RPC faucet is closed and the PoW faucets are drained), test USDC minted on-chain (tUSDC on Base Sepolia and on NEAR testnet, public capped mint: 10,000 tUSDC per address per rolling 24 h), and "Mint me a demo vesting position" (the on-chain `DemoStreamFaucet` creates a Sablier LL stream of the demo token to the caller on Base, one per class per 24 h, `granularity = 1`; or the app creates a Streamflow stream on Solana).
- Test ETH for the project itself comes from the Sepolia PoW faucet bridged to Base Sepolia through the official L1StandardBridge; no CDP key or captcha-gated faucet is required.

## 9. Demo scenario and seed data

- A fictional issuer and token (verify the name and ticker collide with no notable existing token), with three classes: a seed cohort on Base (Sablier), a strategic cohort on Solana (Streamflow), and a KOL cohort on Base.
- Seed script creates the token on Base Sepolia and Solana devnet, the streams, deposits for six holders, and opens: one Tender (issuer budget in USDC), one Exit round with sellers and buyers, one Advance.
- Guided demo mode in the app ("Watch a full round"): steps through a pre-seeded round with real transactions and real explorer links, for the video and for judges who do not want to set up wallets.
- The pitch replays the Monad case (sourced, fixed price vs sealed round); the product never impersonates Monad or any real project.

## 10. Quality gates

- Contracts: Rust unit tests for clearing (property tests against a brute-force reference), unlock function, accrual accounting across transfers and rounds, round state machine; integration tests in a NEAR sandbox using recorded real testnet MPC responses as fixtures; Foundry tests for RoseVault (EIP-712 signature format matching the MPC output, replay bitmap, deposit events); end-to-end scripts on real testnets for every flow.
- Web: typecheck, lint, unit tests, Playwright end-to-end over the main journeys with demo wallets, Lighthouse performance and accessibility checks, visual review of every page at 1470 px and 375 px.
- Every external fact (address, version, method name, byte offset, gas) is verified live and recorded in `docs/verification.md` with the command used.
- Reviews: independent review passes by a different model (Fable) on the spec, contracts, cross-chain flows and UI, focused on correctness, hallucinated APIs and drift from this spec.

## 11. Day-1 de-risking order

1. One real `verify_foreign_transaction` with `Log` on Base Sepolia (throwaway event contract) and one `AccountState` on a Streamflow devnet account: measure gas, latency and mismatch behavior with and without `expected_payload_hash`.
2. `sign` on domain 0 from a throwaway NEAR contract, recovered in Foundry against `derived_public_key`; `sign` on domain 1 for a durable-nonce Solana message.
3. IBE in the browser against the live domain 2 key, CKD round trip from a contract, a fully verified opening under 300 Tgas.
4. A transferable, non-cancelable LL stream on Base Sepolia deposited into a RoseVault prototype, including the zero-withdrawable path.
5. Pure-Rust clearing engine with property tests before any UI.
Then contracts, then the app, the landing in parallel once the flows are real. All five items were completed live on 2026-11-04; the measurements are in `docs/verification.md` and the facts that contradicted version 1.1 are corrected in this version.

## 12. Repository

```
contracts/engine        rose-engine (Rust)
contracts/ibe           IBE crate ported from sealwell-ibe (attributed, test vectors regenerated against the live key), wasm build for the web
contracts/tusdc         rose tUSDC NEP-141 (NEAR cash venue)
contracts/evm           RoseVault, TestUSDC, DemoToken, DemoStreamFaucet (Foundry; foundry.toml at the repo root)
packages/sdk            TypeScript client: engine bindings, chain adapters, unlock math, clearing reference
apps/web                Next.js app (landing, app, docs, status)
scripts                 deploy, seed, end-to-end
docs                    spec, architecture, security, verification, demo script
```

English only. No secrets in the repo (keys in env files outside git, `.env.example` documents them). MIT license. README written for humans and AI screeners: what it is, the problem, "do X, see Y" steps, deployed addresses, trust model, third-party code, how to run locally.

## 13. Definition of done

1. All three round types work end to end on testnet with real foreign positions: Tender and Exit on Base Sepolia positions, Exit on Solana devnet positions, Advance on a Base position; every payout path (NEAR USDC, Base USDC, Base tokens, Solana tokens, in-kind redeem) executed at least once, with explorer links recorded.
2. Sealed bids encrypted in the browser, key released by the MPC only after close, fully verified openings, a malformed bid shown to be unopenable and slashed, `cancel_no_key` path tested, on-chain clearing matching the reference implementation.
3. Engine deployed keyless, RoseVault immutable, addresses in README and `/status`.
4. The landing sequence matches section 8.2; every app page in section 8.3 is functional; no dead button, no placeholder, no console error.
5. All quality gates in section 10 pass; `docs/verification.md` complete.
6. README, docs, demo script and seeded demo ready; app deployed on a Vercel subdomain.
