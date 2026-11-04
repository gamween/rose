//! Exit and Advance: sealed bids against sealed asks at one uniform price.

use super::{
    allocate, ensure_unique_ids, priority, sum_qty, ClearingError, Fill, Order, Outcome, Pricing,
};

/// A cleared Exit or Advance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UniformClearing {
    /// Clearing price `P*` per whole token.
    pub price: u128,
    /// Quantity traded.
    pub volume: u128,
    /// One fill per bid, in input order; `cash` is charged to the buyer (rounded up), fees
    /// excluded. Unfilled escrow is refunded by the caller.
    pub bids: Vec<Fill>,
    /// One fill per ask, in input order; `cash` is paid to the seller (rounded down).
    pub asks: Vec<Fill>,
    /// Sum of the buyers' charges: the settled notional fees are computed on.
    pub notional: u128,
}

/// The holder's side of an Advance: a sealed reserve for a claim on the first `claim` tokens that
/// unlock from the encumbered units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdvanceAsk {
    /// Order id of the holder's ask.
    pub id: u64,
    /// Claim size `K` in token base units.
    pub claim: u128,
    /// Sealed reserve price per whole claimed token.
    pub reserve: u128,
    /// Public minimum fill in token base units; a smaller volume does not cross.
    pub min_fill: u128,
}

/// Clears an Exit round.
///
/// With `D(P)` the bid quantity with limit `>= P`, `S(P)` the ask quantity with minimum `<= P`
/// and `V(P) = min(D(P), S(P))`, the clearing price maximizes `V`; ties go to the smallest
/// `|D - S|`, then to the midpoint of the tied price interval rounded down to a tick. That
/// interval is always contiguous because `D` is non-increasing and `S` non-decreasing.
///
/// Fill rule at `P*`: bids with limit `>= P*` and asks with minimum `<= P*` are eligible. Each
/// side is ordered by price priority (bids by descending limit, asks by ascending minimum, then
/// ascending id) and filled with `V(P*)` units: whole price levels fill while the cumulative
/// quantity stays within `V(P*)`, the first level that does not fit is rationed pro rata by
/// largest remainder (ties to the lower id), later levels get nothing. The short side's eligible
/// quantity equals `V(P*)`, so it fills fully; only the long side is rationed.
pub fn exit(
    bids: &[Order],
    asks: &[Order],
    pricing: Pricing,
) -> Result<Outcome<UniformClearing>, ClearingError> {
    clear(bids, asks, pricing, 1)
}

/// Clears an Advance round.
///
/// The holder's reserve is a single ask of `claim` tokens; funders bid per claimed token. The
/// price and fills follow [`exit`] with that one ask; the holder may be filled partially, but a
/// volume below `min_fill` does not cross. Cash is `qty * P / 10^decimals`: a claimed token is a
/// whole future token rather than a unit of the class, so the locked fraction does not apply.
pub fn advance(
    ask: AdvanceAsk,
    bids: &[Order],
    token_decimals: u8,
) -> Result<Outcome<UniformClearing>, ClearingError> {
    if ask.min_fill > ask.claim {
        return Err(ClearingError::MinFillAboveClaim);
    }
    let asks = [Order {
        id: ask.id,
        qty: ask.claim,
        price: ask.reserve,
    }];
    clear(
        bids,
        &asks,
        Pricing::per_claimed_token(token_decimals),
        ask.min_fill.max(1),
    )
}

fn clear(
    bids: &[Order],
    asks: &[Order],
    pricing: Pricing,
    min_volume: u128,
) -> Result<Outcome<UniformClearing>, ClearingError> {
    pricing.validate()?;
    ensure_unique_ids(bids)?;
    ensure_unique_ids(asks)?;

    let bid_priority = priority(bids, |a, b| b.cmp(a));
    let ask_priority = priority(asks, u128::cmp);
    let (price, volume) = match crossing(bids, &bid_priority, asks, &ask_priority)? {
        Some((price, volume)) if volume >= min_volume => (price, volume),
        _ => return Ok(Outcome::NoCrossing),
    };

    let eligible_bids = bid_priority
        .iter()
        .take_while(|&&i| bids[i].price >= price)
        .count();
    let eligible_asks = ask_priority
        .iter()
        .take_while(|&&i| asks[i].price <= price)
        .count();
    let mut bid_fills = vec![0u128; bids.len()];
    let mut ask_fills = vec![0u128; asks.len()];
    allocate(bids, &bid_priority[..eligible_bids], volume, &mut bid_fills)?;
    allocate(asks, &ask_priority[..eligible_asks], volume, &mut ask_fills)?;

    let bids = fills(bids, bid_fills, |qty| pricing.charge(qty, price))?;
    let asks = fills(asks, ask_fills, |qty| pricing.payout(qty, price))?;
    let notional = bids.iter().try_fold(0u128, |sum, fill| {
        sum.checked_add(fill.cash)
            .ok_or(ClearingError::QuantityOverflow)
    })?;

    Ok(Outcome::Cleared(UniformClearing {
        price,
        volume,
        bids,
        asks,
        notional,
    }))
}

