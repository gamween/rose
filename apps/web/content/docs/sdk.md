---
title: SDK
description: The TypeScript client that the app uses, and that anyone can use instead of the app.
order: 12
section: Reference
---

## What it is

`@rose/sdk` lives in `packages/sdk` of the repository. It is the TypeScript client the web app is built on, and it is the way to use rose without the app: from a script, a treasury tool, a bot or an AI agent. Everything the app does goes through the SDK, and the SDK only talks to public RPCs and the contracts. There is no rose server in the path.

## What it contains

1. **Engine bindings.** Typed calls for every public method and view of the rose engine on NEAR: classes, positions, units, rounds, bids and asks, lifecycle steps (`close`, `submit_key`, `cancel_no_key`, `open_bid`, `clear`, `settle_bid`), claims, redeem, and the bounded on-chain event history that replaces an indexer. Sealing itself is done by the IBE crate compiled to wasm (`contracts/ibe`), the same code the contract uses to verify openings, so a bid is encrypted on the caller's machine against the round identity, exactly as in the browser.
2. **Chain adapters.** Base Sepolia (viem): list and inspect Sablier v4 streams, approve and deposit into RoseVault, submit `executeTransfer` and `executeRelease` authorizations, call `withdrawMax`. Solana devnet: derive deposit addresses, send `transfer_recipient`, create payout nonce accounts, broadcast engine-signed transactions. NEAR: wallet connection and the NEP-141 and NEP-245 calls.
3. **Unlock math.** The piecewise-linear unlock function `f(t)` of a class from its attested schedule (start, cliff, cliff unlock, start unlock, end), in the same fixed-point 1e18 arithmetic as the contract, rounded down. Used for locked and claimable amounts, timelines and the `1 - f(ts)` conversion between prices per locked token and per unit.
4. **Clearing reference.** A reference implementation of the [clearing rules](/docs/clearing-rules) for Tender, Exit and Advance: candidate prices, `S(P)`, `D(P)`, `V(P)`, `Q(P)`, tie rules, largest-remainder rationing, rounding and fees. The "Verify" panel on each round page runs it in the browser over the opened bids and compares with the on-chain result. The contract's Rust implementation is property-tested against a brute-force reference; the SDK reference lets anyone reproduce the result outside the contract.

## How it is used

- The web app (`apps/web`) for every page in the app, including the demo wallets.
- The seed and end-to-end scripts (`scripts`) that create the demo token, streams, deposits and rounds on the three testnets.
- Anyone who wants to verify a settled round or drive a round without a browser.

## Where the facts come from

The SDK carries no addresses of its own that are not in [Contracts and addresses](/docs/contracts-and-addresses). Every external fact it depends on (addresses, versions, method names, byte layouts, gas) is verified live and recorded with the command used in `docs/verification.md` of the repository.
