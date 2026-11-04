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
2. **Connect.** Click **Connect** and, in each of the NEAR, EVM and Solana tabs, **Create a demo
   wallet**. You see three wallet pills with balances; the keys stay in this browser.
3. **Get test funds.** Open the testnet banner, then **Get test funds**: **Create the demo account
   with test NEAR**, **Mint 1,000 tUSDC on NEAR**, **Mint 1,000 tUSDC on Base**, **Mint me a demo
   vesting position**, **Create a demo Streamflow position**, and the two actions that send Base
   Sepolia ETH and Solana devnet SOL for gas. You see each action succeed with its explorer link and the balances update.
4. **Deposit a position.** Open `/app/deposit`, choose Base, pick the demo Sablier stream and
   deposit it. You see the wait for Base's `safe` head (about 3 minutes), then the MPC network's
   attestation of the deposit (about 10 seconds), then your units minted. The Solana tab does the
   same for the Streamflow position in three engine calls.
5. **Open a round and sell, sealed.** On `/app/rounds`, **Create Exit round** on the class of your
   position with a short window, then **Place ask**. You see your ask in the sealed book: its locked
   units and its ciphertext hash, never its price.
6. **Buy from a second identity.** In a private window, repeat steps 2 and 3, open the same round and
   **Place bid**. The round now shows two sealed orders.
7. **Close, finalize, clear.** After the deadline, click the round's next action: **Close round**
   (the key arrives within seconds), **Finalize** (your browser decrypts every order and opens each
   one on chain), then clear once the reveal window (10 minutes by default) is over. You see the
   supply and demand curves meet at one price, the fills, and the **Verify** panel recomputing the
   same price in your browser.
8. **Claim.** Click **Claim**: proceeds and refunds land in tUSDC; in your portfolio (`/app`), claim
   the CINDR your units unlocked on Base. You see the MPC signature on NEAR and the `executeTransfer`
   on Basescan.
9. **Check the trust claims.** Open `/status`. You see the engine's raw access-key list, the RoseVault
   signer compared with the engine's MPC-derived address, the MPC contract version and the latency
   of recent key releases.
10. **Run a buyback as an issuer.** Open `/app/issuer`: launch a Tender with a budget and a maximum
    price, or **Run via DAO** to get the Sputnik DAO proposal and the Trezu template that file the
    same call from a treasury. After settlement the results page exports the tender report.

## How rose fits the tracks

- **Unstoppable DeFi** (`defi`): cross-chain delivery versus payment with no custodian and no
  bridge. A seller is paid only if its position actually changes hands; the position lives on Base
  or Solana and the NEAR contract controls the vault holding it through **Chain Signatures**
  (EIP-712 authorizations on Base, durable-nonce transactions on Solana). rose does not use NEAR
  Intents: nothing is swapped, positions are moved in kind.
- **Privacy & Private AI** (`privacy`): private finance. Bids are encrypted to a round identity whose
  key the NEAR MPC network, its nodes running in TEEs, derives through **Confidential Key
  Derivation** only when the round contract asks, and the contract can only ask after the deadline.
  Nobody, the operator included, reads a price or a quantity early; after the close every opening is
  verified on chain. rose does not use NEAR AI Cloud.