/// Finds `(P*, V(P*))`, or `None` when no price trades a positive volume.
///
/// `D` and `S` only change at ask minimums `m` (where `S` rises) and at `limit + 1` for every
/// bid limit (where `D` falls). Those breakpoints, plus `0`, split the tick axis into segments of
/// constant `(D, S)`; the sweep evaluates each segment once and widens the tied interval over
/// consecutive optimal segments.
fn crossing(
    bids: &[Order],
    bid_priority: &[usize],
    asks: &[Order],
    ask_priority: &[usize],
) -> Result<Option<(u128, u128)>, ClearingError> {
    let mut breakpoints: Vec<u128> =
        Vec::with_capacity(bid_priority.len() + ask_priority.len() + 1);
    breakpoints.push(0);
    breakpoints.extend(ask_priority.iter().map(|&i| asks[i].price));
    breakpoints.extend(
        bid_priority
            .iter()
            .filter_map(|&i| bids[i].price.checked_add(1)),
    );
    breakpoints.sort_unstable();
    breakpoints.dedup();

    let mut demand = sum_qty(bids, bid_priority)?;
    // Checking the full supply once keeps every partial sum of the sweep in range.
    sum_qty(asks, ask_priority)?;
    let mut supply = 0u128;
    // Bids by ascending limit, so the sweep can drop them as the price passes their limit.
    let mut bids_ascending = bid_priority.iter().rev().peekable();
    let mut asks_ascending = ask_priority.iter().peekable();
    let mut best: Option<(u128, u128, u128, u128)> = None;

    for (k, &low) in breakpoints.iter().enumerate() {
        while let Some(&&i) = asks_ascending.peek() {
            if asks[i].price > low {
                break;
            }
            supply += asks[i].qty;
            asks_ascending.next();
        }
        while let Some(&&i) = bids_ascending.peek() {
            if bids[i].price >= low {
                break;
            }
            demand -= bids[i].qty;
            bids_ascending.next();
        }
        let high = breakpoints.get(k + 1).map_or(u128::MAX, |next| next - 1);
        let volume = demand.min(supply);
        let gap = demand.abs_diff(supply);
        best = match best {
            Some((best_volume, best_gap, tie_low, _))
                if volume == best_volume && gap == best_gap =>
            {
                Some((best_volume, best_gap, tie_low, high))
            }
            Some((best_volume, best_gap, _, _))
                if volume < best_volume || (volume == best_volume && gap > best_gap) =>
            {
                best
            }
            _ => Some((volume, gap, low, high)),
        };
    }

    Ok(best
        .filter(|&(volume, _, _, _)| volume > 0)
        .map(|(volume, _, low, high)| (low + (high - low) / 2, volume)))
}

