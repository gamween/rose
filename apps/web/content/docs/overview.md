---
title: Overview
description: What rose is, the problem it addresses, who uses it and where it runs.
order: 1
section: Introduction
---

## One line

rose runs sealed, uniform-price liquidity rounds for locked token allocations. A project buys back its insiders' locked tokens without guessing a price. Holders of the same allocation exit together without dumping. Nobody, not even the operator, can read a bid before the round closes. Positions stay where they live (Base, Solana); NEAR holds them through Chain Signatures and settles everything in one ledger.

Tagline: **What was locked, rose.**

## Status

Testnet only: NEAR testnet, Base Sepolia, Solana devnet. Nothing touches mainnet. The contracts are not audited. See [Trust and security](/docs/trust-and-security) before relying on any of this.

## The problem

Locked and vesting allocations are bought and sold today, but badly.

- Foundations already buy back locked allocations from their early investors, always bilaterally and at a fixed, unpublished price. Examples: Omni Foundation (6.77% of supply, May 2025), LayerZero Foundation (5% of supply, Sep 2025), Ethena Foundation (Aug 2026), Monad Foundation (up to $60M, Aug 2026). Sources: [Omni](https://www.nomina.io/blog/omni-foundation-repurchase), [LayerZero](https://unchainedcrypto.com/layerzero-foundation-buys-back-5-of-zro-token-supply-from-early-investors/), [Ethena](https://www.kucoin.com/blog/ethena-ena-tokenomics-buyback-vc-unlocks), [Monad](https://monad.xyz/blog/early-investor-liquidity-program).
- A fixed price fails because holders value the lock differently. Monad's offer was declined by "nearly all" approached holders ([Monad's program page](https://monad.xyz/blog/early-investor-liquidity-program), [Tokenomist](https://tokenomist.ai/research/monad-tokenomics-60m-exit-offer)). A single price only finds the few sellers whose reservation price is below it.
- Open-market buybacks are large ($638M in Jan-Aug 2026, [crypto.news](https://crypto.news/crypto-token-buybacks-hit-record-638m-in-2026/)) and criticized for being predictable (front-run), for insiders selling into them, and for thin books. Lido planned about $20M of buying against about $90k of on-chain depth at +/-2% ([CoinDesk](https://www.coindesk.com/markets/2026/03/30/lido-dao-proposes-usd20-million-ldo-buyback-to-boost-price-after-95-slide)).
- Corporate finance solved this decades ago with the modified Dutch auction tender offer: holders submit sealed asks, the company pays one uniform price. The reported median premium is 12.6%, against 16.0% for fixed-price offers (Comment and Jarrell, 1991, as cited by later studies). No live sealed tender exists in crypto. Sidelot has announced "Sealed Offer Rounds" for memecoin OTC; they are not live and not on NEAR.
- Locked tokens trade OTC at 20-40% typical discounts (STIX, $200-400M per month) and up to 70%, bilaterally, with no public price ([Alea Research digest](https://alearesearch.io/podcast-digest/blockworks/otc-arbitrage-and-the-hidden-yield-in-cryptos-secondary-markets-or-das-nyc-2026-or-day-3-or-insights)). 90% of 16,000+ unlocks are followed by a price decline that starts about 30 days before the unlock ([Keyrock](https://keyrock.com/from-locked-to-liquidity-what-16000-token-unlocks-teach-us/)).

## Users and jobs

| User | Job | Today | With rose |
|---|---|---|---|
| Issuer (foundation, project treasury, DAO) | Buy back locked or vesting allocations before a cliff, fairly and verifiably | Private OTC offers at a guessed price, investor by investor | Launches a Tender round: public budget and max price, sealed asks, one uniform price, a public report |
| Holder (VC, angel, KOL round, sale participant, ex-team with a transferable position) | Get liquidity on a locked position without dumping at unlock | OTC desk at 20-70% discount, or wait and sell into the unlock | Deposits the position once, then sells in Tender or Exit rounds, or sells an Advance on its first unlocks |
| Buyer (fund, OTC desk, long-term believer) | Buy locked supply at a discount and hold the lock | Bilateral OTC, counterparty and settlement risk | Bids sealed in Exit and Advance rounds, receives units that inherit the exact schedule, claims unlocked tokens |

The primary user is the issuer. Holders are the supply side. Buyers are the demand side of secondary rounds.

Most real team vestings are not transferable, so the primary onboarding path is the issuer path: the issuer calls RoseVault `createStreams`, which pulls the tokens and creates the cohort's streams directly in custody in one transaction, each naming the NEAR account that receives its units, and can distribute units to holders with `distribute_units`, a bounded batch that emits NEP-245 events. Holder self-deposit of an existing transferable position is the second path.

## What rose is not

rose does not find buyers for you. Demand is a cold-start problem that a blockchain does not solve. The clearing algorithm itself is also not special to blockchains; it runs fine off-chain in traditional finance. What the chain adds is listed in [Why NEAR](/docs/faq#why-near): delivery versus payment across chains without an escrow agent, bids nobody can read early, a public verifiable result, and one ledger for positions on several chains.

## Where to go next

- [Concepts](/docs/concepts): classes, positions, units, unlock functions, the three round types.
- [How a sealed round works](/docs/sealed-rounds): the lifecycle from Scheduled to Settled.
- [Clearing rules](/docs/clearing-rules): the exact price rules with worked examples.
- [Guides](/docs/guide-issuer) for issuers, [holders](/docs/guide-holder) and [buyers](/docs/guide-buyer).
