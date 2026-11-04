//! Property tests of the clearing engine against brute-force references that scan every tick.

use proptest::prelude::*;
use rose_engine::clearing::{
    advance, exit, tender, AdvanceAsk, Fill, Order, Outcome, Pricing, TenderClearing,
    UniformClearing,
};
use rose_engine::math::ONE;

const UNIT: Pricing = Pricing {
    locked_fraction_e18: ONE,
    token_decimals: 0,
};

/// Brute-force arithmetic on small numbers, written independently of `Pricing`.
fn cash_brute(qty: u128, price: u128, pricing: Pricing, round_up: bool) -> u128 {
    let numerator = qty * pricing.locked_fraction_e18 * price;
    let denominator = ONE * 10u128.pow(u32::from(pricing.token_decimals));
    if round_up {
        numerator.div_ceil(denominator)
    } else {
        numerator / denominator
    }
}

fn affordable_brute(budget: u128, price: u128, pricing: Pricing) -> u128 {
    if pricing.locked_fraction_e18 == 0 || price == 0 {
        return u128::MAX;
    }
    budget * ONE * 10u128.pow(u32::from(pricing.token_decimals))
        / (pricing.locked_fraction_e18 * price)
}

/// Largest remainder by repeated selection: floors first, then one extra unit at a time to the
/// order with the largest remainder that has not received one yet, ties to the lower id.
fn hamilton_brute(orders: &[Order], level: &[usize], amount: u128, fills: &mut [u128]) {
    let total: u128 = level.iter().map(|&i| orders[i].qty).sum();
    let mut bumped = vec![false; orders.len()];
    let mut given = 0;
    for &i in level {
        fills[i] = amount * orders[i].qty / total;
        given += fills[i];
    }
    for _ in given..amount {
        let mut pick: Option<usize> = None;
        for &i in level {
            if bumped[i] {
                continue;
            }
            let remainder = amount * orders[i].qty % total;
            pick = match pick {
                Some(j) => {
                    let current = amount * orders[j].qty % total;
                    if remainder > current || (remainder == current && orders[i].id < orders[j].id)
                    {
                        Some(i)
                    } else {
                        Some(j)
                    }
                }
                None => Some(i),
            };
        }
        let pick = pick.expect("a level has enough orders to place every leftover unit");
        bumped[pick] = true;
        fills[pick] += 1;
    }
}

/// Fills `target` by walking the ticks in priority order, one price level per tick.
fn allocate_brute(orders: &[Order], ticks: impl Iterator<Item = u128>, target: u128) -> Vec<u128> {
    let mut fills = vec![0; orders.len()];
    let mut remaining = target;
    for tick in ticks {
        if remaining == 0 {
            break;
        }
        let level: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].price == tick && orders[i].qty > 0)
            .collect();
        let total: u128 = level.iter().map(|&i| orders[i].qty).sum();
        if total == 0 {
            continue;
        }
        if total <= remaining {
            for &i in &level {
                fills[i] = orders[i].qty;
            }
            remaining -= total;
        } else {
            hamilton_brute(orders, &level, remaining, &mut fills);
            remaining = 0;
        }
    }
    assert_eq!(remaining, 0, "the eligible side always covers the volume");
    fills
}

struct BruteResult {
    price: u128,
    volume: u128,
    buyer_fills: Vec<u128>,
    seller_fills: Vec<u128>,
}

fn brute_tender(
    asks: &[Order],
    budget: u128,
    max_price: u128,
    pricing: Pricing,
) -> Option<BruteResult> {
    let mut best: Option<(u128, u128)> = None;
    let mut best_any_tick = 0;
    for tick in 0..=max_price {
        let supply: u128 = asks
            .iter()
            .filter(|ask| ask.price <= tick)
            .map(|ask| ask.qty)
            .sum();
        let volume = supply.min(affordable_brute(budget, tick, pricing));
        best_any_tick = best_any_tick.max(volume);
        let candidate = asks.iter().any(|ask| ask.price == tick);
        if candidate && best.is_none_or(|(_, best_volume)| volume > best_volume) {
            best = Some((tick, volume));
        }
    }
    let (price, volume) = best?;
    assert_eq!(
        volume, best_any_tick,
        "the optimum is always at a candidate"
    );
    if volume == 0 {
        return None;
    }
    Some(BruteResult {
        price,
        volume,
        buyer_fills: Vec::new(),
        seller_fills: allocate_brute(asks, 0..=price, volume),
    })
}

