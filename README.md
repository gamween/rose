<div align="center">

# 🌹 rose

**Sealed, uniform-price liquidity rounds for locked token allocations. A project buys back its insiders' locked tokens without guessing a price, holders of one allocation exit together without dumping, and nobody, not even the operator, can read a bid before the round closes.**

[![NEAR Hackathon 2026](https://img.shields.io/badge/NEAR%20Hackathon-2026-00ec97?style=flat-square)](https://nearhackathon.com)
[![Testnet only](https://img.shields.io/badge/network-testnet%20only-e8590c?style=flat-square)](#status)
[![Chain Signatures](https://img.shields.io/badge/NEAR-Chain%20Signatures-000?style=flat-square)](#why-near)
[![CKD sealed bids](https://img.shields.io/badge/NEAR%20MPC-Confidential%20Key%20Derivation-000?style=flat-square)](#how-a-sealed-round-works)
[![Base Sepolia](https://img.shields.io/badge/Base%20Sepolia-Sablier%20v4-0052ff?style=flat-square)](#cross-chain-custody)
[![Solana devnet](https://img.shields.io/badge/Solana%20devnet-Streamflow-9945ff?style=flat-square)](#cross-chain-custody)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

**[Specification](./docs/spec.md)** · **[Architecture](./docs/architecture.md)** · **[Verification log](./docs/verification.md)**

*What was locked, rose.*

</div>

rose runs sealed auctions over locked token positions. An issuer (a foundation, a treasury, a DAO)
publishes a budget and a maximum price; holders of a locked allocation submit sealed asks; one
uniform clearing price is computed on-chain and every filled seller receives it. The same engine
runs group exits (sealed asks against sealed bids from buyers) and advances (a holder sells a senior
claim on their first unlocks). Positions stay where they live, as Sablier streams on Base or
Streamflow streams on Solana; NEAR holds them through Chain Signatures, proves their state through
the MPC network's foreign transaction verification, and settles everything in one ledger.

> Foundations already buy back locked allocations from their early investors, bilaterally and at a
> fixed, unpublished price (Omni, LayerZero, Ethena, Monad in 2025-2026). A fixed price only finds
> the few holders whose own valuation is below it: Monad's offer was declined by "nearly all"
> approached holders. Corporate finance solved this with the modified Dutch auction tender offer:
> sealed asks, one uniform price. No live sealed tender exists in crypto. Sources in
> [spec section 1](./docs/spec.md#1-problem-evidence).

## Table of contents

- [Status](#status)
- [How rose fits the tracks](#how-rose-fits-the-tracks)
- [Why NEAR](#why-near)
- [How a sealed round works](#how-a-sealed-round-works)
- [Cross-chain custody](#cross-chain-custody)
- [Every claim, verified](#every-claim-verified)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Third-party code and AI assistance](#third-party-code-and-ai-assistance)
- [Team](#team)
- [License](#license)

## Status

Built during NEAR Hackathon 2026 (1 to 14 November). Testnet only: NEAR testnet, Base Sepolia,
Solana devnet; nothing touches mainnet. Unaudited.

Live today:

- **Test USDC on NEAR**, keyless, at [`tusdc.rose-app.testnet`](./docs/verification.md#deployed-rose-tusdc-on-near-testnet), with a public capped mint.
- **RoseVault on Base Sepolia**: custody of Sablier Lockup v4 streams and cash, released only against
  EIP-712 authorizations signed by the engine's MPC-derived key. Exercised live: deposits of a stream
  with nothing vested and of a partly vested stream, a release, a payout
  ([transactions](./docs/verification.md#base-sepolia-rosevault-spike-prototype-signer--spike-key)).
- **MPC signing measured from a contract**: an EIP-712 signature recovered to the derived address in
  Foundry, and a Solana durable-nonce payout signed through Chain Signatures and broadcast on devnet
  ([evidence](./docs/verification.md#near-mpc-sign-domains-0-and-1-measured-from-a-contract)).

In progress: the NEAR engine (rounds, sealed bids, clearing, settlement, foreign custody), the web
app and the landing page. This README is updated as each part lands.

## How rose fits the tracks

- **Unstoppable DeFi** (`defi`): cross-chain delivery versus payment with no custodian and no
  bridge. A seller is paid only if their position actually changes hands; the position lives on
  Base or Solana and is controlled by the NEAR contract through Chain Signatures.
- **Privacy** (`privacy`): bids are encrypted to an identity whose key the NEAR MPC network (nodes in
  TEEs) releases through Confidential Key Derivation only when the round contract asks, and the
  contract can only ask after the deadline. Nobody, including the operator, reads a bid early.
- **Social Money** (`social`): treasuries that need approval run a buyback through a Sputnik DAO
  proposal ("Run via DAO"), and the published tender report shows the community exactly what was
  paid to whom.

## Why NEAR

Only the reasons that carry weight ([spec section 3](./docs/spec.md#3-why-blockchain-why-near-only-load-bearing-reasons)):

1. **Delivery versus payment across chains without an escrow agent**, through Chain Signatures and
   the MPC network's `verify_foreign_transaction`.
2. **Bids nobody can read early**, through Confidential Key Derivation (domain 2) gated by contract
   state.
3. **A public, verifiable result**: clearing price, allocations and fills computed on-chain from
   opened bids.
4. **One ledger for positions on several chains**: units of a position class are NEP-245 tokens on
   NEAR while the underlying stream never moves.

Where blockchain adds nothing, and we do not pretend otherwise: finding buyers, and the clearing
algorithm itself.

## How a sealed round works

`Scheduled -> Open -> KeyRequested -> Revealing -> Clearing -> Settled | Cancelled`. Every step is a
public method; there is no keeper.

1. Bids are encrypted in the browser (Boneh-Franklin IBE) to the round's identity under the MPC CKD
   master key, bound to the round, the bidder and the side.
2. After the deadline anyone calls `close`; the contract requests the round key from the MPC network.
3. Once the key is public, anyone can open any bid; the contract fully verifies each opening, so a
   malformed bid can be opened by nobody and its bond is slashed.
4. The contract computes one uniform clearing price and the fills; participants pull their units,
   cash and refunds. Rules and worked examples: [spec section 5.4](./docs/spec.md#54-clearing-computed-on-chain-paginated).

## Cross-chain custody

| Chain | Positions | Custody | Proof of deposit | Payouts |
|---|---|---|---|---|
| Base Sepolia | Sablier Lockup v4 linear streams (`0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e`) | RoseVault, immutable, no admin | `verify_foreign_transaction`, `Log` extractor | EIP-712 authorizations signed by the MPC, submitted by the claimant |
| Solana devnet | Streamflow streams (`HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ`) | MPC-derived Ed25519 vault | `verify_foreign_transaction`, `AccountState` extractor | Durable-nonce transactions built and signed by the engine, broadcast by anyone |

## Every claim, verified

Every external fact rose relies on (addresses, versions, method names, byte layouts, gas, latency)
is checked live and recorded with the command used in [`docs/verification.md`](./docs/verification.md).

## Repository structure

```
contracts/engine   rose-engine (Rust, NEAR): units, rounds, sealing, clearing, settlement, custody
contracts/ibe      rose-ibe: IBE against the NEAR MPC CKD key, for the contract and the browser
contracts/tusdc    Test USDC (NEP-141) with a public capped mint
contracts/evm      RoseVault, TestUSDC, DemoToken, DemoStreamFaucet (Foundry)
packages/sdk       TypeScript client: bindings, chain adapters, unlock math, clearing reference
apps/web           Next.js app: landing, app, docs, status
docs               spec, architecture, verification log
```

## Getting started

Requirements: Rust 1.95 (pinned in `rust-toolchain.toml`), Foundry 1.4, Node 22 and pnpm 10.

```bash
cargo test --workspace   # NEAR contracts and the clearing engine
forge test               # RoseVault and the Base Sepolia demo contracts (includes pinned-block fork tests)
```

Secrets never enter the repository; `.env.example` lists every variable.

## Third-party code and AI assistance

- `contracts/ibe` is ported from [Sealwell](https://github.com/Godwin-web3/sealwell)'s `sealwell-ibe`
  crate (MIT OR Apache-2.0); changes are listed in [`contracts/ibe/README.md`](./contracts/ibe/README.md).
- EVM dependencies: OpenZeppelin Contracts v5.7.0 and forge-std v1.17.0. Sablier's interface is
  copied from `lockup@v4.0.1`.
- The code was written during the hackathon with AI coding agents (Claude Code), directed and
  reviewed by the author. There is no pre-hackathon code in this repository.

## Team

Sofiane ([@gamween](https://github.com/gamween)).

## License

[MIT](./LICENSE).