- **Social Money** (`social`): a treasury that needs approval runs its buyback through a **Sputnik
  DAO** function-call proposal or a **Trezu** custom template generated by the issuer console
  ("Run via DAO"), and the published tender report shows the community what was paid to whom, at
  one price.

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
| Originality | No live sealed tender for locked tokens exists in crypto ([spec section 1](./docs/spec.md#1-problem-evidence)); sealed uniform-price rounds on positions that never leave their chain |
| Sustainability | [Limits and roadmap](#limits-and-roadmap); the final engine is keyless with no upgrade path and `@rose/sdk` reaches it without the app, so it keeps running without its authors |

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
| Solana devnet | Fee-free Streamflow streams of classic SPL mints without a freeze authority | MPC-derived Ed25519 vault | ForeignTx `AccountState` at `Finalized`, after a proof that the stream came from the depositor's own deposit address | Durable-nonce transactions built and signed by the engine, broadcast by anyone, final only once `confirm_sol_payout` proves they landed |

Details: [spec section 7](./docs/spec.md#7-cross-chain-flows) and
[`docs/architecture.md`](./docs/architecture.md).

## Trust model

In short ([`docs/security.md`](./docs/security.md) has the full model, the threats per flow and the
review history; [spec section 7.4](./docs/spec.md#74-trust-model-readme-must-state-it-plainly) is the
normative version):

- **NEAR MPC network:** threshold signing and CKD in TEEs. A threshold of colluding nodes breaks
  custody and sealing; foreign state is trusted to the nodes' RPC quorum.
- **rose-engine:** the final engine is keyless after init (`view_access_key_list` returns `[]`), with
  no upgrade, migrate, delete-account or generic call method, and the CKD request reachable only
  after the deadline. **The staging engines listed below keep a key.**
- **RoseVault:** immutable, no owner, no pause, no upgrade; Sablier Lockup and the signer fixed in
  the constructor. A stream sent with a plain `transferFrom` is unattributed and can only leave
  through a Release authorization.
- **Tokens:** on Base, an ERC-20 whose issuer keeps pause or blacklist powers can freeze RoseVault's
  balance or its transfers to a claimant; rose cannot remove that trust. On Solana, mints with a
  freeze authority and Token-2022 mints are refused at deposit.
- **Third-party programs:** Sablier's withdrawal fee is admin-controlled (0 today); Streamflow's
  program is upgradeable and its on-chain source is not public.
- **Gas:** every user-facing method stays under the 300 Tgas wallet cap (the highest, a verified
  opening, burns about 132 Tgas).
- No other party can move funds, see bids early or stop a round. Not audited.

## Every claim, verified

Every row links the testnet transactions that show it; all of them, with the commands used, are in
[`docs/verification.md`](./docs/verification.md).

### The seeded story, live on `engine-s3`

| Claim | Evidence | Result |
|---|---|---|
| The MPC network releases a round's key only after close, in seconds | `close` of the Tender [AEmbLjSh…](https://testnet.near.rocks/tx/AEmbLjSh63d5u7G3fgGpcyfjYN6iUxhnkjfJYi9m6oMn), the Exit [2ZrRx5cx…](https://testnet.near.rocks/tx/2ZrRx5cx93GxHHxjZcM4H7oYdFcDQodd9bDkGBkzHp5T), the Advance [99ivgchD…](https://testnet.near.rocks/tx/99ivgchDQarJnR6KuzCm6nFEDboTE9e2myfhoRmhnXkQ) | Key stored by the callback 4.1, 4.3 and 6.2 s after `close`, each equal to the offline unwrap of the MPC response |
| Openings are fully verified on chain, by anyone | `open_bid` by a third party, e.g. [B9jZyKqw…](https://testnet.near.rocks/tx/B9jZyKqw8VM3W4UFkg55fkEYdoirZeViVBZhiryFJMhz) | 9 openings at 132.1 to 132.2 Tgas, each equal to what the bidder sealed |
| A malformed bid can be opened by nobody and is slashed | its author's own opening refused [5cy62YfE…](https://testnet.near.rocks/tx/5cy62YfEpE4MioY1txbjGSGWWGAgqRNK2kzQZxSC4LEs); settlement [3mMoWJc4…](https://testnet.near.rocks/tx/3mMoWJc42KYSES6Vx4wpBk8dXHgcifyZgweV8Wanjr9H) | "Opening does not match the ciphertext"; 1 tUSDC bond slashed |
| On-chain clearing equals the reference implementation | `clear` of the Tender [8pNWktzo…](https://testnet.near.rocks/tx/8pNWktzoM4ZDe5oVVHUeKf7ijNkTkJitzXLUbpWAxg5p), the Exit [6QKNsWcC…](https://testnet.near.rocks/tx/6QKNsWcCSJnSDM3p8aqaQ8wTs5zVnKUhwjXMfWToU8gm), the Advance [7WDuM2JP…](https://testnet.near.rocks/tx/7WDuM2JPpXuxFN9FrhxsJVjxq8Esst9psky3p77SsM2m) | 0.036, 0.027 and 0.0375 tUSDC with every fill equal to `@rose/sdk` run on the opened orders |
| A round without a key is cancelled and refunded | `close` refused after the timeout [DCb8yQt5…](https://testnet.near.rocks/tx/DCb8yQt5CsnNdUh7VDJzL9n7SUR3qxxbx8vqg5cdMnHF), `cancel_no_key` [4CszxtfB…](https://testnet.near.rocks/tx/4CszxtfbVfadaWgWZv7tF1eUt2NYbXVw16hQi3tNazk7), refund [A1LojEZZ…](https://testnet.near.rocks/tx/A1LojEZZ4YuXY6RdTFvHv4qEsjd3RYFsEZcPcQg8h1zW) | Escrow and bond refunded |
| A Base deposit is attested by the MPC network | `createStreams` [0x2f0cf0c4…](https://sepolia.basescan.org/tx/0x2f0cf0c454a2119d05cfc359ff921d075fd6feb8ece502ef7b27540b05945ff3), `register_base_deposit` [GaPZiJzS…](https://testnet.near.rocks/tx/GaPZiJzSCvS1VoggFtvBR7So9oB8cmL8P3Wi8GKxwbAK) | Attested `StreamDeposited` log, units minted |
| A Solana deposit is attributed, moved by the engine and registered | `attribute_sol_deposit` [475QA4jF…](https://testnet.near.rocks/tx/475QA4jFhT84HMkL1JFAGsWmxVQLByspXfXpH2wHwbW7), engine-signed move [4HFSWjwf…](https://explorer.solana.com/tx/4HFSWjwfncn99xShwyUkDuZura8FWbUeLpRHtyjM1B328DwBgkaXaftRWUGk5S2yxVi2PEkSHgYxJhLY5eGL2fCx?cluster=devnet), `register_sol_deposit` [HUtQqTEL…](https://testnet.near.rocks/tx/HUtQqTELSkjXV8EaD3XzWa79UyQ3tEFW5fryD1oaAMT5) | 300,000 CINDR position registered |
| Base cash payout through RoseVault | `withdraw_base_cash` [HE2H2wpB…](https://testnet.near.rocks/tx/HE2H2wpBjwJpG9Lz85NWfhU7XA9ANLNhwmomeWT9eJ9A), `executeTransfer` [0x3e6fa1d8…](https://sepolia.basescan.org/tx/0x3e6fa1d87de796b5577535866ddaff4b94051f03bac9daaf646fff253eba1949) | 1,460 tUSDC to the seller's Base address |
| An Advance is repaid from unlocks, in tokens | `withdrawMax` [0x381ab970…](https://sepolia.basescan.org/tx/0x381ab97017540a09710faf1961f293ac097d49cee731e4dc452d53651a02ec60), `claim_base_tokens` [6hgSgqMU…](https://testnet.near.rocks/tx/6hgSgqMU7RGqYWutEkLhFNqMYv8jjoAZXbwny28MtQcH), `executeTransfer` [0x407e89d5…](https://sepolia.basescan.org/tx/0x407e89d5c60b9257d64c2fd47a9ce1ccf56716f1c396636416b9a6e660cb46c8) | CINDR to the funder |
| A position leaves in kind | `redeem` [BYxzmETK…](https://testnet.near.rocks/tx/BYxzmETKB4HS6JCVUfLdksFifurtK8QVK5VrydomiNry), `executeRelease` [0x51b430b2…](https://sepolia.basescan.org/tx/0x51b430b29e8a9c965920c0a868bf6864292658bf70d8ad5f32e4dfce5343a744) | Sablier stream 94 back to its holder |
| NEAR cash payout | `withdraw_near_cash` [AGEXJZc7…](https://testnet.near.rocks/tx/AGEXJZc7f4DCnDf1buEzgja8UUBkhNRYoDgg2yYdpuj7) | 1,732.39 tUSDC to the seller |

### Solana payouts settle on proof of landing

| Claim | Evidence | Result |
|---|---|---|
| A payout is final only once the chain proves it landed | `claim_sol_tokens` [BXfMqQpC…](https://testnet.near.rocks/tx/BXfMqQpCMiwPJjBgwR7avPni5XQzS2KTa3qhWHRyQnfH), the engine-built transaction [5jAM8UFK…](https://explorer.solana.com/tx/5jAM8UFKZdGerAxMfKWsjsGCDudJFrCXTXYhXJi8BbPQzY3AGPEjEyKyLutvtXGchQhpTxkUdUk5mdV7kv4vA4w2?cluster=devnet), `confirm_sol_payout` [4N7426Wa…](https://testnet.near.rocks/tx/4N7426Wa6yc1PdJyB4v3xHEZdoLVb3rqWFCt4Q1yy4wJ) | `AdvanceNonceAccount` + Streamflow `withdraw` + `TransferChecked`; payout `Landed` with the stream's withdrawn amount proven |
| An in-kind release is final only once proven | `redeem` [HYzgNKg1…](https://testnet.near.rocks/tx/HYzgNKg15URoFseEFPrWcXxmyoCEfCFBeDksKpECC9HT), `transfer_recipient` [4QV5DLub…](https://explorer.solana.com/tx/4QV5DLubRwCAX8FA8pyrLMLJwo46PPFYp8B9Yu4KtNqVkD5q7tsFueEFF4MDP1Sdk15g8igQVri6qkwTm45fT1dh?cluster=devnet), `confirm_sol_redeem` [FDetXc54…](https://testnet.near.rocks/tx/FDetXc54nJ92qVuMWD36n4shQApu9365BwsBg7RJq6ik) | Position `Released` |
| The same flow from the app, with a demo wallet | `claim_sol_tokens` [6bgV7dtT…](https://testnet.near.rocks/tx/6bgV7dtT1VZcX7uXDF97HGY8Ct3rt3cZb8Y8LrdM8Y4E), broadcast [NkXBT57X…](https://explorer.solana.com/tx/NkXBT57X4y4DD2MVy6dh3omzc7dM6XjevnKz7MHtv8EYEPF6BPTx8sowH1qHtKg1RWa634Mqby3Ts2nKmisuo46?cluster=devnet), `confirm_sol_payout` [AW7nZvw5…](https://testnet.near.rocks/tx/AW7nZvw5pwQQQFnf8vWMreX7StkF2aqX8d97DUVGZVgS) | Landed in 25 s for the whole flow |

### Measured once, relied on everywhere

- **CKD from a contract:** 19 Tgas is the live minimum for the key request (the engine attaches 25);
  the close-to-key round trip took 4.2 to 4.8 s in the spike.
- **Browser sealing:** 11.7 to 16.5 ms per encryption (Node and headless Chromium) against the live
  CKD key, 192-byte ciphertexts.
- **Sablier port:** 197 of 197 live `streamedAmountOf` reads reproduced exactly by the Rust unlock
  function, including cliffs and a stream with a one-day granularity.
- **ForeignTx:** a mismatch with `expected_payload_hash` is a silent 2-minute timeout, so the engine
  omits it and recomputes the hash itself (measured both ways).
- **A failing durable-nonce transaction still advances its nonce** (measured on devnet), which is why
  Solana payouts are two-phase.
- **Keyless Test USDC:** keys deleted [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG);
  `view_access_key_list` on `tusdc.rose-app.testnet` returns `[]`.
- **Gas:** every user-facing call measured live and in the sandbox stays under 300 Tgas.

Tests: `cargo test --workspace` (unit, property and recorded live vectors), the NEAR sandbox suites
with the real engine wasm, `forge test` (125 tests, fork tests against the live Sablier Lockup),
`pnpm -r test` (SDK and web app), and Playwright against the deployed app.

## Deployed contracts

The deployment below is the **staging** engine `engine-s3.rose-app.testnet` and its RoseVault: the
engine **keeps a full-access key** and was updated in place once, so it is a test deployment, not
the trust model above. The final engine is deployed keyless with its own RoseVault and replaces this
table. Earlier staging deployments (`engine-s1`, `engine-s2`) are recorded in
[`deployments/testnet.json`](./deployments/testnet.json), from which this table is generated.

| Chain | Contract | Address | Deployment |
|---|---|---|---|
| NEAR testnet | rose-engine (staging, keeps its key) | `engine-s3.rose-app.testnet` | create [EZY4bNm6…](https://testnet.near.rocks/tx/EZY4bNm6N6A24UR4huwanVu5pHvwA8VCK2nNjvxQhGiw), deploy [vg77noPS…](https://testnet.near.rocks/tx/vg77noPSiNZdUDnMLzWbnok4UvbUt98rjRdjKzEpTyi), bootstrap [63Jcxdd9…](https://testnet.near.rocks/tx/63Jcxdd9d8h4ZBkfmw2ckCgsHhJkMxu8rZDiEwjHvVZs) |
| NEAR testnet | Test USDC (NEP-141, keyless) | `tusdc.rose-app.testnet` | deploy [CekG17rC…](https://testnet.near.rocks/tx/CekG17rCG6MQ1djNH4pnbHaFj3EoXLq8b6hApCwXVsUN), keys deleted [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG) |
| NEAR testnet | MPC network (external) | `v1.signer-prod.testnet` | contract 3.18.0, domains 0 to 3 |
| Base Sepolia | RoseVault | `0xc12a2896c37616a12284c44c41c2ce925910e44b` | [0xeac089ea…](https://sepolia.basescan.org/tx/0xeac089eae1f72b9d473b6e3c1b58a39667d2540c6426c181b206139ede08959d), signer = the engine's derived `vault/base` `0x45dea02fe29f0b40884e9057b55a4ad4dee7c05e` |
| Base Sepolia | TestUSDC | `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` | [0xb7dfe548…](https://sepolia.basescan.org/tx/0xb7dfe548dcd5ad2e79484cff19d1c0d8a6a777830ff2ab567969f63643d599f9) |
| Base Sepolia | DemoToken Cindral (CINDR) | `0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b` | [0x9f02fedb…](https://sepolia.basescan.org/tx/0x9f02fedb507f317f9e6fe7834f3605371f1f76a8db99ff5b987d5fdcf39ed954) |
| Base Sepolia | DemoStreamFaucet | `0xf7b1302c20faab06ad5121981b3e949da24fd98d` | [0xb9c69f8c…](https://sepolia.basescan.org/tx/0xb9c69f8c83640e28e40e9be9036e2afa9b2275fc5b7da90434663abc27b397e5) |
| Base Sepolia | Sablier Lockup v4 (external) | `0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e` | `lockup@v4.0.1` |
| Base Sepolia | Circle USDC (external, accepted cash token) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | Circle |
| Solana devnet | Vault (the engine's derived `vault/sol`) | `Hzy2sXySh2BBhMqZzeMJM1XN9rCoy5btqXVFhKBn3BbC` | MPC-derived |
| Solana devnet | Fee payer (the engine's derived `gas/sol`) | `EmX3BDddNNVPfCp5TU5ouCXQD7KpQZQeE5zpwwqXEDhH` | MPC-derived |
| Solana devnet | Streamflow program (external) | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` | Streamflow |
| Solana devnet | Demo CINDR mint (9 decimals, no freeze authority) | `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` | [KvkQKDTh…](https://explorer.solana.com/tx/KvkQKDThFFTmU44NmjK4Zkfz4zWC9CfnDW7mWFoTwck3GEZ9DvZLrtsXewJNbi6yPMvspJzUHG6wLYy5neqp7Lb?cluster=devnet) |

Engine wasm: 1,010,528 bytes, sha256 `928d72ef1f8d34b38d0b045083e5c268f6cbcdd66f65b1ea0fb9137ba2e90e50`.
The app's `/status` page reads the engine, RoseVault and the Solana vault live.

## Limits and roadmap

| Limit | Bounded today by | Roadmap |
|---|---|---|
| Unaudited, testnet only | Test tokens with no value; tests and the [review passes](./docs/security.md#review-history) | An external audit before any mainnet deployment |
| A threshold of MPC nodes could read bids early or sign for the vaults | The MPC network's threshold and TEEs, the same assumption as every Chain Signatures application | None inside rose: it adds no trust beyond the MPC network |
| A cancelled round's key can still become public through a late MPC response, and anything encrypted to a round is readable after its key is public | No funds move after `Cancelled`; privacy only, stated in the [security model](./docs/security.md#key-release) | None: a property of the scheme (ePrint 2025/2048) |
| Collateral is public, so each order's size is bounded in public | Over-collateralize to hide it | None planned |
| At most 64 orders per round, no sybil resistance | Bond and storage deposit per order; a new round | Larger rounds with paginated clearing |
| Positions: Sablier Lockup v4 Linear on Base, fee-free Streamflow on Solana | Everything else refused at deposit, with the reason | Sablier Tranched and Dynamic, more chains served by ForeignTx |
| ERC-20 issuer pause or blacklist powers | Stated trust assumption; Solana freeze-authority and Token-2022 mints refused | A per-class token risk note in the app |
| No keeper: rounds and Solana payouts advance when someone calls the next step | The app shows the next action to whoever looks; anyone can call it | None needed |
| Finding buyers is a cold-start problem | Exit rounds are open to anyone; prices are published per class | Issuer-run Tenders first, where the buyer is known |

## Tech stack

- **NEAR contracts:** Rust 1.95.0 (pinned), near-sdk 5.30, cargo-near 0.22.0; `rose-engine`
  (NEP-245 units, NEP-145 storage, NEP-297 events), `rose-tusdc` (NEP-141); `rose-ibe`, Boneh-Franklin
  IBE on arkworks 0.4 (BLS12-381), compiled into the contract and to wasm for the browser
  (wasm-bindgen 0.2.130).
- **Base contracts:** Solidity 0.8.38 with Foundry, OpenZeppelin Contracts v5.7.0; RoseVault,
  TestUSDC, DemoToken, DemoStreamFaucet against Sablier Lockup v4.
- **MPC:** NEAR `v1.signer-prod.testnet` 3.18.0: `sign` (secp256k1, Ed25519), CKD (BLS12-381),
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

Requirements: Rust 1.95.0 (pinned in `rust-toolchain.toml`), Foundry 1.4, Node 22.18 or later and
pnpm 10. Secrets never enter the repository; [`.env.example`](./.env.example) documents every
variable.

```sh
pnpm install --frozen-lockfile
cargo test --workspace         # NEAR contracts, clearing and unlock property tests, recorded live vectors
forge test                     # RoseVault and the demo contracts (fork tests at a pinned block)
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build

# NEAR sandbox suites: the real engine wasm against a signing mock MPC
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --test-threads=1
```

Run the app locally against the staging engine:

```sh
cp deployments/engine-s3.rose-app.testnet.env apps/web/.env.local
pnpm --filter @rose/web dev
```

The demo faucet route needs its own testnet hot wallets (`BASE_FAUCET_PRIVATE_KEY`,
`SOLANA_FAUCET_SECRET_KEY`, `NEAR_FAUCET_ACCOUNT_ID`, `NEAR_FAUCET_PRIVATE_KEY`,
`FAUCET_COOKIE_SECRET`); without them every other page works.

Deploy your own engine and replay the demo story on the real testnets (keys in `~/.config/rose/`,
see [`scripts/README.md`](./scripts/README.md)):

```sh
cd contracts/engine && cargo near build non-reproducible-wasm && cd ../..
scripts/deploy-base.sh --engine <engine account> --role final
scripts/deploy-engine.sh <engine account> --role final --keyless
pnpm --filter @rose/sdk --filter @rose/ibe-wasm build
node scripts/seed.ts all --env deployments/<engine account>.env       # Cindral cast, cohorts, three sealed rounds
node scripts/e2e-live.ts all --env deployments/<engine account>.env   # close, open, clear, settle, every payout path
```

Each script records every transaction under `deployments/` and resumes where it stopped.

## Third-party code and AI assistance

- `contracts/ibe` is ported from [Sealwell](https://github.com/Godwin-web3/sealwell)'s `sealwell-ibe`
  crate (MIT OR Apache-2.0); the changes are listed in [`contracts/ibe/README.md`](./contracts/ibe/README.md).
- EVM dependencies: OpenZeppelin Contracts v5.7.0 and forge-std v1.17.0. Sablier's interface is
  copied from `lockup@v4.0.1`.
- Fonts: Departure Mono (SIL Open Font License 1.1) and Geist (SIL Open Font License).
- **AI assistance:** the code, tests and documents were written during the hackathon with AI coding
  agents (Claude Code, on Fable 5.1 and Opus 5.5), directed and reviewed by the author; independent
  review passes ran on a different model than the one that wrote each part
  ([review history](./docs/security.md#review-history)).
- **Prior work:** none. The repository starts on 4 November 2026 with the specification; there is no
  pre-hackathon code and no earlier product on another chain.

## Team

Sofiane Ben Taleb ([@gamween](https://github.com/gamween)).

## License

[MIT](./LICENSE). Imported code keeps its own licence (`contracts/ibe`: MIT OR Apache-2.0 from
Sealwell; OpenZeppelin Contracts: MIT; forge-std: MIT OR Apache-2.0).