fn fills(
    orders: &[Order],
    quantities: Vec<u128>,
    cash: impl Fn(u128) -> Result<u128, ClearingError>,
) -> Result<Vec<Fill>, ClearingError> {
    orders
        .iter()
        .zip(quantities)
        .map(|(order, qty)| {
            Ok(Fill {
                id: order.id,
                qty,
                cash: cash(qty)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::ONE;

    const UNIT: Pricing = Pricing {
        locked_fraction_e18: ONE,
        token_decimals: 0,
    };

    fn order(id: u64, qty: u128, price: u128) -> Order {
        Order { id, qty, price }
    }

    fn cleared(outcome: Outcome<UniformClearing>) -> UniformClearing {
        match outcome {
            Outcome::Cleared(clearing) => clearing,
            Outcome::NoCrossing => panic!("expected a crossing"),
        }
    }

    fn quantities(fills: &[Fill]) -> Vec<u128> {
        fills.iter().map(|fill| fill.qty).collect()
    }

    #[test]
    fn exit_picks_the_midpoint_of_the_tied_interval() {
        // D = 20 up to 12, S = 15 from 5: V = 15 and |D - S| = 5 on [5, 12], P* = 8.
        let bids = [order(1, 10, 15), order(2, 10, 12)];
        let asks = [order(1, 15, 5)];
        let result = cleared(exit(&bids, &asks, UNIT).expect("clears"));
        assert_eq!(result.price, 8);
        assert_eq!(result.volume, 15);
        assert_eq!(quantities(&result.bids), vec![10, 5]);
        assert_eq!(quantities(&result.asks), vec![15]);
        assert_eq!(result.notional, 120);
        assert_eq!(result.asks[0].cash, 120);
    }

    #[test]
    fn exit_prefers_the_smallest_imbalance() {
        // V = 10 on [6, 10]; |D - S| is 5 on [6, 7] and 10 on [8, 10]: P* = 6.
        let bids = [order(1, 10, 10), order(2, 5, 7)];
        let asks = [order(1, 10, 6), order(2, 10, 8)];
        let result = cleared(exit(&bids, &asks, UNIT).expect("clears"));
        assert_eq!(result.price, 6);
        assert_eq!(result.volume, 10);
        assert_eq!(quantities(&result.bids), vec![10, 0]);
        assert_eq!(quantities(&result.asks), vec![10, 0]);
    }

    #[test]
    fn exit_rations_the_long_side_at_the_margin() {
        let bids = [order(1, 6, 10), order(2, 6, 10), order(3, 6, 10)];
        let asks = [order(1, 10, 10)];
        let result = cleared(exit(&bids, &asks, UNIT).expect("clears"));
        assert_eq!(result.price, 10);
        assert_eq!(result.volume, 10);
        // Quotas 3.33 each: floors 3, 3, 3 and the extra unit to the lowest id.
        assert_eq!(quantities(&result.bids), vec![4, 3, 3]);
    }

    #[test]
    fn exit_without_overlap_does_not_cross() {
        let bids = [order(1, 10, 4)];
        let asks = [order(1, 10, 5)];
        assert_eq!(exit(&bids, &asks, UNIT), Ok(Outcome::NoCrossing));
        assert_eq!(exit(&[], &asks, UNIT), Ok(Outcome::NoCrossing));
    }

    #[test]
    fn exit_handles_extreme_limits() {
        let bids = [order(1, 1, u128::MAX)];
        let asks = [order(1, 1, u128::MAX)];
        let result = cleared(exit(&bids, &asks, Pricing::per_claimed_token(38)).expect("clears"));
        assert_eq!(result.price, u128::MAX);
        assert_eq!(result.volume, 1);
    }

    #[test]
    fn overflowing_quantities_are_rejected() {
        let bids = [order(1, 1, 5)];
        let asks = [order(1, u128::MAX, 5), order(2, 1, 6)];
        assert_eq!(
            exit(&bids, &asks, UNIT),
            Err(ClearingError::QuantityOverflow)
        );
        assert_eq!(
            exit(&asks, &bids, UNIT),
            Err(ClearingError::QuantityOverflow)
        );
    }

    #[test]
    fn advance_fills_partially_down_to_min_fill() {
        let ask = AdvanceAsk {
            id: 7,
            claim: 100,
            reserve: 10,
            min_fill: 40,
        };
        let bids = [order(1, 30, 12), order(2, 20, 11)];
        let result = cleared(advance(ask, &bids, 0).expect("clears"));
        // D = 50 on [10, 11], S = 100: V = 50 on [10, 11], P* = 10.
        assert_eq!(result.price, 10);
        assert_eq!(result.volume, 50);
        assert_eq!(
            result.asks,
            vec![Fill {
                id: 7,
                qty: 50,
                cash: 500
            }]
        );
        assert_eq!(result.notional, 500);

        let strict = AdvanceAsk {
            min_fill: 51,
            ..ask
        };
        assert_eq!(advance(strict, &bids, 0), Ok(Outcome::NoCrossing));
        let invalid = AdvanceAsk {
            min_fill: 101,
            ..ask
        };
        assert_eq!(
            advance(invalid, &bids, 0),
            Err(ClearingError::MinFillAboveClaim)
        );
    }

    #[test]
    fn advance_cash_ignores_the_locked_fraction() {
        let ask = AdvanceAsk {
            id: 1,
            claim: 5 * ONE,
            reserve: 1_000_000,
            min_fill: 0,
        };
        let bids = [order(1, 5 * ONE, 1_000_000)];
        let result = cleared(advance(ask, &bids, 18).expect("clears"));
        assert_eq!(result.price, 1_000_000);
        assert_eq!(result.bids[0].cash, 5_000_000);
    }
}
