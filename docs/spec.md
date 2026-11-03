# rose: product and technical specification

Version 1.1, 2026-11-04 (after independent review). This document is the source of truth for what rose is and what "done" means. Every claim about an external system (address, version, gas figure, API) must be re-verified live before it is relied on in code; figures marked "measured" come from testnet reads on 2026-11-03.

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

Most real team vestings are not transferable, so the primary onboarding path is the issuer path: the issuer creates the cohort's streams directly to RoseVault (or moves its own transferable streams in) and distributes units to holders with a batch NEP-245 transfer. Holder self-deposit of an existing transferable position is the second path.

## 3. Why blockchain, why NEAR (only load-bearing reasons)

1. **Delivery versus payment across chains without an escrow agent.** A seller is paid only if the position actually changes hands, and the position lives on Base or Solana. rose's NEAR contract controls a vault on each chain through Chain Signatures and proves foreign state through the MPC network's foreign transaction verification. On EVM-only stacks this needs a custodian or a bridge.
2. **Bids nobody can read early, including the operator.** Bids are encrypted to an identity whose key the NEAR MPC network releases (Confidential Key Derivation, domain 2) only when the round contract asks for it, and the contract can only ask after the deadline.
3. **A public, verifiable result.** Clearing price, allocations and fills are computed on-chain from opened bids. An issuer buying from its own insiders can show its community exactly what happened.
4. **One ledger for positions on several chains.** Units of a position class are NEP-245 multi-tokens on NEAR, transferable and composable, while the underlying stream never moves.

Where blockchain adds nothing, and we do not pretend otherwise: finding buyers (a cold-start problem), and the clearing algorithm itself (it runs fine off-chain in TradFi).

## 4. Product concepts

- **Class**: a set of positions that are economically identical: same chain, same protocol, same token, same normalized unlock schedule, non-cancelable. Usually one cohort of one sale (same start, cliff, end). Positions in a class are fungible, which is what allows N sellers against M buyers at one price.
- **Position**: one locked allocation on a foreign chain, held by rose's vault. Supported in v1: Sablier Lockup v4 streams on Base Sepolia (ERC-721, Lockup Linear model only, must be created `transferable = true`, non-cancelable or renounced, not depleted; Dynamic, Tranched and Price-Gated streams are refused) and Streamflow streams on Solana devnet (`transfer_recipient` allowed for the recipient). Cancelable positions are rejected.
- **Unit**: one allocation unit of a class, i.e. a claim on one token of the class schedule. A holder who deposits a position with allocation `D` receives `D` units. Units are NEP-245 tokens, token id = class id.
- **Unlock function**: each class has a deterministic `f(t)` in [0, 1], the fraction of the allocation unlocked at time `t` (piecewise linear, from the attested schedule: start, cliff, cliff unlock amount, start unlock amount, end), stored as fixed point with 1e18 precision, rounded down. A unit's accrued entitlement between two times is `f(t2) - f(t1)` tokens. Locked tokens per unit at time `t` = `1 - f(t)`.
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
- The key request (`request_app_private_key` on `v1.signer-prod.testnet`, `AppPublicKeyPV` variant with a public scalar, >= 15 Tgas, 1 yocto) exists in exactly one function, callable by anyone, guarded by `require!(now >= round.closes_at)`. Retries are unbounded (the key is deterministic). `submit_key(sk)` is open to anyone and verified with `bls12381_pairing_check`, so a lost callback can never freeze a round.
- Measured on testnet (Sealwell): CKD end to end 4.3 to 6.1 s, ~35 Tgas including the callback.

### 5.2 Opening (fully verified, no keeper, no challenge game)

1. Once the key is public, anyone can open any bid by submitting `(plaintext, sigma)`. The contract fully verifies the opening: it recomputes `V` from the public key with one pairing in wasm and checks `U`, `V` and `W` (Sealwell measured 119.8 Tgas, 124 Tgas per receipt), so each opening fits one transaction under the 300 Tgas wallet cap. A ciphertext with an inconsistent `V` can therefore be opened by nobody, its author included: there is no free option to reveal or withhold after seeing the book, and no challenge window.
2. The key being public, every participant's browser can decrypt every bid locally; the app opens all remaining bids in sequence for whoever clicks "Finalize" (each opening is a separate transaction; the opener pays ~0.012 NEAR of gas per bid).
3. After the reveal window, bids that nobody opened (malformed) are void and their bond is slashed. An opened bid is also void (and slashed) if a buyer's `limit * quantity` exceeds its escrow or a seller's quantity exceeds its locked units.
4. Known property (ePrint 2025/2048): anything encrypted to a round identity, including ciphertexts that were never included, is readable after close. Documented in the security model.

### 5.3 Collateral and what stays hidden

