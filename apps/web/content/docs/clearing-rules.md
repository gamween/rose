---
title: Clearing rules
description: The exact uniform-price rules for Tender, Exit and Advance rounds, with worked examples.
order: 4
section: Mechanism
---

## Conventions

- Prices are quoted per locked token at the round's settlement time `ts = closes_at`. The contract converts to a price per unit with the locked fraction `1 - f(ts)`: a unit of a class that is 25% unlocked at `ts` carries 0.75 locked tokens, so a price of 2.00 per locked token is 1.50 per unit.
- Prices move in ticks of 0.000001 USDC (1e-6, the cash token has 6 decimals). Quantities are token base units.
- Cash for `q` units at price `P` is `q * (1 - f(ts)) * P`. Buyers are charged this amount rounded up to the tick; sellers are paid it rounded down. The difference, at most one tick per fill, stays in the pool. Rounding never favors a trader.
- The fee is 30 bps of the settled notional (the sum of the buyers' charges), rounded up to the tick, charged to the buying side on top of the price. See [Fees](/docs/fees).
- Everything is computed on-chain from the opened bids, in one bounded `clear` transaction (a round accepts at most `MAX_BIDS_PER_ROUND = 64` orders). Ties are resolved deterministically, so the result is reproducible from the public book. The "Verify" panel on each round page does exactly that in the browser.
- In the examples below, quantities are whole units, prices are USDC per locked token, and `f(ts) = 0` (one unit carries one locked token) unless stated otherwise. Order ids are the ids assigned at submission; lower ids were submitted first.

## Fill order and rationing (all round types)

Once the clearing price `P*` is known, every eligible order is sorted by price priority, then by ascending order id: asks by ascending minimum price, bids by descending limit price. Whole price levels are filled while the cumulative quantity fits in the traded volume. The first level that does not fit is the marginal level: it is rationed pro rata with the largest-remainder method. Each order at the marginal level gets `floor(remaining * qty / level_qty)`, then the units left over go one each to the orders with the largest remainders, ties to the lower order id. Levels beyond the marginal level get nothing. Fills sum to the volume exactly and never exceed an order's quantity.

Strictly better prices therefore fill fully, level by level: every level before the marginal one fills fully, and the marginal level may itself be above `P*` for bids (or below it for asks), because `P*` usually lies inside a tie interval where no order sits. Only the marginal level is rationed, and only on the long side.

An opened order priced above the round's `max_price` (a buyer's limit or a seller's minimum) is not eligible: it takes no part in the clearing, is neither filled nor void, and its bond, escrow and locked units come back at settlement as for any unfilled order. The order form refuses such a price.

## Tender

One public buyer (the issuer) with a public `budget` and a public `max_price`; sealed asks from holders.

- Candidate prices: the submitted ask prices that are `<= max_price`.
- Supply `S(P)` = sum of the quantities of asks with price `<= P`.
- Affordable quantity at `P` = `floor(budget / cost per unit at P)`, where the cost per unit is `(1 - f(ts)) * P`. With `f(ts) = 0` this is `floor(budget / P)`.
- Volume bought at `P`: `Q(P) = min(S(P), affordable(P))`.
- `P*` = the candidate that maximizes `Q`; ties go to the lowest price.
- Asks are filled in ascending price order (then ascending id); the marginal level is rationed as above. Every filled seller receives `P*`.
- The issuer is charged `Q(P*)` units at `P*` (rounded up); the unspent budget is refunded. If `Q(P*) = 0` the Tender does not cross and the round is `Cancelled`.

Asks above `max_price` are never filled. The clearing engine is property-tested against a brute-force reference.

### Example 1: the spec example

Asks: A1 sells 100 at 9, A2 sells 10 at 10. Budget 950, max price 10.

| Candidate P | S(P) | floor(950 / P) | Q(P) |
|---|---|---|---|
| 9 | 100 | 105 | **100** |
| 10 | 110 | 95 | 95 |

`P* = 9`, 100 units bought.

| Order | Asked | Filled | Proceeds at 9 |
|---|---|---|---|
| A1 (100 at 9) | 100 | 100 | 900.00 |
| A2 (10 at 10) | 10 | 0 | 0 |

Issuer: charged 900.00, refund 50.00 of the budget, fee 30 bps of 900.00 = 2.70. Note that paying 10 would have bought fewer units (95) than paying 9, so the issuer's own objective, volume, picks the lower price.

### Example 2: a rationed marginal level

Asks: A1 sells 30 at 5, A2 sells 40 at 8, A3 sells 20 at 8. Budget 400, max price 10.

| Candidate P | S(P) | floor(400 / P) | Q(P) |
|---|---|---|---|
| 5 | 30 | 80 | 30 |
| 8 | 90 | 50 | **50** |

`P* = 8`, 50 units bought. A1 (price 5, strictly better) fills fully: 30 units. 20 units remain for the marginal level at 8, which holds 60 units.

| Order at the margin | Asked | Quota 20 x qty / 60 | Floor | Remainder | Final fill |
|---|---|---|---|---|---|
| A2 | 40 | 13.33 | 13 | 0.33 | 13 |
| A3 | 20 | 6.67 | 6 | 0.67 | 7 |

The one leftover unit goes to A3, whose remainder is larger.

| Order | Filled | Proceeds at 8 |
|---|---|---|
| A1 | 30 | 240.00 |
| A2 | 13 | 104.00 |
| A3 | 7 | 56.00 |

Issuer: charged 400.00, refund 0, fee 1.20.

## Exit

Sealed asks from holders and sealed bids from buyers.

- Demand `D(P)` = sum of bid quantities with limit `>= P`. Supply `S(P)` = sum of ask quantities with minimum `<= P`. Volume `V(P) = min(D(P), S(P))`.
- `P*` maximizes `V` over the tick axis. `D` and `S` only change at submitted prices (`D` drops one tick above each bid limit, `S` rises at each ask minimum), so the axis splits into intervals on which `(D, S)` is constant and each interval is evaluated once.
- Ties in `V` are broken by the minimal imbalance `|D - S|`, then by the midpoint of the tied interval, rounded down to a tick: `low + floor((high - low) / 2)`.
- Bids with limit `>= P*` and asks with minimum `<= P*` are eligible. The short side's eligible quantity equals `V(P*)`, so it fills fully; the long side is filled by price priority and rationed at its marginal level.
- Buyers are charged `fill * (1 - f(ts)) * P*` rounded up; sellers are paid the same rounded down. Unfilled buyer escrow is refundable. Unsold units return to their sellers.
- If no price trades a positive volume, the round is `Cancelled`.

### Example 3: a tie broken by the imbalance

Bids: B1 buys 10 at limit 10, B2 buys 5 at limit 8. Ask: A1 sells 10 at minimum 6.

| Price interval | D | S | V | abs(D - S) |
|---|---|---|---|---|
| 0.000000 to 5.999999 | 15 | 0 | 0 | 15 |
| 6.000000 to 8.000000 | 15 | 10 | **10** | 5 |
| 8.000001 to 10.000000 | 10 | 10 | **10** | **0** |
| above 10.000000 | 0 | 10 | 0 | 10 |

The volume 10 is reached on two intervals. The second has the smaller imbalance (demand equals supply once B2's limit is passed), so it is selected. Its midpoint is `8.000001 + floor(1.999999 / 2) = 9.000000`. `P* = 9`.

| Order | Eligible at 9? | Filled | Cash at 9 |
|---|---|---|---|
| B1 (10 at 10) | yes | 10 | pays 90.00 |
| B2 (5 at 8) | no | 0 | escrow refunded |
| A1 (10 at 6) | yes | 10 | receives 90.00 |

B1 also pays the fee: 30 bps of 90.00 = 0.27.

### Example 4: a tie broken by the midpoint

Bids: B1 buys 10 at limit 15, B2 buys 10 at limit 12. Ask: A1 sells 15 at minimum 5.

| Price interval | D | S | V | abs(D - S) |
|---|---|---|---|---|
| 0.000000 to 4.999999 | 20 | 0 | 0 | 20 |
| 5.000000 to 12.000000 | 20 | 15 | **15** | 5 |
| 12.000001 to 15.000000 | 10 | 15 | 10 | 5 |
| above 15.000000 | 0 | 15 | 0 | 15 |

The maximum volume 15 is reached on one interval, `[5.000000, 12.000000]`. `P*` is its midpoint: `5 + floor(7 / 2) = 8.500000`.

Supply is the short side (15 units) and fills fully. Demand (20 units) is filled by descending limit: B1 (limit 15) is a strictly better level and fills fully (10 units); 5 units remain for the marginal level at 12, where B2 asked for 10, so B2 gets 5.

| Order | Filled | Cash at 8.50 |
|---|---|---|
| B1 (10 at 15) | 10 | pays 85.00 |
| B2 (10 at 12) | 5 | pays 42.50, unused escrow refunded |
| A1 (15 at 5) | 15 | receives 127.50 |

Notional 127.50. Each buyer pays 30 bps of their own charge: B1 0.255, B2 0.1275, together 0.3825.

### Example 5: largest-remainder rationing on the long side

Bids: B1, B2 and B3 each buy 6 at limit 10. Ask: A1 sells 10 at minimum 10.

Only the single tick 10.000000 has both supply and demand: `D = 18`, `S = 10`, `V = 10`. `P* = 10`.

| Order at the margin | Wanted | Quota 10 x 6 / 18 | Floor | Remainder | Final fill | Cash at 10 |
|---|---|---|---|---|---|---|
| B1 | 6 | 3.33 | 3 | 0.33 | 4 | pays 40.00 |
| B2 | 6 | 3.33 | 3 | 0.33 | 3 | pays 30.00 |
| B3 | 6 | 3.33 | 3 | 0.33 | 3 | pays 30.00 |

Floors sum to 9, one unit is left, and all remainders are equal, so the unit goes to the lowest id, B1. A1 receives 100.00; fee 0.30.

## Advance

One holder sells a senior claim on the first `K` tokens that will unlock from `X` of their encumbered units, with `K <= X * (1 - f(ts))`. Funders submit sealed bids per claimed token.

- The holder's sealed reserve price is one ask for the `K`-token claim. Funders' bids are per claimed token.
- `P*` and the fills follow the Exit rules with that single ask: uniform price, pro rata at the margin.
- A claimed token is one whole future token, not a unit of the class, so no locked-fraction conversion applies: cash is `fill * P*`.
- Partial fill is allowed down to the holder's public minimum fill. If the volume is below the minimum, the round does not cross and is `Cancelled`.
- Winners receive lien shares in proportion to their fills. Accruals of the encumbered units flow to the lien holders until `K` tokens (or the filled part of `K`) have been delivered.

### Example 6: partial fill above the minimum

The holder encumbers units carrying at least 100 locked tokens, sets `K = 100`, a sealed reserve of 10 per claimed token and a public minimum fill of 40. Bids: B1 funds 30 at limit 12, B2 funds 20 at limit 11.

| Price interval | D | S | V | abs(D - S) |
|---|---|---|---|---|
| 0.000000 to 9.999999 | 50 | 0 | 0 | 50 |
| 10.000000 to 11.000000 | 50 | 100 | **50** | 50 |
| 11.000001 to 12.000000 | 30 | 100 | 30 | 70 |
| above 12.000000 | 0 | 100 | 0 | 100 |

`V = 50` on `[10.000000, 11.000000]`; midpoint `10.500000`. `P* = 10.50`. The volume 50 is at least the minimum fill of 40, so the round crosses with a partial fill: the holder sells a claim on 50 of the 100 tokens offered.

| Order | Filled | Cash at 10.50 | Lien share |
|---|---|---|---|
| B1 (30 at 12) | 30 | pays 315.00 | 30 / 50 |
| B2 (20 at 11) | 20 | pays 210.00 | 20 / 50 |
| Holder (claim 100, reserve 10) | 50 | receives 525.00 | |

Fee: 30 bps of 525.00 = 1.575, paid by the funders. The first 50 tokens that unlock from the encumbered units go to B1 and B2 in the ratio 30:20; then the encumbrance ends and the units are free again. With a minimum fill of 51 the same book would not cross.

## Locked fraction

### Example 7: a class that is 25% unlocked at settlement

`f(ts) = 0.25`, so every unit carries 0.75 locked tokens. Exit round. Bids: B1 buys 100 units at limit 2.00 per locked token, B2 buys 50 at 1.60. Asks: A1 sells 80 at minimum 1.20, A2 sells 60 at 1.80.

| Price interval | D | S | V | abs(D - S) |
|---|---|---|---|---|
| 0.000000 to 1.199999 | 150 | 0 | 0 | 150 |
| 1.200000 to 1.600000 | 150 | 80 | 80 | 70 |
| 1.600001 to 1.799999 | 100 | 80 | 80 | 20 |
| 1.800000 to 2.000000 | 100 | 140 | **100** | 40 |
| above 2.000000 | 0 | 140 | 0 | 140 |

`P* = 1.80 + floor(0.20 / 2) = 1.90` per locked token, which is `0.75 * 1.90 = 1.425` per unit.

Demand is the short side at 1.90 (B2's limit of 1.60 is below `P*`): B1 fills 100 units. Supply: A1 (1.20) fills fully with 80; A2 is the marginal level and gets the remaining 20 of its 60.

| Order | Filled units | Locked tokens | Cash at 1.90 per locked token |
|---|---|---|---|
| B1 (100 at 2.00) | 100 | 75 | pays 142.50 |
| B2 (50 at 1.60) | 0 | 0 | escrow refunded |
| A1 (80 at 1.20) | 80 | 60 | receives 114.00 |
| A2 (60 at 1.80) | 20 | 15 | receives 28.50 |

Notional 142.50; fee 0.4275. The buyer's units accrue from `ts`, so the 25% already unlocked on A1's and A2's units before `ts` stays with A1 and A2 as claimable tokens.

Rounding at the base unit. Take a 6-decimal token and a fill of 1.000001 tokens (1,000,001 base units) at 1.90 per locked token with 0.75 locked: the exact cash is 1.425001425 USDC. The buyer is charged 1.425002, the seller is paid 1.425001, and 0.000001 stays in the pool.

The locked fraction also changes a Tender. Rerun example 1 with `f(ts) = 0.25`: the cost per unit is 6.75 at 9 and 7.50 at 10, so the issuer affords `floor(950 / 6.75) = 140` units at 9 and `floor(950 / 7.50) = 126` at 10. `Q(9) = min(100, 140) = 100` and `Q(10) = min(110, 126) = 110`, so `P* = 10`: both asks fill fully, the issuer is charged 825.00 (A1 receives 750.00, A2 75.00), 125.00 is refunded and the fee is 2.475.

## Settlement

After `clear`, each bid is settled by its own `settle_bid` call (idempotent, callable by anyone, usually the participant when they claim); this per-bid settlement is the only pagination. Units and cash move inside the NEAR ledger. Payouts to Base or Solana are pull-based; see [Cross-chain custody](/docs/cross-chain-custody).
