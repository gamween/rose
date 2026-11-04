---
title: Concepts
description: Classes, positions, units, the unlock function, accrual accounting and the three round types.
order: 2
section: Introduction
---

## Class

A class is a set of positions that are economically identical: same chain, same protocol, same token, same normalized unlock schedule, non-cancelable. Usually a class is one cohort of one sale (same start, cliff, end). Positions in a class are fungible. That fungibility is what allows N sellers against M buyers at one price.

The class id is the hex SHA-256 of the borsh-encoded normalized schedule, chain and token, so the same economic position always maps to the same class.

## Position

A position is one locked allocation on a foreign chain, held by rose's vault on that chain. Supported in v1:

- Sablier Lockup v4 streams on Base Sepolia. ERC-721, Lockup Linear model only. The stream must have been created `transferable = true`, must be non-cancelable or renounced, and must not be depleted. Dynamic, Tranched and Price-Gated streams are refused.
- Streamflow streams on Solana devnet, where `transfer_recipient` is allowed for the recipient.

Cancelable positions are rejected on both chains: a position that the sender can cancel is not a reliable claim.

## Unit

A unit is one allocation unit of a class: a claim on one token of the class schedule. A holder who deposits a position with allocation `D` receives `D` units. Units are NEP-245 multi-tokens on NEAR; the token id is the class id. They are transferable and composable, while the underlying stream never moves.

## Unlock function

Each class has a deterministic unlock function `f(t)` in `[0, 1]`: the fraction of the allocation unlocked at time `t`. It is piecewise linear, built from the attested schedule (start, cliff, cliff unlock amount, start unlock amount, end), stored as fixed point with 1e18 precision and rounded down.

- A unit's accrued entitlement between two times is `f(t2) - f(t1)` tokens.
- Locked tokens per unit at time `t` are `1 - f(t)`.

Prices in rounds are quoted per locked token, so `1 - f(ts)` at the round's settlement time `ts` is the conversion between a price per locked token and a price per unit. See [Clearing rules](/docs/clearing-rules).

## Accrual accounting

Every account holds `(balance, checkpoint, claimable)` per class. On every balance change (mint, `mt_transfer`, `mt_transfer_call` refund, lock into a round, settlement, burn) the contract first accrues `balance * (f(now) - checkpoint)` into `claimable`, then sets `checkpoint = f(now)`.

- Units locked in a round keep accruing to the seller until `ts = closes_at`.
- Sold units accrue to the buyer from `ts`.
- Unsold units return to the seller with their accrual.

All amounts use 256-bit arithmetic. Rounding always favors the pool: dust stays in the vault rather than being paid out twice.

## Round

A round is a sealed auction over units of one class. There are three types.

### Tender

One public buyer (the issuer) with a public budget and a public max price; sealed asks from any number of holders. Units bought are retired: their unlocked tokens go to the issuer's chosen address or to a burn address. This is the crypto equivalent of a modified Dutch auction tender offer.

### Exit

Sealed asks from any number of holders of the class, sealed bids from any number of buyers. One uniform price at the intersection of supply and demand. Buyers receive units that inherit the exact schedule.

### Advance

One holder sells a senior claim on the first `K` tokens that will unlock from `X` of their units, with `K <= X * (1 - f(ts))`. Funders submit sealed bids per claimed token. Winners receive lien shares. Accruals of the encumbered units flow to lien holders until `K` tokens have been delivered, then the encumbrance ends. Encumbered units are non-transferable and cannot enter other rounds. There is no oracle and no liquidation: the lien is repaid by the schedule itself.

## Clearing prices

Every settled round publishes its clearing price per locked token, its remaining lock duration and its volume. The Prices page (`/app/prices`) shows the history per class and price versus remaining lock time across classes of the same token.

There is no spot oracle on testnet, so no implied discount is computed on-chain. When an issuer declares a public reference price for a Tender, the page shows the discount to that declared reference, labeled as such.

## Cash venue

Each round declares exactly one cash venue at creation: NEAR tUSDC, or Base USDC held by RoseVault. All escrows, bonds, fees and seller proceeds of that round live in that venue and are claimable only there. The bid form shows the venue.