- Buyers escrow a public budget (cash) at bid time; the sealed bid holds their limit price and quantity. Sellers lock units into the round at ask time (publicly, because positions are public anyway); the sealed ask holds their minimum price and the quantity they actually sell (<= locked).
- Hidden until close: every price and every exact quantity. Public: number of bids, each bid's escrow or locked amount.
- Each bid posts a bond in the round's cash token, refunded on a valid opening: max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's public max price).

### 5.4 Clearing (computed on-chain, paginated)

Prices are quoted per locked token at the round's settlement time `ts = closes_at`; the contract converts to per-unit using `1 - f(ts)`. Ties are resolved deterministically; ticks of 1e-6 USDC.

- **Tender**: candidate prices are the submitted asks `<= max_price`. Supply `S(P)` = sum of quantities with ask `<= P`. Volume bought at `P` is `Q(P) = min(S(P), floor(budget / P))`. `P*` = argmax of `Q` over candidates, ties to the lowest `P`. Asks are filled in ascending order of price; the marginal price level is filled pro rata; every filled seller receives `P*`; the unspent budget is refunded. Example: asks 100 @ 9 and 10 @ 10, budget 950: `Q(9) = 100`, `Q(10) = 95`, so `P* = 9`, 100 units bought for 900, 50 refunded. Property-tested against a brute-force reference.
- **Exit**: demand `D(P)` = sum of bid quantities with limit `>= P`, supply `S(P)` as above, volume `V(P) = min(D, S)`. `P*` maximizes `V`; ties broken by minimal `|D - S|`, then by the midpoint of the tie interval rounded down to a tick. Strictly better limits fill fully; the long side is rationed pro rata at `P*`. Unfilled buyer escrow is refundable.
- **Advance**: the holder's sealed reserve price is one ask for the `K`-token claim; funders' bids are per claimed token. Uniform price, pro rata at the margin, partial fill allowed down to a holder-chosen minimum.
- Settlement: units and cash move inside the NEAR ledger; payouts to foreign chains are pull-based (section 7). A round with no crossing is `Cancelled` and everything unlocks.
- Cash venue: each round declares exactly one cash venue at creation (NEAR tUSDC, or Base USDC held by RoseVault). All escrows, bonds, fees and seller proceeds of that round live in that venue and are claimable only there. The bid form shows the venue.

### 5.5 Fees

30 bps of settled notional, charged to the buying side on top of the price (the issuer in a Tender: escrow = budget + 30 bps), shown before every bid and in every receipt. This undercuts OTC desk spreads by an order of magnitude. Fee recipient is fixed at init. Slashed bonds go to the same treasury.

### 5.6 Round lifecycle (every transition is a public method; there is no keeper)

`Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled`

- `Open`: bids and asks accepted until `closes_at` (block timestamp). A round can be cancelled by its creator only before its first bid; never after `closes_at`.
- `close(round)`: anyone, after `closes_at`; requests the key (retries unbounded).
- `KeyRequested`: ends when the key arrives (callback or `submit_key`). If no key has arrived by `closes_at + key_timeout` (default 1 h), anyone can call `cancel_no_key(round)`: the round is `Cancelled` and every escrow, bond and locked unit is refundable.
- `Revealing`: starts at `key_received_at`, lasts `reveal_window` (default 10 min in the demo, 24 h suggested in production). Openings are accepted during the window and the app opens everything automatically.
- `clear(round, page)`: anyone, after the window; computes `P*` and fills in pages.
- Claims: each participant pulls their cash, units or refunds.

The UI shows the next available action to whoever is looking at the round ("Close round", "Finalize", "Claim"), so the people who care about the outcome advance it themselves. The contract keeps a bounded, paginated event history in state so the app needs no indexer.

## 6. Architecture