fn brute_uniform(bids: &[Order], asks: &[Order], min_volume: u128) -> Option<BruteResult> {
    let top = bids
        .iter()
        .chain(asks)
        .map(|order| order.price)
        .max()
        .unwrap_or(0)
        + 1;
    let curve: Vec<(u128, u128)> = (0..=top)
        .map(|tick| {
            let demand: u128 = bids
                .iter()
                .filter(|bid| bid.price >= tick)
                .map(|bid| bid.qty)
                .sum();
            let supply: u128 = asks
                .iter()
                .filter(|ask| ask.price <= tick)
                .map(|ask| ask.qty)
                .sum();
            (demand.min(supply), demand.abs_diff(supply))
        })
        .collect();
    let volume = curve.iter().map(|&(volume, _)| volume).max()?;
    if volume == 0 || volume < min_volume {
        return None;
    }
    let gap = curve
        .iter()
        .filter(|&&(v, _)| v == volume)
        .map(|&(_, gap)| gap)
        .min()?;
    let optimal: Vec<u128> = (0..=top)
        .filter(|&tick| curve[tick as usize] == (volume, gap))
        .collect();
    let low = optimal[0];
    let high = optimal[optimal.len() - 1];
    assert_eq!(
        high - low + 1,
        optimal.len() as u128,
        "the tied interval is contiguous"
    );
    let price = low + (high - low) / 2;
    Some(BruteResult {
        price,
        volume,
        buyer_fills: allocate_brute(bids, (price..=top).rev(), volume),
        seller_fills: allocate_brute(asks, 0..=price, volume),
    })
}

fn quantities(fills: &[Fill]) -> Vec<u128> {
    fills.iter().map(|fill| fill.qty).collect()
}

/// Structural checks of one side: fills within quantities, only eligible orders filled, strict
/// price priority, a single marginal level, and largest-remainder precision on it.
fn check_side(
    orders: &[Order],
    fills: &[Fill],
    volume: u128,
    eligible: impl Fn(u128) -> bool,
    strictly_better: impl Fn(u128, u128) -> bool,
) {
    assert_eq!(orders.len(), fills.len());
    let mut total = 0;
    for (order, fill) in orders.iter().zip(fills) {
        assert_eq!(order.id, fill.id);
        assert!(fill.qty <= order.qty);
        if fill.qty > 0 {
            assert!(eligible(order.price), "filled order priced through P*");
        }
        total += fill.qty;
    }
    assert_eq!(total, volume, "fills conserve the volume");

    for (a, fill_a) in orders.iter().zip(fills) {
        for (b, fill_b) in orders.iter().zip(fills) {
            if strictly_better(a.price, b.price) && fill_b.qty > 0 {
                assert_eq!(fill_a.qty, a.qty, "a better price is filled first");
            }
        }
    }

    let eligible_qty: u128 = orders
        .iter()
        .filter(|order| eligible(order.price))
        .map(|order| order.qty)
        .sum();
    let partial: Vec<usize> = (0..orders.len())
        .filter(|&i| fills[i].qty < orders[i].qty && eligible(orders[i].price))
        .filter(|&i| orders[i].qty > 0)
        .collect();
    if eligible_qty == volume {
        assert!(partial.is_empty(), "the short side fills fully");
        return;
    }
    let margin = partial.iter().map(|&i| orders[i].price).find(|&price| {
        orders
            .iter()
            .zip(fills)
            .any(|(order, fill)| order.price == price && fill.qty > 0)
    });
    if let Some(price) = margin {
        let level: Vec<usize> = (0..orders.len())
            .filter(|&i| orders[i].price == price)
            .collect();
        let level_qty: u128 = level.iter().map(|&i| orders[i].qty).sum();
        let amount: u128 = level.iter().map(|&i| fills[i].qty).sum();
        for &i in &level {
            let floor = amount * orders[i].qty / level_qty;
            assert!(fills[i].qty == floor || fills[i].qty == floor + 1);
        }
    }
}

fn book(max_len: usize, max_price: u128) -> impl Strategy<Value = Vec<Order>> {
    prop::collection::vec((0u128..60, 0u128..max_price), 0..max_len)
        .prop_flat_map(|raw| {
            let ids: Vec<u64> = (0..raw.len() as u64).collect();
            (Just(raw), Just(ids).prop_shuffle())
        })
        .prop_map(|(raw, ids)| {
            raw.into_iter()
                .zip(ids)
                .map(|((qty, price), id)| Order {
                    id: id * 3 + 1,
                    qty,
                    price,
                })
                .collect()
        })
}

