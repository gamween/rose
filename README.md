<div align="center">

# 🌹 rose

**Sealed, uniform-price liquidity rounds for locked token allocations: a project buys back its insiders' locked tokens without guessing a price, holders of one allocation exit together without dumping, and nobody, not even the operator, can read a bid before the round closes.**

[![NEAR Hackathon 2026](https://img.shields.io/badge/NEAR%20HACKATHON-2026-00ec97?style=flat-square)](https://nearhackathon.com)
[![Live demo](https://img.shields.io/badge/demo-rose--rounds.vercel.app-000?style=flat-square)](https://rose-rounds.vercel.app)
[![Testnet only](https://img.shields.io/badge/network-testnet%20only-e8590c?style=flat-square)](#limits-and-roadmap)
[![Chain Signatures](https://img.shields.io/badge/NEAR-Chain%20Signatures-000?style=flat-square)](#how-it-works)
[![Confidential Key Derivation](https://img.shields.io/badge/NEAR%20MPC-Confidential%20Key%20Derivation-000?style=flat-square)](#sealed-rounds)
[![Base Sepolia](https://img.shields.io/badge/Base%20Sepolia-Sablier%20v4-0052ff?style=flat-square)](#cross-chain-custody)
[![Solana devnet](https://img.shields.io/badge/Solana%20devnet-Streamflow-9945ff?style=flat-square)](#cross-chain-custody)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

**[Open the app](https://rose-rounds.vercel.app)** · **[Demo script](./docs/demo.md)** · **[Specification](./docs/spec.md)** · **[Architecture](./docs/architecture.md)** · **[Security model](./docs/security.md)** · **[Verification log](./docs/verification.md)**

*What was locked, rose.*

</div>

rose runs sealed auctions over locked token positions. An issuer (a foundation, a treasury, a DAO)
publishes a budget and a maximum price; holders of a locked allocation submit sealed asks; one
uniform clearing price is computed on chain and every filled seller receives it. The same engine
runs **Exit** rounds (sealed asks against sealed bids from buyers) and **Advance** rounds (a holder
sells a senior claim on its first unlocks). Positions stay where they live, as Sablier streams on
Base or Streamflow streams on Solana: a NEAR contract holds them through **Chain Signatures**, proves
their state through the MPC network's **foreign transaction verification**, and settles everything
in one ledger. Bids are encrypted in the browser to a key the NEAR MPC network releases through
**Confidential Key Derivation** only after the deadline.

> Foundations already buy back locked allocations from their early investors, one investor at a
> time and at a fixed, unpublished price: Omni, LayerZero, Ethena and Monad did it in 2025 and 2026.
> A fixed price only finds the few holders whose own valuation is below it. Monad Foundation's offer,
> capped at $60 million, ended with "nearly all holders approached declined to participate"
> ([its own announcement](https://monad.xyz/blog/early-investor-liquidity-program)). Corporate
> finance solved this decades ago with the modified Dutch auction tender offer: sealed asks, one
> uniform price. No live sealed tender exists in crypto. Locked tokens meanwhile trade OTC at 20 to
> 40% discounts, bilaterally, with no public price. Sources in
> [spec section 1](./docs/spec.md#1-problem-evidence).

> Built during **NEAR HACKATHON 2026** (1 to 14 November). Testnet only: NEAR testnet, Base Sepolia,
> Solana devnet; nothing touches mainnet. **Unaudited.** Every external fact the code relies on is
> verified live and recorded with its command in [`docs/verification.md`](./docs/verification.md).

## Table of contents

- [Try it yourself](#try-it-yourself)
- [How rose fits the tracks](#how-rose-fits-the-tracks)
- [For reviewers](#for-reviewers)
- [How it works](#how-it-works)
- [Trust model](#trust-model)
- [Every claim, verified](#every-claim-verified)
- [Deployed contracts](#deployed-contracts)
- [Limits and roadmap](#limits-and-roadmap)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Third-party code and AI assistance](#third-party-code-and-ai-assistance)
- [Team](#team)
- [License](#license)

## Try it yourself

The app is deployed at **https://rose-rounds.vercel.app**. Everything runs on testnets with in-app
demo wallets, so no wallet extension and no real funds are needed. The demo issuer, **Cindral
Foundation**, and its token **Cindral (CINDR)** are fictional; their positions, rounds and payouts
are real testnet transactions ([demo script and cast](./docs/demo.md)).

1. **Watch a full round, no wallet needed.** Open `/app/demo` ("Watch a full round") and step
   through a seeded Tender. You see the sealed book (how many asks, their locked units, their
   ciphertext hashes, no price), the key released by the MPC network a few seconds after the close,
   every ask opened and verified on chain, and the clearing price, each step with its explorer link.
2. **Connect.** Click **Connect**, choose a network (NEAR first, then Base and Solana), and under
   **No wallet?** click **Create a demo wallet**. The dialog closes after each network: add the next
   one from the wallet menu (**Connect another network**). You see one header button with the
   connected networks, and its menu lists each wallet with its balance; the keys stay in this browser.
3. **Get test funds.** Open the wallet menu, then **Get test funds**: **Create the demo account
   with test NEAR**, **Mint 1,000 tUSDC on NEAR**, **Mint 1,000 tUSDC on Base**, **Mint me a demo
   vesting position** (pick **KOL cohort** to have unlocked CINDR to claim in step 8; the **Seed
   cohort** is still in its cliff), **Create a demo Streamflow position**, **Send 0.0020 ETH for gas**
   and **Send 0.050 SOL**. You see each action succeed with its explorer link and the balances
   update. The gas sends have hourly caps shared by every visitor; a capped action says when it
   reopens.
4. **Deposit a position.** Open `/app/deposit`, choose Base, pick the demo Sablier stream and
   deposit it. You see the wait for Base's `safe` head (3 to 5 minutes), then the MPC network's
   attestation of the deposit (seconds), then your units minted. Choosing Solana does the same for
   the Streamflow position in three engine calls.
5. **Open a round and sell, sealed.** On `/app/rounds`, **Create Exit round** on the class of your
   position with a short window. In the round's order card, **Deposit cash** for the seller's bond
   (a few tUSDC), then **Seal and place ask**. You see your ask in the **Sealed book** tab: its
   locked units and its ciphertext hash, never its price.
6. **Buy from a second identity.** In a private window, repeat steps 2 and 3, open the same round,
   **Deposit cash** for the escrow and **Seal and place bid**. The round now shows two sealed orders.
7. **Close, open, clear.** After the deadline the round's action card shows the next step: **Close
   round** (the key arrives within seconds), **Open every order** (your browser decrypts every order
   and opens each one on chain), then **Clear** once the reveal window (10 minutes by default) is
   over. In the **Results** tab you see the supply and demand curves meet at one price, the fills,
   and the **Verify** panel recomputing the same price in your browser.
8. **Claim.** In the **My orders** tab, **Claim** settles your order; proceeds and refunds land as
   tUSDC in your portfolio (`/app`, **Claims** tab), which withdraws them to your wallet. For the
   KOL cohort position, claim the CINDR your units unlocked on Base: you see the MPC signature on
   NEAR and the `executeTransfer` on Basescan.
9. **Check the trust claims.** Open `/status`. You see the engine's raw access-key list, the RoseVault
   signer compared with the engine's MPC-derived address, the MPC contract version and the latency
   of recent key releases.
10. **Run a Tender buyback as an issuer.** Open `/app/issuer` and follow **New Tender** to its
    **Launch Tender** step: set a budget and a maximum price and sign it yourself, or set **Signed
    by** to **A DAO** and enter a Sputnik DAO account: the **Run via DAO** panel then shows the DAO
    proposal and the Trezu template that file the same call from the treasury. After settlement the
    **Results** tab exports the tender report.

Rounds left open for reviewers: **#8** (Exit, Seed Round, closes 16 November 15:00 UTC) and **#10**
(Exit, KOL Round, closes 17 November 15:00 UTC) each hold a sealed ask at 0.002 tUSDC per locked
token, so any bid at or above it fills, and have a 10-minute reveal window; **#4** (Exit, Seed
Round, closes 20 November 16:05 UTC, 24-hour reveal window) holds Halden Ventures' sealed ask. There is no keeper: after the close, whoever is there
clicks **Close round**, then **Open every order** right away (orders still sealed when the reveal
window ends are void and their bond is slashed), then **Clear**.

## How rose fits the tracks

- **Unstoppable DeFi** (`defi`): cross-chain delivery versus payment with no custodian and no
  bridge. A seller is paid only if its position actually changes hands; the position lives on Base
  or Solana and the NEAR contract controls the vault holding it through **Chain Signatures**
  (EIP-712 authorizations on Base, durable-nonce transactions on Solana). rose does not use NEAR
  Intents: nothing is swapped, positions are moved in kind.
- **Privacy & Private AI** (`privacy`): private finance, pre-trade. Bids are encrypted to a round
  identity whose key the NEAR MPC network derives through **Confidential Key Derivation** only when
  the round contract asks, and the contract can only ask after the deadline. Releasing a key takes a
  threshold of the network's nodes, so no single node, and not rose's operator, can open the book
  early; the nodes also run in TEEs, a second layer rather than the root of trust. After the close
  every opening is verified on chain. rose does not use NEAR AI Cloud.
- **Social Money** (`social`): a treasury that needs approval runs its buyback through a **Sputnik
  DAO** function-call proposal or a **Trezu** custom template generated by the issuer console
  ("Run via DAO"), and the published tender report shows the community what was paid to whom, at
  one price. On testnet the Sputnik DAO `cindral-treasury.sputnikv2.testnet` filed the console's own
  proposals, funded the budget and created Tender buyback round 7
  ([CxcrHTMZ…](https://testnet.near.rocks/tx/CxcrHTMZkcqWdVfqLf46iYV6xhVYR1uRLc1U2ssnfHPd)), which
  cleared at 0.036 ([ESarBAbY…](https://testnet.near.rocks/tx/ESarBAbYgU7BraxenYXjTmx3rcFWFuGjZAFVqAL3mugp))
  and returned the unspent budget to the treasury through a third proposal.
- **Open Innovation** (`open`): chain abstraction in practice. One keyless NEAR contract holds
  positions that never leave Base or Solana, proves their state through the MPC network, and pays
  out on each chain, so holders on two chains trade one class of units at one price.

## For reviewers

The organizers name technical implementation, design, impact, originality and sustainability as the
criteria of previous NEAR hackathons, and AI screening checks that the project runs and does what
this README says. Where to look for each:

| Criterion | Where to check it |
|---|---|
| Runs as described | [Try it yourself](#try-it-yourself) on the deployed app; [Getting started](#getting-started) reproduces every test and the seeded story; every proof below links a testnet transaction |
| Technical implementation | A NEAR contract that holds Base and Solana positions through Chain Signatures and ForeignTx, IBE sealing against the MPC CKD key with fully verified on-chain openings, two-phase Solana payouts settled on proof of landing ([architecture](./docs/architecture.md), [security model](./docs/security.md)) |
| Design | The app (`/app`, `/app/rounds/<id>`, `/app/issuer`, `/status`, `/docs`), reviewed at 1470 px and 375 px; the landing's scroll sequence |
| Impact | The problem and its evidence in [spec section 1](./docs/spec.md#1-problem-evidence); users and jobs in [spec section 2](./docs/spec.md#2-users-and-jobs) |
| Originality | No live sealed tender for locked tokens exists in crypto ([spec section 1](./docs/spec.md#1-problem-evidence)); [What is new here](#what-is-new-here) compares rose with the usual sealed-bid designs |
| Sustainability | [Limits and roadmap](#limits-and-roadmap); the engine has no upgrade path, its final deployment `engine-v2.rose-app.testnet` deleted every access key after init (see [Deployed contracts](#deployed-contracts)) and `@rose/sdk` reaches it without the app, so a keyless engine keeps running without its authors |

## How it works

```text
issuer / holder / buyer (browser: bids sealed with IBE against the MPC CKD key)
  └─▶ rose-engine on NEAR: classes, NEP-245 units, rounds, sealed orders, clearing, settlement
       ├─▶ NEAR MPC network (v1.signer-prod.testnet)
       │     domain 2 CKD: the round key, released only after closes_at
       │     domain 3 ForeignTx: attests Base logs and Solana accounts
       │     domains 0 and 1 sign: authorizations for the vaults
       ├─▶ Base Sepolia: RoseVault holds Sablier Lockup v4 streams and cash, pays only on an
       │     EIP-712 authorization from the engine's MPC-derived key
       └─▶ Solana devnet: an MPC-derived vault address holds Streamflow streams; the engine
             builds and signs durable-nonce transactions, anyone broadcasts them
```

### What is new here

Sealed bids and a uniform clearing price are an old idea. What rose adds is what is sold, who buys,
and who can open the bids:

| | Usual sealed-bid designs | rose |
|---|---|---|
| What is sold | Liquid tokens or a new issuance | Locked allocations: vesting streams that never leave Base or Solana; the units a buyer receives keep the exact unlock schedule |
| Who buys | Anyone | The issuer, buying back with a budget and a maximum price (Tender buyback); any buyer (Exit); or funders of a senior claim on a holder's first unlocks (Advance) |
| Who can open the bids, and when | A timelock beacon (the key appears at a fixed time whatever the contract says), a single TEE (one machine's promise), or commit-reveal (a bidder sees the others and may decline to reveal) | A threshold of the NEAR MPC network derives the round key only when the contract asks, and the contract can only ask after the deadline. Then anyone can open any order and the contract verifies each opening in full, so nobody can withhold a bid, and a malformed one is opened by nobody and its bond slashed |
| Settlement | On one chain | Delivery versus payment across NEAR, Base and Solana by one contract with no access key |

### Why NEAR

Only the reasons that carry weight ([spec section 3](./docs/spec.md#3-why-blockchain-why-near-only-load-bearing-reasons)):

1. **Delivery versus payment across chains without an escrow agent**, through Chain Signatures and
   the MPC network's foreign transaction verification.
2. **Bids nobody can read early**, through Confidential Key Derivation gated by contract state.
3. **A public, verifiable result**: clearing price, allocations and fills computed on chain from
   opened bids.
4. **One ledger for positions on several chains**: units of a position class are NEP-245 tokens on
   NEAR while the underlying stream never moves.

Where a blockchain adds nothing, and rose does not pretend otherwise: finding buyers, and the
clearing algorithm itself.

### NEAR primitives rose relies on

NEAR's [Chain Signatures page](https://docs.near.org/chain-abstraction/chain-signatures) documents
only the two signing domains. The MPC network behind it (`v1.signer-prod.testnet`) serves two more,
and rose uses all four; the [near/mpc README](https://github.com/near/mpc) names them
("Confidential Key Derivation", "Read RPC", the working name of foreign chain transaction
verification), and Near One's [CKD article](https://blog.nearone.org/research/2026/02/23/mpc-ckd.html)
gives time-lock encryption as the use it enables, which is rose's. Each row links a transaction of
the final engine that only works if the primitive does.

| Primitive (MPC domain) | Method rose calls | What rose does with it | Code | Proof on testnet |
|---|---|---|---|---|
| Chain Signatures, domain 0 (secp256k1) | `sign` | Signs the EIP-712 authorizations RoseVault executes on Base: cash payouts, token claims, in-kind releases | [`foreign/mpc.rs`](./contracts/engine/src/foreign/mpc.rs), [`custody/payouts.rs`](./contracts/engine/src/custody/payouts.rs) | `withdraw_base_cash` [9BESbgMJ…](https://testnet.near.rocks/tx/9BESbgMJ85ixAdGiY8XQ1R5rRRFX4wDimkrng9C5cWEu), then `executeTransfer` [0xb403f62a…](https://sepolia.basescan.org/tx/0xb403f62afe5728f748cdbe80a630e3aab7b7d2705eb953e81d2d878117edd432) |
| Chain Signatures, domain 1 (Ed25519) | `sign` | Signs the durable-nonce Solana transactions that move streams and pay out of the engine's derived vault | [`foreign/solana.rs`](./contracts/engine/src/foreign/solana.rs), [`custody/solana.rs`](./contracts/engine/src/custody/solana.rs) | engine-built transaction [46ZF74WS…](https://explorer.solana.com/tx/46ZF74WSUihFctEX5YYQcTEiBbfUC6dxUXpq6eHFUbf9Hd5zj6ybgd9etxFWCsNqVhy4g18yeeS2LJZHNgxRV4U6?cluster=devnet) |
| Confidential Key Derivation, domain 2 (BLS12-381) | `request_app_private_key` | Derives each round's decryption key, which the contract can only request after the deadline; browsers seal orders to it with identity-based encryption | [`sealing.rs`](./contracts/engine/src/sealing.rs), [`contracts/ibe`](./contracts/ibe) | `close` of the Tender [82iWCcCj…](https://testnet.near.rocks/tx/82iWCcCjj1Jb9CBNiR4vtsv5Si9tkQRPsB8fv47Ck377): key received 4.8 s later |
| Foreign chain transaction verification, domain 3 | `verify_foreign_transaction` | Attests Base logs (a stream or cash deposited into RoseVault) and Solana account states (a Streamflow stream, a nonce account, a landed payout) | [`foreign/`](./contracts/engine/src/foreign) | `register_base_deposit` [3B4xGvii…](https://testnet.near.rocks/tx/3B4xGviiUP7aA4KKa9GRPeMJ519S8zWi7TvHeQcZMvvi); `confirm_sol_payout` [Bv9RZpax…](https://testnet.near.rocks/tx/Bv9RZpaxVzX2G9CZqAM8LvpRZoB9QXunYFpCoJ7yji4K) |
| [NEP-245](https://github.com/near/NEPs/blob/master/neps/nep-0245.md) multi-token | engine | Units of a position class, one token id per class | [`units.rs`](./contracts/engine/src/units.rs) | units minted by the same `register_base_deposit` |
| [NEP-141](https://github.com/near/NEPs/blob/master/neps/nep-0141.md) and [NEP-145](https://github.com/near/NEPs/blob/master/neps/nep-0145.md) | `tusdc.rose-app.testnet`, engine | tUSDC, the NEAR cash venue; per-account storage paid by the account that uses it | [`contracts/tusdc`](./contracts/tusdc), [`storage.rs`](./contracts/engine/src/storage.rs) | `withdraw_near_cash` [FswYgYh7…](https://testnet.near.rocks/tx/FswYgYh7PC715bmwLNCmseUy9JA7o1g7gw5WqYjw3xfG) |
| [Sputnik DAO v2](https://github.com/near-daos/sputnik-dao-contract) and [Trezu](https://github.com/NEAR-DevHub/trezu) | `add_proposal` (built by the app) | A treasury files its Tender as a DAO proposal instead of signing it alone | [`DaoPanel.tsx`](./apps/web/src/components/issuer/DaoPanel.tsx), [`dao.ts`](./apps/web/src/components/issuer/dao.ts) | the DAO `cindral-treasury.sputnikv2.testnet` executes the `create_tender` proposal [CxcrHTMZ…](https://testnet.near.rocks/tx/CxcrHTMZkcqWdVfqLf46iYV6xhVYR1uRLc1U2ssnfHPd) and becomes round 7's creator |
| A contract account with no access key | none | The engine's keys were deleted right after init: no upgrade, no admin | [`deploy-engine.sh`](./scripts/deploy-engine.sh) | `view_access_key_list` returns `[]`, read live on `/status` (command in [`verification.md`](./docs/verification.md#final-proofs-on-3a99e6e-2026-11-06)) |

rose does not use NEAR Intents: positions move in kind and nothing is swapped, and Intents has no
testnet. Paying sale proceeds out in any asset on any chain through Intents is on the
[roadmap](#limits-and-roadmap).

### Positions, classes and units

A **class** groups positions that are economically identical (same chain, protocol, token and
normalized unlock schedule, non-cancelable). Depositing a position of `D` tokens mints `D` units of
its class, NEP-245 tokens whose id is the class id; units accrue the class's unlocked tokens through
a deterministic unlock function, an exact port of Sablier's and Streamflow's own math. Because units
of a class are fungible, N sellers can meet M buyers at one price
([spec section 4](./docs/spec.md#4-product-concepts)).

### Sealed rounds

`Scheduled → Open → KeyRequested → Revealing → Clearing → Settled | Cancelled`. Every step is a
public method; there is no keeper.

1. **Seal.** Orders are encrypted in the browser (Boneh-Franklin IBE, 192-byte ciphertexts) to the
   round's identity under the MPC CKD master key, bound to the round, the bidder and the side.
   Buyers escrow cash and sellers lock units in public; prices and exact quantities stay sealed.
2. **Close.** After the deadline anyone calls `close`; the engine requests the round key and checks
   it with a pairing check. If the key never comes, anyone calls `cancel_no_key` and everything is
   refunded.
3. **Open.** Anyone can open any order with the public key; the engine fully verifies each opening,
   so a malformed order can be opened by nobody, its author included, and its bond is slashed.
4. **Clear.** One bounded transaction computes the uniform price and the fills; each participant's
   `settle_bid` applies its result, and payouts are pulled on the chain where the value lives.

Clearing rules and worked examples: [spec section 5.4](./docs/spec.md#54-clearing-computed-on-chain-bounded).
Fees: 30 bps of settled notional, charged to the buying side.

### Cross-chain custody

| Chain | Positions | Custody | Proof of deposit | Payouts |
|---|---|---|---|---|
| Base Sepolia | Sablier Lockup v4 Linear streams, transferable and non-cancelable | RoseVault: immutable, no owner, no upgrade | ForeignTx `Log` at `Safe`, the payload hash recomputed by the engine | EIP-712 authorizations signed by the MPC, checked by `ecrecover` before they are stored, submitted by the claimant |
| Solana devnet | Fee-free Streamflow streams of classic SPL mints without a freeze authority | MPC-derived Ed25519 vault | ForeignTx `AccountState` at `Finalized`, after a proof that the stream came from the depositor's own deposit address | Durable-nonce transactions built and signed by the engine, broadcast by anyone, final only once `confirm_sol_payout` proves on the claimant's receipt nonce account that they landed |

Details: [spec section 7](./docs/spec.md#7-cross-chain-flows) and
[`docs/architecture.md`](./docs/architecture.md).

## Trust model

In short ([`docs/security.md`](./docs/security.md) has the full model, the threats per flow and the
review history; [spec section 7.4](./docs/spec.md#74-trust-model-readme-must-state-it-plainly) is the
normative version):

- **NEAR MPC network:** no single node holds a key. Signing, releasing a round key (CKD) and
  attesting foreign state each need 11 of the network's 16 nodes on testnet, and the nodes also run
  in TEEs, a second layer rather than the root of trust. A threshold of colluding nodes breaks
  custody and sealing; foreign state is trusted to the nodes' RPC quorum.
- **rose-engine:** no upgrade, migrate, delete-account or generic call method, and the CKD request
  reachable only after the deadline. The final deployment deletes every access key after init:
  `deploy-engine.sh --role final` refuses to run without `--keyless`, checks the deployed code
  hash before deleting any key, and records the engine as keyless only once
  `view_access_key_list` at `final` returns `[]`. New versions deploy to new accounts.
  The engine the app uses, `engine-v2.rose-app.testnet` in [Deployed contracts](#deployed-contracts),
  is that keyless deployment; the first final engine `engine.rose-app.testnet` is superseded by it
  and the earlier staging engines kept a key: both are history only.
- **RoseVault:** immutable, no owner, no pause, no upgrade; Sablier Lockup and the signer fixed in
  the constructor. A stream sent with a plain `transferFrom` is unattributed and can only leave
  through a Release authorization.
- **Tokens:** on Base, an ERC-20 whose issuer keeps pause or blacklist powers can freeze RoseVault's
  balance or its transfers to a claimant; rose cannot remove that trust. On Solana, mints with a
  freeze authority and Token-2022 mints are refused at deposit.
- **Third-party programs:** Sablier's withdrawal fee is admin-controlled (0 today; RoseVault
  forwards it, so withdrawals and releases keep working); Streamflow's program is upgradeable and
  its on-chain source is not public, and its auto-claim withdraws every ended stream into its
  recipient's token account one second after the end, which rose books (`sync_sol_stream`) and
  relies on for an ended stream's last tranche.
- **Gas:** every user-facing method stays under the 300 Tgas wallet cap (the highest, a verified
  opening, burns about 132 Tgas); the 1 PGas protocol limit is used only by the scripts and the
  in-app demo wallet.
- No other party can move funds, see bids early or stop a round. Not audited.

## Every claim, verified

Every row links the testnet transactions that show it; all of them, with the commands used, are in
[`docs/verification.md`](./docs/verification.md).

### The seeded story, live on the final engine `engine-v2.rose-app.testnet`

| Claim | Evidence | Result |
|---|---|---|
| The MPC network releases a round's key only after close, in seconds | `close` of the Tender [82iWCcCj…](https://testnet.near.rocks/tx/82iWCcCjj1Jb9CBNiR4vtsv5Si9tkQRPsB8fv47Ck377), the Exit [9D31fRAL…](https://testnet.near.rocks/tx/9D31fRALyropD1cFjAVZduN8cSXrgWR5PHHHfkYM819Y), the Advance [EvYijsfB…](https://testnet.near.rocks/tx/EvYijsfBSK1rsCtAG3NQeqmRv1nFADSdTBJs8dkPTR7j) | Key stored by the callback 4.8, 4.2 and 4.9 s after `close`, each equal to the offline unwrap of the MPC response |
| Openings are fully verified on chain, by anyone | `open_bid` sent by `rose-app.testnet`, which placed no order and created no round (it deployed the engine), e.g. [Eqq9Cwqy…](https://testnet.near.rocks/tx/Eqq9CwqytozdU8jv4G526aC3gNtPYTs8Sz9LhST8eJTD) | 9 openings at 132.1 Tgas, each equal to what the bidder sealed |
| A malformed bid can be opened by nobody and is slashed | its author's own opening refused [CnvMqSd2…](https://testnet.near.rocks/tx/CnvMqSd25evQwrSRmHezWhQf3mXTX6ME2TSVe1JNFYwk); settlement [93F56CBa…](https://testnet.near.rocks/tx/93F56CBaDPUZrdcuUjvccnDb9qDVKKamMyDVz7nyfFJu) | "Opening does not match the ciphertext"; 1 tUSDC bond slashed |
| On-chain clearing equals the reference implementation | `clear` of the Tender [2cvvExqG…](https://testnet.near.rocks/tx/2cvvExqGXGTMwunyC4xYN9YigCCxduytVDLNZxhetqDn), the Exit [GFhakKKW…](https://testnet.near.rocks/tx/GFhakKKWK2oZWR8xw3CiTetdZqxnhsr65aXmDDTXAAyu), the Advance [26xm8LXQ…](https://testnet.near.rocks/tx/26xm8LXQH4FAUBiMQ3hraYFgckuRzPUJ17RDKpbmRo6r) | 0.036, 0.027 and 0.0375 tUSDC with every fill equal to `@rose/sdk` run on the opened orders |
| A round without a key is cancelled and refunded | `close` refused after the timeout [EYSv5djd…](https://testnet.near.rocks/tx/EYSv5djd3wmH72cC4TRxtJmywErjZEdGbGdeFU8Akb3T), `cancel_no_key` [GuA2xPAB…](https://testnet.near.rocks/tx/GuA2xPAB5ifbzwjAqv6LbfmHzSMnqPmvrQdvLaWsWj8e), refund [7w8kTEDA…](https://testnet.near.rocks/tx/7w8kTEDApo1rDY4jPBrWHrHqLYxVepdTsBrEV2Vdx8Bn) | Escrow and bond refunded |
| A Base deposit is attested by the MPC network | `createStreams` [0xc2cf7629…](https://sepolia.basescan.org/tx/0xc2cf76299e247fabcc8f167f312203a278e43111acea652c7b5f99ece3e2fb45), `register_base_deposit` [3B4xGvii…](https://testnet.near.rocks/tx/3B4xGviiUP7aA4KKa9GRPeMJ519S8zWi7TvHeQcZMvvi) | Attested `StreamDeposited` log, units minted |
| A Solana deposit is attributed, moved by the engine and registered | `attribute_sol_deposit` [149ZdeKg…](https://testnet.near.rocks/tx/149ZdeKgSz5wofm9fNWXKZ9fW6cNKPSuMNrg8WPTnoLG), engine-signed move [4xBFUiy1…](https://explorer.solana.com/tx/4xBFUiy1ARwnU4rZnWNjfMVHHR2guLPA1FAJkfAajVmxoQJqRDURS2bH9ssJaVfCSmR6Xjh3ooGXKuFhTFkreaAU?cluster=devnet), `register_sol_deposit` [FnTRaGhi…](https://testnet.near.rocks/tx/FnTRaGhixi42tKbYjGyJ3KhPqLke6vpBc9JTJ8dmhhik) | 300,000 CINDR position registered |
| Base cash payout through RoseVault | `withdraw_base_cash` [9BESbgMJ…](https://testnet.near.rocks/tx/9BESbgMJ85ixAdGiY8XQ1R5rRRFX4wDimkrng9C5cWEu), `executeTransfer` [0xb403f62a…](https://sepolia.basescan.org/tx/0xb403f62afe5728f748cdbe80a630e3aab7b7d2705eb953e81d2d878117edd432) | 1,460 tUSDC to the seller's Base address |
| An Advance is repaid from unlocks, in tokens | `withdrawMax` [0xcbe7b057…](https://sepolia.basescan.org/tx/0xcbe7b05790f81def67601e73de7ca7abd36504441485edac85514f63877aba28), `claim_base_tokens` [7SsvHCs3…](https://testnet.near.rocks/tx/7SsvHCs3gMQrNUmaKHc9BZK65B23EW4VtNpvNsHgnwB1), `executeTransfer` [0x578ccbcd…](https://sepolia.basescan.org/tx/0x578ccbcd74ddc1d806f386562dab8bbd02f1168f19a9f320b0a040ddfa1db571) | CINDR to the funder |
| A position leaves in kind | `redeem` [3eTP42S7…](https://testnet.near.rocks/tx/3eTP42S7QcqX3yx5TSaPBAx1Hd9dahYqMzxpq4QWrz99), `executeRelease` [0x59e6facd…](https://sepolia.basescan.org/tx/0x59e6facd04330c6d15a9a11559eb2ccd76e1787976e0bee0ab79a1e88e02d2c6) | Sablier stream 161 back to its holder |
| NEAR cash payout | `withdraw_near_cash` [FswYgYh7…](https://testnet.near.rocks/tx/FswYgYh7PC715bmwLNCmseUy9JA7o1g7gw5WqYjw3xfG) | 1,732.39 tUSDC to the seller |
| A Sputnik DAO runs a Tender buyback with the issuer console's own proposals (14 November) | DAO created [F5ghEw2q…](https://testnet.near.rocks/tx/F5ghEw2qVuvTNfS3xgWUHdpnAZ1j4QvayNNtira2jzTq); funding proposal executed [7HJzxCFc…](https://testnet.near.rocks/tx/7HJzxCFc6rubKhTczsX9fFbaRPrP8WgmvQY1LXEjAP2C); `create_tender` proposal executed [CxcrHTMZ…](https://testnet.near.rocks/tx/CxcrHTMZkcqWdVfqLf46iYV6xhVYR1uRLc1U2ssnfHPd); `close` [FBb23wTh…](https://testnet.near.rocks/tx/FBb23wThJpKLhhj7GgaMhYBwxpx6YhrZPCWju3unQ18s); `clear` [ESarBAbY…](https://testnet.near.rocks/tx/ESarBAbYgU7BraxenYXjTmx3rcFWFuGjZAFVqAL3mugp) | Round 7, created by `cindral-treasury.sputnikv2.testnet`: key 4.4 s after close, cleared at 0.036 for 2,000 units, equal to the `@rose/sdk` reference |

### Solana payouts settle on proof of landing

| Claim | Evidence | Result |
|---|---|---|
| A payout is final only once the chain proves it landed | `claim_sol_tokens` [86wtZg82…](https://testnet.near.rocks/tx/86wtZg822RMxqXMPGVUFHsEB6dqfzehq34g5eVkaE76V), the engine-built transaction [46ZF74WS…](https://explorer.solana.com/tx/46ZF74WSUihFctEX5YYQcTEiBbfUC6dxUXpq6eHFUbf9Hd5zj6ybgd9etxFWCsNqVhy4g18yeeS2LJZHNgxRV4U6?cluster=devnet), `confirm_sol_payout` [Bv9RZpax…](https://testnet.near.rocks/tx/Bv9RZpaxVzX2G9CZqAM8LvpRZoB9QXunYFpCoJ7yji4K) | `AdvanceNonceAccount` + Streamflow `withdraw` + `TransferChecked`; payout `Landed` |
| An in-kind release is final only once proven | `redeem` [5erw3mkz…](https://testnet.near.rocks/tx/5erw3mkzPLi6GNoE3bNmmoD4xmg47ebpue3Hs3VRvdwq), `transfer_recipient` [4SjvN2x7…](https://explorer.solana.com/tx/4SjvN2x7MZH9yy3MCDCZiteBbDm7RiMKQVdTosUmHSu3Q7nKcB7zhuapm7MgNjE4Q2sGDooTKJRBLydeGYkSuecT?cluster=devnet), `confirm_sol_redeem` [4Vpy2Ywg…](https://testnet.near.rocks/tx/4Vpy2YwgSE6Nbr6gTzCt3HfBoFqpGQWNHtH4SsvsyXG2) | Position `Released` |
| The same flow from the app, with a demo wallet | `claim_sol_tokens` [HWFtWrxi…](https://testnet.near.rocks/tx/HWFtWrxiiVQwgGE3o4BQYX16bKcjEMrRgcugnuqE8eJ), broadcast [5mfhsBW8…](https://explorer.solana.com/tx/5mfhsBW8CeBSmtwgqgDrZU5YMxvbhseqhwNJVnkr9c95uxLVqFubBtxARbS3wMgo2NEFSPTEF9y1PjPAwtVnNKvj?cluster=devnet), `confirm_sol_payout` [F8Yg1PxD…](https://testnet.near.rocks/tx/F8Yg1PxDohv5C8vQo42MgN2YKCwxEk4NpKtTTPGDvZTW), all in one flow | Payout 9 `Landed` on its receipt, 60 s from click to confirmation |
| An ended stream's auto-claim is booked, then paid out | Streamflow's auto-claim [2j4ftDid…](https://explorer.solana.com/tx/2j4ftDidWY3NMZHm3dhdNx3rcz4tKb7PknvgtnSVd4jP8pNY4yarKHJkpeZu3X9diKt57VTguNhUYZeNGZeq244e?cluster=devnet), `sync_sol_stream` [GyDe3pdE…](https://testnet.near.rocks/tx/GyDe3pdEt6WntUJtZvgqxgEKNtXJuj8K4xVHM3en2DDN), a claim paid from the swept balance alone [3TPw2vCR…](https://testnet.near.rocks/tx/3TPw2vCRxKo4GTXDhEdP4jMpmeLfLwt9cPpG878qGCUm) + [38189Ckk…](https://explorer.solana.com/tx/38189CkkpiF9cbQVGubqAv3um6suGs5MxH5yJzvcfaeJpsHGJq2pqEstiHbfHffcvsNqyd6nhwx3T29EqNc56i5p?cluster=devnet), `confirm_sol_payout` [R4KvtgBH…](https://testnet.near.rocks/tx/R4KvtgBHzAvo2CnBLJefcGHpAjR3SFXf3mwtkoQvd7U) | 3,800 tokens booked in the class's swept balance (the app's claim drew the other 100 before the end); `TransferChecked` with no stream touched, `Landed` on its receipt |

Every one of these transactions advances the claimant's receipt nonce account last, and the engine
settles each Solana payout and redeem on that receipt, not on the streams, because Streamflow's
auto-claim empties an ended stream whether or not a payout drew on it
([security model](./docs/security.md#payouts-two-phase-on-solana)).

### Measured once, relied on everywhere

- **CKD from a contract:** 19 Tgas is the live minimum for the key request (the engine attaches 25);
  the close-to-key round trip took 4.2 to 4.8 s in the spike.
- **Browser sealing:** 11.7 to 16.5 ms per encryption (Node and headless Chromium) against the live
  CKD key, 192-byte ciphertexts.
- **Sablier port:** 197 of 197 live `streamedAmountOf` reads reproduced exactly by the Rust unlock
  function in the spike (a scratch binary, command in `docs/verification.md`), including cliffs and
  a stream with a one-day granularity; twelve of those streams are replayed on every test run by
  `contracts/engine/tests/sablier_live.rs` and by the TypeScript port's tests.
- **ForeignTx:** a mismatch with `expected_payload_hash` is a silent 2-minute timeout, so the engine
  omits it and recomputes the hash itself (measured both ways).
- **A failing durable-nonce transaction still advances its nonce** and rolls back every other
  instruction (measured on devnet), which is why Solana payouts are two-phase and settle on a
  receipt nonce account the transaction advances last.
- **Keyless Test USDC:** keys deleted [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG);
  `view_access_key_list` on `tusdc.rose-app.testnet` returns `[]`.
- **Keyless deployment, rehearsed:** the exact helpers of `deploy-engine.sh --keyless` ran on a
  throwaway account with two full-access keys: code hash checked, both keys deleted in one
  transaction [LajMMx8z…](https://testnet.near.rocks/tx/LajMMx8zpF2HRvnYsDA4WMikPCnM75z52DBowXUSbTC),
  then `view_access_key_list` at `final` returned `[]` on
  `keyless-rehearsal-1793801863.rose-app.testnet`.
- **Keyless final engine:** the same helpers deleted every key of `engine-v2.rose-app.testnet` in
  [2ctK442K…](https://testnet.near.rocks/tx/2ctK442K8PzHwALUsU9WzSZ2RYg4emwvSFwhXf2FjVJ3);
  `view_access_key_list` at `final` returns `[]`, read live by the app's `/status` page.
- **Gas:** every user-facing call measured live and in the sandbox stays under 300 Tgas.

Tests: `cargo test --workspace` (unit, property and recorded live vectors), the NEAR sandbox suites
with the real engine wasm, `forge test` (140 tests, fork tests against the live Sablier Lockup),
`pnpm -r test` (SDK and web app), and Playwright against the deployed app.

## Deployed contracts

The table lists the deployment the app at https://rose-rounds.vercel.app uses. It is generated
from [`deployments/testnet.json`](./deployments/testnet.json), which also records every earlier
deployment; the engine row says whether the engine keeps an access key, and `/status` shows the
same `view_access_key_list` result live.

**Listed now: the final deployment, keyless.** `engine-v2.rose-app.testnet` has no access key:
`view_access_key_list` at `final` returns `[]` (the keys were deleted in
[2ctK442K…](https://testnet.near.rocks/tx/2ctK442K8PzHwALUsU9WzSZ2RYg4emwvSFwhXf2FjVJ3), after
`deploy-engine.sh --role final --keyless` checked the deployed code hash of the reproducible
artifact, every `get_config` value against its init arguments and the bound RoseVault's
`SIGNER()` and `LOCKUP()` live). Nobody can upgrade, drain or stop it; a new version would be a new
account. Its RoseVault was deployed for it with `deploy-base.sh --role final`, reusing the demo
assets of the earlier engines so positions minted from the app stay in the seeded classes.

**Superseded: `engine.rose-app.testnet`** (RoseVault `0x9b7182033d3f4bc017a8776c8bc55f6a261ac95f`),
the first final engine, also keyless. The last review pass found that an Advance funder's share of
a lien never left its account index, so every Advance funder's NEP-145 storage deposit stays locked
on it (fixed in `46358b2`). A keyless engine cannot be patched, so the fix shipped as a new account
with its own RoseVault, as the trust model says new versions do; the old engine still runs, and the
app no longer uses it. The staging deployments before it, `engine-s1` to `engine-s5`, kept a
full-access key and are retired (code replaced by an empty module, balance reclaimed). Every
earlier record stays in [`deployments/testnet.json`](./deployments/testnet.json) and
[`docs/verification.md`](./docs/verification.md).

| Chain | Contract | Address | Deployment |
|---|---|---|---|
| NEAR testnet | rose-engine (final, keyless) | `engine-v2.rose-app.testnet` | create [AzUsL5Bb…](https://testnet.near.rocks/tx/AzUsL5BbbsG3C5s1rcfDqRPQK4YCMUMLVAMG15TRSD5R), deploy and `new` [5y42Nnqc…](https://testnet.near.rocks/tx/5y42Nnqcy58dypq5B6SqqVmfgtM1JsRXTjVeJVJX94Zp), bootstrap [CfnCUcRC…](https://testnet.near.rocks/tx/CfnCUcRCXLHFLLtqhrmVmKBRKRvSnvuyobjW2eekmeaq), keys deleted [2ctK442K…](https://testnet.near.rocks/tx/2ctK442K8PzHwALUsU9WzSZ2RYg4emwvSFwhXf2FjVJ3) |
| NEAR testnet | Test USDC (NEP-141, keyless) | `tusdc.rose-app.testnet` | deploy [CekG17rC…](https://testnet.near.rocks/tx/CekG17rCG6MQ1djNH4pnbHaFj3EoXLq8b6hApCwXVsUN), keys deleted [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG) |
| NEAR testnet | MPC network (external) | `v1.signer-prod.testnet` | contract 3.19.0 (rose was built against 3.18.0; signing on domains 0 and 1, CKD and Base attestations re-verified live on 3.19.0 on 14 November, see [Limits](#limits-and-roadmap) for Solana attestations), domains 0 to 3 |
| Base Sepolia | RoseVault | `0xb72a42bc59ec2423ed76b56ac82cd3457a6310fe` | [0x301ce573…](https://sepolia.basescan.org/tx/0x301ce5737f288a40df02e48ff3da1049bf2c3a5d4fa6f008020bf9512addf126), signer = the engine's derived `vault/base` `0xc345e592c6db18c162c6225bfb6f6c92b425b7cb` |
| Base Sepolia | TestUSDC | `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` | [0xb7dfe548…](https://sepolia.basescan.org/tx/0xb7dfe548dcd5ad2e79484cff19d1c0d8a6a777830ff2ab567969f63643d599f9) |
| Base Sepolia | DemoToken Cindral (CINDR) | `0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b` | [0x9f02fedb…](https://sepolia.basescan.org/tx/0x9f02fedb507f317f9e6fe7834f3605371f1f76a8db99ff5b987d5fdcf39ed954) |
| Base Sepolia | DemoStreamFaucet | `0xf7b1302c20faab06ad5121981b3e949da24fd98d` | [0xb9c69f8c…](https://sepolia.basescan.org/tx/0xb9c69f8c83640e28e40e9be9036e2afa9b2275fc5b7da90434663abc27b397e5) |
| Base Sepolia | Sablier Lockup v4 (external) | `0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e` | `lockup@v4.0.1` |
| Base Sepolia | Circle USDC (external, accepted cash token) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | Circle |
| Solana devnet | Vault (the engine's derived `vault/sol`) | `EqywuZpmf7i4ycvYqwzxEiDKTq94RifUSjH9pQX1SdWC` | MPC-derived |
| Solana devnet | Fee payer (the engine's derived `gas/sol`) | `HWx7jD36pAzB1Bo83bCvRYtnW5SHLcfdEZw4x4Zdn1Ng` | MPC-derived |
| Solana devnet | Streamflow program (external) | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` | Streamflow |
| Solana devnet | Demo CINDR mint (9 decimals, no freeze authority) | `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` | [KvkQKDTh…](https://explorer.solana.com/tx/KvkQKDThFFTmU44NmjK4Zkfz4zWC9CfnDW7mWFoTwck3GEZ9DvZLrtsXewJNbi6yPMvspJzUHG6wLYy5neqp7Lb?cluster=devnet) |

Engine wasm: the reproducible build of commit
[`0524b33`](https://github.com/gamween/rose/tree/0524b3388f7bf512f39bf521e9af68736482ef9e)
(`cargo near build reproducible-wasm` in `sourcescan/cargo-near:0.22.0-rust-1.97.0`, pinned by
digest in `contracts/engine/Cargo.toml`; the on-chain `contract_source_metadata` names the commit
and the image), 1,019,188 bytes, sha256
`0a0a16ef9cec1916d59b963183eee9a20ded1206e4ec25bbaef759335ae8e46a`, equal to the on-chain code hash
`gC11tnmCzFJ6Bi2BjkQ6Y38Ff5Vttr2J2tKzNTiiuhK` (its base58 form). To rebuild it (cargo-near 0.22.0,
Docker running; the image is pinned by digest, so the build is the same on any machine):

```sh
git clone https://github.com/gamween/rose && cd rose && git checkout 0524b33
(cd contracts/engine && cargo near build reproducible-wasm)
shasum -a 256 target/near/rose_engine/rose_engine.wasm   # 0a0a16ef…e46a
```
The app's `/status` page reads the engine, RoseVault and the Solana vault live.

## Limits and roadmap

| Limit | Bounded today by | Roadmap |
|---|---|---|
| Unaudited, testnet only | Test tokens with no value; tests and the [review passes](./docs/security.md#review-history) | An external audit before any mainnet deployment |
| A threshold of MPC nodes could read bids early or sign for the vaults | The MPC network's threshold and TEEs, the same assumption as every Chain Signatures application | None inside rose: it adds no trust beyond the MPC network |
| A cancelled round's key can still become public through a late MPC response, and anything encrypted to a round is readable after its key is public | No funds move after `Cancelled`; privacy only, stated in the [security model](./docs/security.md#key-release) | None: a property of the scheme (ePrint 2025/2048) |
| Solana deposits and payouts wait on the MPC network's Solana attestations (ForeignTx `AccountState`) | Right after the MPC upgrade to 3.19.0, 7 of 9 Solana attestation requests timed out at 120 s on 14 November between 01:10 and 01:35 UTC; the engine refunded every failed request and the action can be retried from the app. Base attestations, signing and key releases worked throughout | None inside rose: the MPC network's own availability |
| Collateral is public, so each order's size is bounded in public | Over-collateralize to hide it | None planned |
| At most 64 orders per round, no sybil resistance | Bond and storage deposit per order; a new round | Larger rounds with paginated clearing |
| Positions: Sablier Lockup v4 Linear on Base, fee-free Streamflow on Solana | Everything else refused at deposit, with the reason | Sablier Tranched and Dynamic, other vesting contracts (Magna, Hedgey), more chains served by ForeignTx |
| Proceeds are paid in the round's cash token (tUSDC on NEAR or test USDC on Base) | Positions move in kind; nothing is swapped | Paying proceeds out in any asset on any chain through NEAR Intents' 1Click API, on mainnet only (Intents has no testnet) |
| ERC-20 issuer pause or blacklist powers | Stated trust assumption; Solana freeze-authority and Token-2022 mints refused | A per-class token risk note in the app |
| No keeper: rounds, Solana payouts and Streamflow syncs advance when someone calls the next step | The app shows the next action to whoever looks; anyone can call it | None needed |
| Finding buyers is a cold-start problem | Exit rounds are open to anyone; prices are published per class | Issuer-run Tenders first, where the buyer is known, filed from the treasury the issuer already uses (a Sputnik DAO or Trezu today; NEAR Business, a confidential multisig on NEAR Intents, is a natural next front) |

## Tech stack

- **NEAR contracts:** Rust 1.95.0 (pinned), near-sdk 5.30, cargo-near 0.22.0; `rose-engine`
  (NEP-245 units, NEP-145 storage, NEP-297 events), `rose-tusdc` (NEP-141); `rose-ibe`, Boneh-Franklin
  IBE on arkworks 0.4 (BLS12-381), compiled into the contract and to wasm for the browser
  (wasm-bindgen 0.2.130).
- **Base contracts:** Solidity 0.8.38 with Foundry, OpenZeppelin Contracts v5.7.0; RoseVault,
  TestUSDC, DemoToken, DemoStreamFaucet against Sablier Lockup v4.
- **MPC:** NEAR `v1.signer-prod.testnet` 3.19.0: `sign` (secp256k1, Ed25519), CKD (BLS12-381),
  `verify_foreign_transaction` (Base `Log`, Solana `AccountState`).
- **SDK:** `@rose/sdk`, TypeScript 6.0.3: engine bindings checked against the contract ABI, Base and
  Solana adapters, unlock math and the clearing reference behind the Verify panel.
- **Web:** Next.js 16.4.5, React 19.3.1, Tailwind CSS 4.3.4, three.js 0.187.0 for the landing;
  NEAR Connect 0.12.0 and near-api-js 7.4.0, wagmi 3.7.11 and viem 2.57.16, @solana/web3.js 1.99.0 and
  @streamflow/stream 13.4.0; Vitest 5.1.0 and Playwright 1.64.1; deployed on Vercel.
- **Scripts:** bash with near-cli-rs, Foundry and curl for deployments; TypeScript on Node 22.18+
  for the seed and the live end-to-end run.

## Repository structure

```text
contracts/engine     rose-engine (Rust, NEAR): units, rounds, sealing, clearing, settlement, custody
  src/clearing/        Tender, Exit and Advance clearing (pure, property-tested)
  src/custody/         Base and Solana deposits, payouts, redeems, MPC requests
  src/foreign/         MPC wire formats, RoseVault events and EIP-712, Solana messages and layouts
  tests/               vectors, sandbox suites, recorded live MPC responses
contracts/ibe        rose-ibe: IBE against the NEAR MPC CKD key, for the contract and the browser
contracts/tusdc      Test USDC (NEP-141) with a public capped mint
contracts/mock-mpc   MPC stand-in for the sandbox tests (never deployed)
contracts/evm        RoseVault, TestUSDC, DemoToken, DemoStreamFaucet (Foundry)
packages/sdk         @rose/sdk: bindings, chain adapters, unlock math, clearing reference
packages/ibe-wasm    the browser build of rose-ibe
apps/web             Next.js app: landing, app, docs, status, demo faucet route
scripts              deployment, demo seed, live end-to-end runs
deployments          addresses, transaction hashes and records of every live run (no secrets)
docs
  spec.md              the specification: what rose is and what done means
  architecture.md      how each part of the spec is implemented
  security.md          trust model, threats per flow, limitations, review history
  verification.md      every external fact and live run, with the command used
  demo.md              the demo video script and the draft announcement
```

## Getting started

Requirements: Rust 1.95.0 (pinned in `rust-toolchain.toml`, with the `wasm32-unknown-unknown`
target), Foundry 1.4, Node 22.18 or later, pnpm 10, `bash` and `jq` (a scripts test runs the deploy
checks). `forge test` reaches `https://sepolia.base.org` for its fork tests, and the sandbox suite
downloads the NEAR sandbox binary. Secrets never enter the repository;
[`.env.example`](./.env.example) documents every variable.

```sh
git clone --recurse-submodules https://github.com/gamween/rose && cd rose
# (in an existing clone: git submodule update --init --recursive, for the Foundry libraries)
pnpm install --frozen-lockfile
cargo test --workspace         # NEAR contracts, clearing and unlock property tests, recorded live vectors
forge test                     # RoseVault and the demo contracts (fork tests at a pinned block)
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build

# NEAR sandbox suites: the real engine wasm against a signing mock MPC
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --test-threads=1
```

Run the app locally against the final engine:

```sh
cp deployments/engine-v2.rose-app.testnet.env apps/web/.env.local
pnpm --filter @rose/web dev
```

The demo faucet route needs its own testnet hot wallets (`BASE_FAUCET_PRIVATE_KEY`,
`SOLANA_FAUCET_SECRET_KEY` and `FAUCET_COOKIE_SECRET`; `NEAR_FAUCET_ACCOUNT_ID` and
`NEAR_FAUCET_PRIVATE_KEY` only as a fallback when the NEAR account helper is down); without them
every other page works.

Deploy your own engine and replay the demo story on the real testnets, from your own testnet
account. The deployment scripts also need near-cli-rs (`near`), cargo-near 0.22.0, Docker (for the
reproducible build), `curl`, `shasum`, `python3` and Foundry's `cast`; they use your account's key
in the near-cli legacy keychain, `ROSE_ROOT_ACCOUNT` set to it (the cast's
accounts are created under it and funded from it), and your Base and Solana keys in
`~/.config/rose/` (see [`scripts/README.md`](./scripts/README.md)). The engine account is a
sub-account of the root account, for example `engine.<your account>`:

```sh
export ROSE_ROOT_ACCOUNT=<your testnet account>
scripts/deploy-base.sh --engine <engine account> --role final
scripts/deploy-engine.sh <engine account> --role final --reproducible --keyless   # Docker running
pnpm --filter @rose/sdk --filter @rose/ibe-wasm build
node scripts/seed.ts all --env deployments/<engine account>.env       # Cindral cast, cohorts, three sealed rounds
node scripts/e2e-live.ts all --env deployments/<engine account>.env   # close, open, clear, settle, every payout path
```

From another account, `deploy-base.sh` deploys its own TestUSDC, DemoToken and DemoStreamFaucet:
the seed's Cindral treasury on Base is your deployer key, which then holds the CINDR supply. The
project's own final deployment instead keeps the deployed demo assets, so positions minted from
the app stay in the seeded classes:
`scripts/deploy-base.sh --engine <engine account> --role final --demo-assets-from engine-v2.rose-app.testnet`.
Each script records every transaction under `deployments/` and resumes where it stopped.

## Third-party code and AI assistance

- `contracts/ibe` is ported from [Sealwell](https://github.com/Godwin-web3/sealwell)'s `sealwell-ibe`
  crate (MIT OR Apache-2.0); the changes are listed in [`contracts/ibe/README.md`](./contracts/ibe/README.md).
- EVM dependencies: OpenZeppelin Contracts v5.7.0 and forge-std v1.17.0. Sablier's interface is
  copied from `lockup@v4.0.1`.
- Fonts: Departure Mono (SIL Open Font License 1.1) and Geist (SIL Open Font License).
- Interface components adapted from MIT-licensed libraries (rewritten without their animation
  dependency; each source file names its origin, and the licence texts are in
  [`apps/web/THIRD_PARTY_LICENSES.md`](./apps/web/THIRD_PARTY_LICENSES.md)):
  - [`AnimatedNumber`](./apps/web/src/components/ui/AnimatedNumber.tsx) from Magic UI's
    [NumberTicker](https://magicui.design/docs/components/number-ticker)
    ([magicuidesign/magicui](https://github.com/magicuidesign/magicui), MIT, Copyright (c) Magic UI).
  - The `.ui-shine` border sweep in [`globals.css`](./apps/web/src/app/globals.css) from Magic UI's
    [ShineBorder](https://magicui.design/docs/components/shine-border) (same repository and licence).
  - [`ScrambleText`](./apps/web/src/components/ui/ScrambleText.tsx) from Motion Primitives'
    [TextScramble](https://motion-primitives.com/docs/text-scramble)
    ([ibelick/motion-primitives](https://github.com/ibelick/motion-primitives), MIT, Copyright (c) 2024 ibelick).
  - Design references only, no code copied: React Bits, Aceternity UI, Rare UI, ObsidianUI,
    shadcn/ui, Origin UI and the Refero style library.
- **AI assistance:** the code, tests and documents were written during the hackathon with AI coding
  agents (Claude Code, on Fable 5.1, Fable 5.2 and Opus 5.5), directed and reviewed by the author;
  independent review passes ran on a different model than the one that wrote each part
  ([review history](./docs/security.md#review-history)).
- **Prior work:** none. The repository starts on 4 November 2026 with the specification; there is no
  pre-hackathon code and no earlier product on another chain.

## Team

Sofiane Ben Taleb ([@gamween](https://github.com/gamween)).

## License

[MIT](./LICENSE). Imported code keeps its own licence (`contracts/ibe`: MIT OR Apache-2.0 from
Sealwell; OpenZeppelin Contracts: MIT; forge-std: MIT OR Apache-2.0; the adapted Magic UI and
Motion Primitives components: MIT).
