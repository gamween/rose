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
   attestation of the deposit (6 to 9 seconds when measured), then your units minted. The Solana tab does the
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
| Sustainability | [Limits and roadmap](#limits-and-roadmap); the engine has no upgrade path, its final deployment deletes every access key after init (rehearsed on testnet, see [Deployed contracts](#deployed-contracts) for which deployment is keyless) and `@rose/sdk` reaches it without the app, so a keyless engine keeps running without its authors |

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
| Solana devnet | Fee-free Streamflow streams of classic SPL mints without a freeze authority | MPC-derived Ed25519 vault | ForeignTx `AccountState` at `Finalized`, after a proof that the stream came from the depositor's own deposit address | Durable-nonce transactions built and signed by the engine, broadcast by anyone, final only once `confirm_sol_payout` proves on the claimant's receipt nonce account that they landed |

Details: [spec section 7](./docs/spec.md#7-cross-chain-flows) and
[`docs/architecture.md`](./docs/architecture.md).

## Trust model

In short ([`docs/security.md`](./docs/security.md) has the full model, the threats per flow and the
review history; [spec section 7.4](./docs/spec.md#74-trust-model-readme-must-state-it-plainly) is the
normative version):

- **NEAR MPC network:** threshold signing and CKD in TEEs. A threshold of colluding nodes breaks
  custody and sealing; foreign state is trusted to the nodes' RPC quorum.
- **rose-engine:** no upgrade, migrate, delete-account or generic call method, and the CKD request
  reachable only after the deadline. The final deployment deletes every access key after init:
  `deploy-engine.sh --role final` refuses to run without `--keyless`, checks the deployed code
  hash before deleting any key, and records the engine as keyless only once
  `view_access_key_list` at `final` returns `[]`. New versions deploy to new accounts.
  [Deployed contracts](#deployed-contracts) says whether the listed engine is that keyless one;
  **a staging engine keeps a key and is not this trust model.**
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

### The seeded story, live on `engine-s5`

| Claim | Evidence | Result |
|---|---|---|
| The MPC network releases a round's key only after close, in seconds | `close` of the Tender [GpiGfPHZ…](https://testnet.near.rocks/tx/GpiGfPHZZtCeLb1kE7r6rSCBLZ7Qbpg9Xrhb1Bnk7E4u), the Exit [Fjacn1yn…](https://testnet.near.rocks/tx/Fjacn1ynz1SLpzYhAMhfBftAKES84Apa9HLysqLaXsGJ), the Advance [GjXH9kGh…](https://testnet.near.rocks/tx/GjXH9kGh7aZtU5PsFUwh1rRjdQ1bJScoBGvrK9h1YorU) | Key stored by the callback 5.4, 4.2 and 4.2 s after `close`, each equal to the offline unwrap of the MPC response |
| Openings are fully verified on chain, by anyone | `open_bid` sent by `rose-app.testnet`, which placed no order and created no round (it deployed the engine), e.g. [9JKcYjKZ…](https://testnet.near.rocks/tx/9JKcYjKZqsiSrFX5pmk6tpEmnVxXwpmaYUoeU91bcWKB) | 9 openings at 132.1 Tgas, each equal to what the bidder sealed |
| A malformed bid can be opened by nobody and is slashed | its author's own opening refused [EE9vC4QR…](https://testnet.near.rocks/tx/EE9vC4QRDFPWp4VzwtA3TTGRuiWKxh9Aqnnoo5XgkUsq); settlement [Gq2uLUZu…](https://testnet.near.rocks/tx/Gq2uLUZu9QVo97LqnxpnxAZUgw1A3azqXf4gDWc1TJJw) | "Opening does not match the ciphertext"; 1 tUSDC bond slashed |
| On-chain clearing equals the reference implementation | `clear` of the Tender [CR1hxSV9…](https://testnet.near.rocks/tx/CR1hxSV9LS5LkyTA8spn5gp1PH7rCipg3hg4YbZxUJgT), the Exit [5ZeCEuJd…](https://testnet.near.rocks/tx/5ZeCEuJdnbJdKq9Rnhjkd3EFtjss54qGEjA6tT5WiTrD), the Advance [5wvEiRBu…](https://testnet.near.rocks/tx/5wvEiRBuYUdeSKAPxAz6bvUU6vRrP9TM5MuK9FJGhbVS) | 0.036, 0.027 and 0.0375 tUSDC with every fill equal to `@rose/sdk` run on the opened orders |
| A round without a key is cancelled and refunded | `close` refused after the timeout [3Lh9SkF1…](https://testnet.near.rocks/tx/3Lh9SkF1FaNJMavexYUDbjCGWSc9cLw95RAZDzkMJ5dw), `cancel_no_key` [FzHeiPW7…](https://testnet.near.rocks/tx/FzHeiPW7YnZ4sgyuUz8TFbfEzf2jYghT4wNVp713cB7H), refund [C1wTSQTc…](https://testnet.near.rocks/tx/C1wTSQTcrsuKvJz5abFCT1Nnx8UvtAmt5NcStPqpusxb) | Escrow and bond refunded |
| A Base deposit is attested by the MPC network | `createStreams` [0xb87e1f42…](https://sepolia.basescan.org/tx/0xb87e1f4256248d13fe5d893985a48f3e11dfb69cf6f66b7b52291999549ec985), `register_base_deposit` [H5NLXune…](https://testnet.near.rocks/tx/H5NLXuneb9WgEUtPQ4ppC8Ku592YpVCcb3wBUbc6imoG) | Attested `StreamDeposited` log, units minted |
| A Solana deposit is attributed, moved by the engine and registered | `attribute_sol_deposit` [8sfST8Ft…](https://testnet.near.rocks/tx/8sfST8FtfsRPQKxuSnMiN5sFEhCjyXxfymAj6RFh6r3g), engine-signed move [5WSByfg4…](https://explorer.solana.com/tx/5WSByfg4zjFccrsBNcXhqrPY6YYjdywjoC85CCVsxDhwA6KxBaSQD8AkMXmyxM6BhTcZwZdW66vDTjFLBmhkKKJe?cluster=devnet), `register_sol_deposit` [744LoCaN…](https://testnet.near.rocks/tx/744LoCaNHcgQZnZjUYREDmGbsQVRVJMgCP9BLiihUYG3) | 300,000 CINDR position registered |
| Base cash payout through RoseVault | `withdraw_base_cash` [HxgYaFiD…](https://testnet.near.rocks/tx/HxgYaFiDSboF5JrpdANb7qaV7YdhKymABaHAEfifizGJ), `executeTransfer` [0x75a38f07…](https://sepolia.basescan.org/tx/0x75a38f070d031326c6d6bd6e265b0d48e3a5e4dde749aaf8618db2dc3b010dba) | 1,460 tUSDC to the seller's Base address |
| An Advance is repaid from unlocks, in tokens | `withdrawMax` [0xbd335edc…](https://sepolia.basescan.org/tx/0xbd335edcfb24af8a209c54735073db5b5acd73b99651caeca359fa657f21bc70), `claim_base_tokens` [4iBThtxz…](https://testnet.near.rocks/tx/4iBThtxza5rpVL1TMcPji4eS8tbbhEQNQi2j96VpZf25), `executeTransfer` [0x7add0744…](https://sepolia.basescan.org/tx/0x7add0744d85a77472356d5b5829dfba6492e983d0f967568e94e3999f93b4345) | CINDR to the funder |
| A position leaves in kind | `redeem` [5vRCY1Sr…](https://testnet.near.rocks/tx/5vRCY1Sra7Wo2wmrTvjKKEnDiP3ecyf3LAZHjPHbDFKy), `executeRelease` [0xc759e819…](https://sepolia.basescan.org/tx/0xc759e819ca69d013693d187bfa628bd7f53edf21788b0a0196ddf8991cf6e500) | Sablier stream 105 back to its holder |
| NEAR cash payout | `withdraw_near_cash` [EpVAiy9L…](https://testnet.near.rocks/tx/EpVAiy9LoDwgi2Wui7AjhVNTCwtZQGyWUYkNYTzWwSEn) | 1,732.39 tUSDC to the seller |

### Solana payouts settle on proof of landing

| Claim | Evidence | Result |
|---|---|---|
| A payout is final only once the chain proves it landed | `claim_sol_tokens` [4ZyG3Wfu…](https://testnet.near.rocks/tx/4ZyG3WfusGEYnSXERzaLUuvrix22nsTfqFh1oQ5gs2Vt), the engine-built transaction [4vwuRBBJ…](https://explorer.solana.com/tx/4vwuRBBJZVVux348EB1g316t12wZBtJYkmNRHa887VGqupoSQoiHv3KX62q5dcC1jVowu1ZD26Qmep2EEsYu9eTD?cluster=devnet), `confirm_sol_payout` [BRV8Voje…](https://testnet.near.rocks/tx/BRV8VojeGDC2hXjYMiiMjGoTaRyhG7gUk1HWH4mjNE85) | `AdvanceNonceAccount` + Streamflow `withdraw` + `TransferChecked`; payout `Landed` |
| An in-kind release is final only once proven | `redeem` [DisLkUAV…](https://testnet.near.rocks/tx/DisLkUAVc5Vi7q3yyiZiCUj6iFtrMHjriP27Rp2GofP9), `transfer_recipient` [5RqubDf3…](https://explorer.solana.com/tx/5RqubDf39Pk1AZgUB9Un6FBGCWWvt2p1HQJHL9XwGxGLxLCdTQTAMbMEm3Gm7HPaP3ER75JMaoNhgoxCiddJTYof?cluster=devnet), `confirm_sol_redeem` [8Rne79aJ…](https://testnet.near.rocks/tx/8Rne79aJPmBdxcEExCMChQnryxmegPB5AeZNnN8gbqqt) | Position `Released` |
| The same flow from the app, with a demo wallet | `claim_sol_tokens` [WF8mwosp…](https://testnet.near.rocks/tx/WF8mwosp4SUVWkBHqeCvCcGetqR5CdvB9PkWpU1tXA1), broadcast [3inv2VCp…](https://explorer.solana.com/tx/3inv2VCpaEV5EqsH4K2LPpCy4asRBU8V4YghY6zS7br5dYLCsNuvQxt1vszUr8hYnTnzXA6qyYEY6pNe9SuQz5Fy?cluster=devnet), confirmed in the same flow | Payout 9 `Landed` on its receipt, 48 s from click to confirmation |
| An ended stream's auto-claim is booked, then paid out | Streamflow's auto-claim [3KHqQvJW…](https://explorer.solana.com/tx/3KHqQvJWv7CCiGExdgKNQaS7jEQKtuQfPYmm2DyheRFv77yNAJ6YHbwhm4njxL3mjE3SAv2519hfysivwiKaoeqz?cluster=devnet), `sync_sol_stream` from the app's Sync button [3TAmMgNc…](https://testnet.near.rocks/tx/3TAmMgNcvBbyiU6ZXQwuCUGi17DRWXbe1C3tSedCpbfw), a claim paid from the swept balance alone [E6xcrwU9…](https://testnet.near.rocks/tx/E6xcrwU9FzswnNGGse2oPerpvQPfcQjwy1Nv8izyygv8) + [2ShT3TqZ…](https://explorer.solana.com/tx/2ShT3TqZKJvYF9xhVvkg8bBrTVrcUxP3wgmtb1QpQxBfHykftBHD5zAAz6iM36o3iz7psHUdPRFhRD4pSy5Xzzrd?cluster=devnet), `confirm_sol_payout` [EhLjMXGH…](https://testnet.near.rocks/tx/EhLjMXGH8ogMmnpQuBzpHEhHnnxgCHZursmrpxCwQNJs) | 3,800 tokens booked in the class's swept balance; `TransferChecked` with no stream touched, `Landed` on its receipt |

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
- **Gas:** every user-facing call measured live and in the sandbox stays under 300 Tgas.

Tests: `cargo test --workspace` (unit, property and recorded live vectors), the NEAR sandbox suites
with the real engine wasm, `forge test` (139 tests, fork tests against the live Sablier Lockup),
`pnpm -r test` (SDK and web app), and Playwright against the deployed app.

## Deployed contracts

The table lists the deployment the app at https://rose-rounds.vercel.app uses. It is generated
from [`deployments/testnet.json`](./deployments/testnet.json), which also records every earlier
deployment; the engine row says whether the engine keeps an access key, and `/status` shows the
same `view_access_key_list` result live.

**Listed now: a staging deployment.** `engine-s5.rose-app.testnet` **keeps a full-access key**, so
it is a test deployment, not the trust model above. It was deployed with the same scripts and
artifact type as the final deployment: the reproducible build of commit
[`b32248e`](https://github.com/gamween/rose/tree/b32248e8e5204ce9812929ad59570e210e638587)
(`deploy-engine.sh --reproducible`, whose `contract_source_metadata` names that commit and the
pinned build image), with `--role staging` and without `--keyless`, its own RoseVault, and the
demo assets of the earlier staging engines (`deploy-base.sh --demo-assets-from`); the final
deployment runs `deploy-engine.sh --role final --reproducible --keyless`. Earlier staging
deployments: `engine-s1`, `engine-s2`, `engine-s3` (retired: code replaced by an empty module,
balance reclaimed) and `engine-s4`.

| Chain | Contract | Address | Deployment |
|---|---|---|---|
| NEAR testnet | rose-engine (staging, keeps its key) | `engine-s5.rose-app.testnet` | create [C7rS4vA7…](https://testnet.near.rocks/tx/C7rS4vA7R7fQhvfnW6MrPgoy6uKfPELPuLNwmh235mKh), deploy [4iNcrZfD…](https://testnet.near.rocks/tx/4iNcrZfD3DDjYmZ6WqZDyu3bHUu17MUeLcP2naNqXvC8), bootstrap [HUGDTy3g…](https://testnet.near.rocks/tx/HUGDTy3guMjr1EAmXCYjQiA3WeS6YodDf7SLyMNfqm33) |
| NEAR testnet | Test USDC (NEP-141, keyless) | `tusdc.rose-app.testnet` | deploy [CekG17rC…](https://testnet.near.rocks/tx/CekG17rCG6MQ1djNH4pnbHaFj3EoXLq8b6hApCwXVsUN), keys deleted [EjiBFUNB…](https://testnet.near.rocks/tx/EjiBFUNB8CmiY8qTERPvaqYc8jFkBds51iTSAGShq1MG) |
| NEAR testnet | MPC network (external) | `v1.signer-prod.testnet` | contract 3.18.0, domains 0 to 3 |
| Base Sepolia | RoseVault | `0x62358c4f6fadb303f3a7d18ad34a1afcc1174d06` | [0x2f5d3e2e…](https://sepolia.basescan.org/tx/0x2f5d3e2e3b4be2b578bad4fcfb58bf354813bbc2ff924000f622ba9368125aa4), signer = the engine's derived `vault/base` `0x89caef524792109c4b6c8e6373bcf54d84acffc6` |
| Base Sepolia | TestUSDC | `0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01` | [0xb7dfe548…](https://sepolia.basescan.org/tx/0xb7dfe548dcd5ad2e79484cff19d1c0d8a6a777830ff2ab567969f63643d599f9) |
| Base Sepolia | DemoToken Cindral (CINDR) | `0x1250554fdbd8e63a75ea9ed0021f2dcae55d3f4b` | [0x9f02fedb…](https://sepolia.basescan.org/tx/0x9f02fedb507f317f9e6fe7834f3605371f1f76a8db99ff5b987d5fdcf39ed954) |
| Base Sepolia | DemoStreamFaucet | `0xf7b1302c20faab06ad5121981b3e949da24fd98d` | [0xb9c69f8c…](https://sepolia.basescan.org/tx/0xb9c69f8c83640e28e40e9be9036e2afa9b2275fc5b7da90434663abc27b397e5) |
| Base Sepolia | Sablier Lockup v4 (external) | `0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e` | `lockup@v4.0.1` |
| Base Sepolia | Circle USDC (external, accepted cash token) | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` | Circle |
| Solana devnet | Vault (the engine's derived `vault/sol`) | `12gqQ8r5Uo9dLdjMeBjfUvnqdAjCawckWo8V3qtgAKo4` | MPC-derived |
| Solana devnet | Fee payer (the engine's derived `gas/sol`) | `AhW7b4UDXAiURcA912d5uSy9cwvwjR5sb6KqUG1NnXcx` | MPC-derived |
| Solana devnet | Streamflow program (external) | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` | Streamflow |
| Solana devnet | Demo CINDR mint (9 decimals, no freeze authority) | `2eWdSYbcryjZvA8UBmjTmEqjRqzY2LVUnHUby1gdDLNv` | [KvkQKDTh…](https://explorer.solana.com/tx/KvkQKDThFFTmU44NmjK4Zkfz4zWC9CfnDW7mWFoTwck3GEZ9DvZLrtsXewJNbi6yPMvspJzUHG6wLYy5neqp7Lb?cluster=devnet) |

Engine wasm: the reproducible build of `b32248e` (`cargo near build reproducible-wasm` in
`sourcescan/cargo-near:0.22.0-rust-1.97.0`), 1,016,367 bytes, sha256
`85a27c33b34c564647a5ec8cde66e86b609eaa3c3bb81c9b422b301ce9eb6942`, equal to the on-chain code hash.
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
| No keeper: rounds, Solana payouts and Streamflow syncs advance when someone calls the next step | The app shows the next action to whoever looks; anyone can call it | None needed |
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
git clone --recurse-submodules https://github.com/gamween/rose && cd rose
# (in an existing clone: git submodule update --init --recursive, for the Foundry libraries)
pnpm install --frozen-lockfile
cargo test --workspace         # NEAR contracts, clearing and unlock property tests, recorded live vectors
forge test                     # RoseVault and the demo contracts (fork tests at a pinned block)
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build

# NEAR sandbox suites: the real engine wasm against a signing mock MPC
ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --test-threads=1
```

Run the app locally against the staging engine:

```sh
cp deployments/engine-s5.rose-app.testnet.env apps/web/.env.local
pnpm --filter @rose/web dev
```

The demo faucet route needs its own testnet hot wallets (`BASE_FAUCET_PRIVATE_KEY`,
`SOLANA_FAUCET_SECRET_KEY` and `FAUCET_COOKIE_SECRET`; `NEAR_FAUCET_ACCOUNT_ID` and
`NEAR_FAUCET_PRIVATE_KEY` only as a fallback when the NEAR account helper is down); without them
every other page works.

Deploy your own engine and replay the demo story on the real testnets, from your own testnet
account: its key in the near-cli legacy keychain, `ROSE_ROOT_ACCOUNT` set to it (the cast's
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
`scripts/deploy-base.sh --engine <engine account> --role final --demo-assets-from engine-s5.rose-app.testnet`.
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