fn pricing() -> impl Strategy<Value = Pricing> {
    prop_oneof![
        3 => Just(UNIT),
        1 => Just(Pricing { locked_fraction_e18: 0, token_decimals: 0 }),
        4 => (1u128..=ONE, 0u8..=6).prop_map(|(locked_fraction_e18, token_decimals)| Pricing {
            locked_fraction_e18,
            token_decimals,
        }),
    ]
}

fn tender_cleared(outcome: Outcome<TenderClearing>) -> Option<TenderClearing> {
    match outcome {
        Outcome::Cleared(clearing) => Some(clearing),
        Outcome::NoCrossing => None,
    }
}

fn uniform_cleared(outcome: Outcome<UniformClearing>) -> Option<UniformClearing> {
    match outcome {
        Outcome::Cleared(clearing) => Some(clearing),
        Outcome::NoCrossing => None,
    }
}

fn check_uniform_cash(result: &UniformClearing, bids: &[Order], pricing: Pricing) {
    for (bid, fill) in bids.iter().zip(&result.bids) {
        assert_eq!(fill.cash, cash_brute(fill.qty, result.price, pricing, true));
        assert!(fill.cash <= cash_brute(bid.qty, bid.price, pricing, true));
    }
    for fill in &result.asks {
        assert_eq!(
            fill.cash,
            cash_brute(fill.qty, result.price, pricing, false)
        );
    }
    let charged: u128 = result.bids.iter().map(|fill| fill.cash).sum();
    let paid: u128 = result.asks.iter().map(|fill| fill.cash).sum();
    assert_eq!(result.notional, charged);
    assert!(paid <= charged, "dust stays in the pool");
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2_000))]

    #[test]
    fn tender_matches_brute_force(
        asks in book(9, 16),
        budget in 0u128..1_500,
        max_price in 0u128..18,
        pricing in pricing(),
    ) {
        let efficient = tender_cleared(tender(&asks, budget, max_price, pricing).unwrap());
        let brute = brute_tender(&asks, budget, max_price, pricing);
        match (efficient, brute) {
            (None, None) => {}
            (Some(result), Some(reference)) => {
                prop_assert_eq!(result.price, reference.price);
                prop_assert_eq!(result.volume, reference.volume);
                prop_assert_eq!(quantities(&result.asks), reference.seller_fills);
                prop_assert!(result.price <= max_price);
                prop_assert!(asks.iter().any(|ask| ask.price == result.price));
                check_side(&asks, &result.asks, result.volume, |p| p <= result.price, |a, b| a < b);
                prop_assert_eq!(result.charged, cash_brute(result.volume, result.price, pricing, true));
                prop_assert!(result.charged <= budget, "budget never exceeded");
                prop_assert_eq!(result.refund, budget - result.charged);
                let paid: u128 = result.asks.iter().map(|fill| fill.cash).sum();
                prop_assert!(paid <= result.charged);
                for fill in &result.asks {
                    prop_assert_eq!(fill.cash, cash_brute(fill.qty, result.price, pricing, false));
                }
            }
            (efficient, brute) => prop_assert!(
                false,
                "crossing mismatch: efficient {:?}, brute {:?}",
                efficient.map(|r| r.price),
                brute.map(|r| r.price)
            ),
        }
    }

    #[test]
    fn exit_matches_brute_force(
        bids in book(9, 16),
        asks in book(9, 16),
        pricing in pricing(),
    ) {
        let efficient = uniform_cleared(exit(&bids, &asks, pricing).unwrap());
        let brute = brute_uniform(&bids, &asks, 1);
        match (efficient, brute) {
            (None, None) => {}
            (Some(result), Some(reference)) => {
                prop_assert_eq!(result.price, reference.price);
                prop_assert_eq!(result.volume, reference.volume);
                prop_assert_eq!(quantities(&result.bids), reference.buyer_fills);
                prop_assert_eq!(quantities(&result.asks), reference.seller_fills);
                check_side(&bids, &result.bids, result.volume, |p| p >= result.price, |a, b| a > b);
                check_side(&asks, &result.asks, result.volume, |p| p <= result.price, |a, b| a < b);
                check_uniform_cash(&result, &bids, pricing);
            }
            (efficient, brute) => prop_assert!(
                false,
                "crossing mismatch: efficient {:?}, brute {:?}",
                efficient.map(|r| r.price),
                brute.map(|r| r.price)
            ),
        }
    }

    #[test]
    fn advance_matches_brute_force(
        bids in book(9, 16),
        claim in 1u128..200,
        reserve in 0u128..16,
        min_fill_share in 0u128..=100,
        token_decimals in 0u8..=3,
    ) {
        let min_fill = claim * min_fill_share / 100;
        let ask = AdvanceAsk { id: 42, claim, reserve, min_fill };
        let pricing = Pricing::per_claimed_token(token_decimals);
        let efficient = uniform_cleared(advance(ask, &bids, token_decimals).unwrap());
        let asks = [Order { id: 42, qty: claim, price: reserve }];
        let brute = brute_uniform(&bids, &asks, min_fill.max(1));
        match (efficient, brute) {
            (None, None) => {}
            (Some(result), Some(reference)) => {
                prop_assert_eq!(result.price, reference.price);
                prop_assert_eq!(result.volume, reference.volume);
                prop_assert_eq!(quantities(&result.bids), reference.buyer_fills);
                prop_assert_eq!(quantities(&result.asks), reference.seller_fills);
                prop_assert!(result.volume >= min_fill && result.volume <= claim);
                prop_assert!(result.price >= reserve);
                check_side(&bids, &result.bids, result.volume, |p| p >= result.price, |a, b| a > b);
                check_uniform_cash(&result, &bids, pricing);
            }
            (efficient, brute) => prop_assert!(
                false,
                "crossing mismatch: efficient {:?}, brute {:?}",
                efficient.map(|r| r.price),
                brute.map(|r| r.price)
            ),
        }
    }

    #[test]
    fn tender_invariants_hold_at_realistic_scale(
        raw in prop::collection::vec((0u128..1_000_000_000_000_000_000_000_000, 1u128..10_000_000), 1..64),
        budget in 0u128..1_000_000_000_000_000,
        max_price in 1u128..10_000_000,
        locked_fraction_e18 in 1u128..=ONE,
        token_decimals in 0u8..=18,
    ) {
        let asks: Vec<Order> = raw
            .iter()
            .enumerate()
            .map(|(i, &(qty, price))| Order { id: i as u64, qty, price })
            .collect();
        let pricing = Pricing { locked_fraction_e18, token_decimals };
        if let Some(result) = tender_cleared(tender(&asks, budget, max_price, pricing).unwrap()) {
            prop_assert!(result.price <= max_price);
            prop_assert!(result.charged <= budget);
            prop_assert_eq!(result.refund + result.charged, budget);
            prop_assert!(result.volume <= pricing.affordable(budget, result.price).unwrap());
            let filled: u128 = result.asks.iter().map(|fill| fill.qty).sum();
            prop_assert_eq!(filled, result.volume);
            let paid: u128 = result.asks.iter().map(|fill| fill.cash).sum();
            prop_assert!(paid <= result.charged);
            for (ask, fill) in asks.iter().zip(&result.asks) {
                prop_assert!(fill.qty <= ask.qty);
                prop_assert!(fill.qty == 0 || ask.price <= result.price);
            }
        }
    }

    #[test]
    fn exit_invariants_hold_at_realistic_scale(
        raw_bids in prop::collection::vec((0u128..1_000_000_000_000_000_000_000_000, 1u128..10_000_000), 0..32),
        raw_asks in prop::collection::vec((0u128..1_000_000_000_000_000_000_000_000, 1u128..10_000_000), 0..32),
        locked_fraction_e18 in 1u128..=ONE,
        token_decimals in 0u8..=18,
    ) {
        let to_orders = |raw: &[(u128, u128)]| -> Vec<Order> {
            raw.iter()
                .enumerate()
                .map(|(i, &(qty, price))| Order { id: i as u64, qty, price })
                .collect()
        };
        let bids = to_orders(&raw_bids);
        let asks = to_orders(&raw_asks);
        let pricing = Pricing { locked_fraction_e18, token_decimals };
        if let Some(result) = uniform_cleared(exit(&bids, &asks, pricing).unwrap()) {
            let bought: u128 = result.bids.iter().map(|fill| fill.qty).sum();
            let sold: u128 = result.asks.iter().map(|fill| fill.qty).sum();
            prop_assert_eq!(bought, result.volume);
            prop_assert_eq!(sold, result.volume);
            let paid: u128 = result.asks.iter().map(|fill| fill.cash).sum();
            prop_assert!(paid <= result.notional);
            for (bid, fill) in bids.iter().zip(&result.bids) {
                prop_assert!(fill.qty <= bid.qty);
                prop_assert!(fill.qty == 0 || bid.price >= result.price);
                prop_assert!(fill.cash <= pricing.charge(bid.qty, bid.price).unwrap());
            }
            for (ask, fill) in asks.iter().zip(&result.asks) {
                prop_assert!(fill.qty <= ask.qty);
                prop_assert!(fill.qty == 0 || ask.price <= result.price);
            }
        }
    }
}
