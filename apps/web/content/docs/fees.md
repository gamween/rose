---
title: Fees
description: What rose charges, who pays it and when it is shown.
order: 7
section: Mechanism
---

## Protocol fee

30 bps (0.30%) of settled notional, charged to the buying side on top of the price.

- In a Tender the buyer is the issuer. The issuer's escrow at creation is the budget plus 30 bps. At settlement the fee is 30 bps of the amount actually charged for the units bought; the unspent budget is refunded.
- In an Exit the buyers pay. Each buyer's fee is 30 bps of the cash charged for their fill.
- In an Advance the funders pay. Each funder's fee is 30 bps of the cash charged for their fill.

Sellers receive the clearing price with nothing deducted.

The fee is computed on the settled notional, rounded up to the tick (0.000001 USDC), in the round's cash venue. It is shown before every bid in the bid form's fee and collateral preview, and in every receipt.

## Why 30 bps

OTC desks for locked tokens quote spreads measured in percentage points, and bilateral buybacks have no published price at all. A fee of 30 bps on a uniform, public price undercuts those spreads by an order of magnitude while still paying for the protocol.

## Fee recipient

The fee recipient is fixed when the engine is initialized and cannot be changed afterwards (the engine is keyless and has no upgrade method). Slashed bonds go to the same treasury.

## What is not a fee

- Bonds: `max(1 USDC, 1% of the bid's escrow or of its locked units valued at the round's max price)`, posted with each bid and refunded on a valid opening. Only a bid that is never opened, or that exceeds its collateral, loses its bond.
- Gas: NEAR gas for your own transactions; about 0.012 NEAR per bid for whoever opens the book after close; Base Sepolia gas for submitting a RoseVault authorization; Solana fees are paid by the engine's `gas/sol` address.
- Sablier's withdrawal fee, when Sablier's comptroller sets one, is forwarded at withdrawal time (it was 0 on Base Sepolia when measured).

## Worked numbers

| Round | Notional | Fee (30 bps) | Buyer pays in total |
|---|---|---|---|
| Tender, 100 units at 9 | 900.00 | 2.70 | 902.70 |
| Exit, 15 units at 8.50 | 127.50 | 0.3825 | 127.8825 |
| Advance, 50 claimed tokens at 10.50 | 525.00 | 1.575 | 526.575 |

These are the rounds of [Clearing rules](/docs/clearing-rules), examples 1, 4 and 6.