```
NEAR testnet
  engine.<root>.testnet   rose-engine (Rust, near-sdk 5.x), keyless after init, no upgrade method
    - classes, positions, NEP-245 units, liens
    - rounds, sealed bids, opening, clearing, settlement
    - cash ledger per venue (NEP-141 tUSDC on NEAR, or Base USDC held by RoseVault; one venue per round)
    - foreign custody: Chain Signatures requests, ForeignTx verification, replay protection
  v1.signer-prod.testnet  MPC: sign (domains 0 and 1), CKD (domain 2), verify_foreign_transaction

Base Sepolia
  RoseVault.sol           immutable, no admin; owner of deposited Sablier streams and Base USDC
    - depositStream(lockup, streamId, nearAccount): if withdrawable > 0, withdrawMax to sender
      (forwarding calculateMinFeeWei); refuse non-LL, cancelable, non-transferable or depleted
      streams; pull NFT (onERC721Received); emit snapshot
    - depositCash(amount, nearAccount, roundId): pull USDC, emit event
    - attest(streamId): emit current stream state (for refreshes)
    - execute(authorization, signature): ERC-20 transfer or ERC-721 release authorized by an
      EIP-712 signature from the MPC-derived address of the engine (path "vault/base");
      separate typed structs for ERC-20 (amount) and ERC-721 (tokenId); no deadline; replay
      bitmap by id; an ERC-721 release first withdraws any withdrawable balance to the vault so
      accrued tokens stay with unit holders; anyone can submit, the claimant pays gas.
      MPC signature mapping: v = 27 + recovery_id, r = big_R.x, s (low-s)
  Sablier Lockup v4       0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e (measured live 2026-11-03)
  tUSDC                   rose test USDC (6 decimals, public capped mint, clearly labeled "Test USDC");
                          Circle's Base Sepolia USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e) is
                          also accepted when a user has it, but the demo never depends on a
                          captcha-gated faucet

Solana devnet
  Streamflow              HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ
  vault                   MPC-derived Ed25519 address of the engine (path "vault/sol")
  gas payer               MPC-derived Ed25519 address (path "gas/sol"), funded with devnet SOL,
                          fee payer of every engine-built transaction so anyone can broadcast it
  payout nonces           one durable nonce account per pending payout, authority = vault, so a
                          payout that is never broadcast only blocks itself
  per-holder deposit addresses (path "dep/<near_account>/<class>") for attribution

Web (Vercel)              Next.js app: landing, app, docs, status; reads chains directly
  /api/faucet             demo convenience only: sends a little Base Sepolia ETH for gas from a
                          server-side testnet hot wallet (key in Vercel env, never in git) and
                          requests a Solana devnet airdrop; rate-limited; not part of the protocol
```

No database, no indexer, no keeper, no relayer in the protocol. The app reads contract views (including the bounded on-chain event history) and public RPCs (NEAR: FastNEAR RPC; NearBlocks testnet is frozen, use a live explorer, verify which). The only off-chain component is the demo faucet route.

## 7. Cross-chain flows

### 7.1 Deposit a Sablier position (Base Sepolia)

1. Holder connects an EVM wallet (or the in-app demo wallet), the app lists their Sablier v4 streams and flags each as eligible (transferable, non-cancelable or renounced, token and schedule matching an existing class or creatable as a new class).
2. Holder approves RoseVault for the stream NFT, then calls `depositStream`. RoseVault withdraws any vested balance to the holder, takes the NFT, and emits `StreamDeposited(sender, nearAccount, lockup, streamId, token, deposited, withdrawn, start, cliff, end, unlockAmounts, cancelable, transferable, timestamp)`.
3. The holder (app) calls `engine.register_base_deposit(tx_hash, log_index, values)`. The engine requests `verify_foreign_transaction` (Base, `Log` extractor, finality per measurement, with `expected_payload_hash` so a mismatch fails fast instead of timing out), recomputes the payload hash from the provided values, checks emitter = RoseVault, lockup = canonical Sablier, non-cancelable, schedule = class schedule, and mints `D` units to `nearAccount` with checkpoint `f(timestamp)`. Replay key: `(chain, tx_hash, log_index)`.

### 7.2 Deposit a Streamflow position (Solana devnet)

1. The app derives `dep/<near_account>/<class>` (Ed25519 via `derived_public_key`), the holder calls `transfer_recipient` to it from Phantom (or the demo wallet).
2. `engine.move_sol_deposit(stream)`: the engine builds and signs `transfer_recipient` from the deposit address to the vault (fee payer = `gas/sol`; anyone broadcasts). If the stream is not at the deposit address the transaction simply fails on chain. Attribution comes from the engine's own signed request.
3. `engine.register_sol_deposit(stream, account_data)`: one ForeignTx `AccountState` proof on the Streamflow metadata account (1,104 bytes; recipient at offset 113 and mint at 177 confirmed against `layout.ts`, `closed` offset to verify) shows recipient = vault, schedule = class, not closed, not cancelable by the sender. Units are minted to the depositor. Replay key: the stream metadata pubkey (one registration per stream).

### 7.3 Unlocked tokens and payouts

- Base: anyone calls Sablier `withdrawMax(streamId, RoseVault)` (allowed because `to == recipient`); the app does it inside the claim flow. A unit holder's claim: the engine accrues and debits the claimable balance, asks the MPC to sign an EIP-712 `Transfer(token, to, amount, id)` for RoseVault, stores the signature in its callback; the claimant's browser submits `execute` and pays the gas. The authorization is stored on NEAR and can be re-submitted at any time; RoseVault's bitmap prevents double use.
- Solana: the engine builds the message itself (never signs bytes supplied by a caller): `AdvanceNonceAccount` on the payout's own durable nonce account (created by the claimant, authority = vault), then Streamflow `withdraw` and/or SPL `transfer` from the vault, fee payer = `gas/sol`. One signed transaction per payout nonce, stored on NEAR so anyone can broadcast it. A durable-nonce transaction does not expire and its fee payer is the engine's own `gas/sol` address, so the stored transaction can be broadcast by anyone at any time and is never re-signed; a payout that nobody broadcasts blocks nothing else.
- Async safety: debit before every `sign` promise; refund in the callback only on `PromiseError` (no signature produced). If the MPC responded, the signature is public and valid, so the callback never refunds; callbacks are small with fixed gas.
- Cash: on NEAR, `ft_transfer` (pull) of the cash token (Circle testnet USDC on NEAR if it exists and is mintable for tests, otherwise rose tUSDC NEP-141). On Base, the same RoseVault authorization flow for USDC.
- Position exit in kind: `redeem(position_id)` burns `D_p` class units (the position's allocation) from the caller and authorizes the release of that position: on Base the ERC-721 release (with the withdraw-first rule above), on Solana `withdraw` then `transfer_recipient`. Liens and units locked in rounds cannot be redeemed.

### 7.4 Trust model (README must state it plainly)

- NEAR MPC network: threshold signing and CKD in TEEs; collusion of a threshold of nodes breaks custody and sealing. Foreign state is trusted to the MPC nodes' RPC quorum.
- rose-engine: keyless after init (verifiable: `view_access_key_list` returns `[]`), no upgrade or migrate method, no delete-account path, no generic call/execute method, CKD request only after the deadline. New versions deploy to new accounts.
- Gas: every user-facing method stays under 300 Tgas (wallet cap); the 1 PGas protocol limit is used only by scripts and the in-app demo wallet.
- RoseVault: immutable, no owner, signer fixed in the constructor.
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
- **Rounds** (`/app/rounds`): filterable list (type, class, status), countdowns, round cards.
- **Round detail** (`/app/rounds/[id]`): public parameters, status timeline with the next action button for the current user, sealed book (count of sealed bids and their public collateral, ciphertext hashes, nothing else), "Place bid" or "Place ask" form with live fee and collateral preview, my bids, and after close: key release event, opening progress, supply and demand curves animating into the clearing price, fills table, settlement and payout links on NEAR, Base and Solana. A "Verify" panel lets anyone recompute the clearing price in the browser from the opened bids.
- **Deposit** (`/app/deposit`): wizard: choose chain, list eligible streams, explain eligibility failures, approve and deposit, live proof progress (MPC verification), units minted.
- **Issuer console** (`/app/issuer`): create a class from a stream or schedule, distribute units (batch NEP-245 transfer), launch Tender (budget, max price or max discount, window), fund it (NEAR USDC or Base USDC), "Run via DAO" that builds a Sputnik DAO function-call proposal (and a Trezu custom template) for treasuries that need approval, results page with an exportable tender report (CSV and printable page).
- **Advance** (`/app/advance`): holders create an Advance (units to encumber, `K`, reserve, window); funders browse and bid.
- **Prices** (`/app/prices`): clearing price history per class, price versus remaining lock time across classes of a token, discount to an issuer-declared reference when one exists, methodology note.
- **Docs** (`/docs`): Overview, Concepts, How a sealed round works, Clearing rules with worked examples, Cross-chain custody, Trust and security model, Fees, Guides (issuer, holder, buyer), Contracts and addresses, SDK, FAQ, Glossary.
- **Status** (`/status`): engine account keyless check, contract versions, MPC latency of recent requests (from the on-chain event history timestamps), RoseVault, Solana vault and `gas/sol` balances, recent ForeignTx verifications.

Every async action has loading, success and failure states, human-readable errors (wallet rejected, insufficient balance, MPC timeout with retry, expired blockhash with retry), and an explorer link. Empty states explain what to do next.

### 8.4 Wallets and onboarding

- NEAR: NEAR Wallet Selector (verify the current package and supported testnet wallets), plus an in-app demo wallet (ed25519 key in the browser, account created on testnet) for judges.
- EVM: injected wallets via wagmi/viem on Base Sepolia, plus an in-app demo wallet.
- Solana: wallet adapter (Phantom, Solflare) on devnet, plus an in-app demo wallet.
- "Get test funds": NEAR testnet account and NEAR, Base Sepolia gas via `/api/faucet`, test USDC minted on-chain (tUSDC on Base Sepolia and on NEAR testnet, public capped mint), Solana devnet SOL, and "Mint me a demo vesting position" (an on-chain demo faucet contract creates a Sablier stream of the demo token to the caller on Base, or the app creates a Streamflow stream on Solana).
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
Then contracts, then the app, the landing in parallel once the flows are real.

## 12. Repository

```
contracts/engine        rose-engine (Rust)
contracts/ibe           IBE crate ported from sealwell-ibe (attributed, test vectors regenerated against the live key), wasm build for the web
contracts/evm           RoseVault (Foundry)
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
