//! Tender: one public buyer (the issuer) with a public budget and max price, sealed asks.

use super::{
    allocate, ensure_unique_ids, priority, sum_qty, ClearingError, Fill, Order, Outcome, Pricing,
};

/// A cleared Tender.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TenderClearing {
    /// Clearing price `P*` per whole locked token, paid to every filled seller.
    pub price: u128,
    /// Units bought.
    pub volume: u128,
    /// One fill per ask, in input order; `cash` is the seller's proceeds (rounded down).
    pub asks: Vec<Fill>,
    /// Cash charged to the issuer for the whole volume (rounded up). This is the notional the
    /// fee is computed on.
    pub charged: u128,
    /// Unspent budget refunded to the issuer, `budget - charged` (fees excluded).
    pub refund: u128,
}

/// Clears a Tender.
///
/// Candidate prices are the submitted ask prices `<= max_price`. With `S(P)` the quantity asked
/// at or below `P` and `Q(P) = min(S(P), affordable(budget, P))`, the clearing price `P*` is the
/// candidate maximizing `Q`, ties to the lowest price. Asks fill in ascending price order (then
/// ascending id); the marginal price level is rationed pro rata; every filled seller receives
/// `P*`. If `Q(P*) == 0` the Tender does not cross. Asks above `max_price` and asks of zero
/// quantity are never filled.
pub fn tender(
    asks: &[Order],
    budget: u128,
    max_price: u128,
    pricing: Pricing,
) -> Result<Outcome<TenderClearing>, ClearingError> {
    pricing.validate()?;
    ensure_unique_ids(asks)?;

    let mut eligible = priority(asks, u128::cmp);
    eligible.retain(|&i| asks[i].price <= max_price);

    let mut best: Option<(u128, u128, usize)> = None;
    let mut supply = 0u128;
    let mut start = 0;
    while start < eligible.len() {
        let price = asks[eligible[start]].price;
        let end = start
            + eligible[start..]
                .iter()
                .take_while(|&&i| asks[i].price == price)
                .count();
        supply = supply
            .checked_add(sum_qty(asks, &eligible[start..end])?)
            .ok_or(ClearingError::QuantityOverflow)?;
        let volume = supply.min(pricing.affordable(budget, price)?);
        if best.is_none_or(|(best_volume, _, _)| volume > best_volume) {
            best = Some((volume, price, end));
        }
        start = end;
    }

    let Some((volume, price, filled_prefix)) = best.filter(|&(volume, _, _)| volume > 0) else {
        return Ok(Outcome::NoCrossing);
    };

    let mut fills = vec![0u128; asks.len()];
    allocate(asks, &eligible[..filled_prefix], volume, &mut fills)?;

    let charged = pricing.charge(volume, price)?;
    let refund = budget
        .checked_sub(charged)
        .ok_or(ClearingError::BudgetExceeded)?;
    let asks = asks
        .iter()
        .zip(fills)
        .map(|(ask, qty)| {
            Ok(Fill {
                id: ask.id,
                qty,
                cash: pricing.payout(qty, price)?,
            })
        })
        .collect::<Result<Vec<_>, ClearingError>>()?;

    Ok(Outcome::Cleared(TenderClearing {
        price,
        volume,
        asks,
        charged,
        refund,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::ONE;

    const UNIT: Pricing = Pricing {
        locked_fraction_e18: ONE,
        token_decimals: 0,
    };

    fn ask(id: u64, qty: u128, price: u128) -> Order {
        Order { id, qty, price }
    }

    fn cleared(outcome: Outcome<TenderClearing>) -> TenderClearing {
        match outcome {
            Outcome::Cleared(clearing) => clearing,
            Outcome::NoCrossing => panic!("expected a crossing"),
        }
    }

    #[test]
    fn spec_example() {
        let asks = [ask(1, 100, 9), ask(2, 10, 10)];
        let result = cleared(tender(&asks, 950, 10, UNIT).expect("clears"));
        assert_eq!(result.price, 9);
        assert_eq!(result.volume, 100);
        assert_eq!(result.charged, 900);
        assert_eq!(result.refund, 50);
        assert_eq!(
            result.asks,
            vec![
                Fill {
                    id: 1,
                    qty: 100,
                    cash: 900
                },
                Fill {
                    id: 2,
                    qty: 0,
                    cash: 0
                },
            ]
        );
    }

    #[test]
    fn marginal_level_is_rationed() {
        let asks = [ask(1, 30, 5), ask(2, 40, 8), ask(3, 20, 8)];
        // Q(5) = 30, Q(8) = min(90, 400 / 8 = 50) = 50.
        let result = cleared(tender(&asks, 400, 10, UNIT).expect("clears"));
        assert_eq!(result.price, 8);
        assert_eq!(result.volume, 50);
        let quantities: Vec<u128> = result.asks.iter().map(|fill| fill.qty).collect();
        // 20 units rationed over 40 and 20: 13.33 and 6.67, the extra unit goes to id 3.
        assert_eq!(quantities, vec![30, 13, 7]);
        assert_eq!(result.charged, 400);
        assert_eq!(result.refund, 0);
    }

    #[test]
    fn asks_above_max_price_are_ignored() {
        let asks = [ask(1, 10, 11)];
        assert_eq!(tender(&asks, 1_000, 10, UNIT), Ok(Outcome::NoCrossing));
    }

    #[test]
    fn zero_budget_does_not_cross() {
        let asks = [ask(1, 10, 1)];
        assert_eq!(tender(&asks, 0, 10, UNIT), Ok(Outcome::NoCrossing));
        assert_eq!(tender(&[], 1_000, 10, UNIT), Ok(Outcome::NoCrossing));
    }

    #[test]
    fn locked_fraction_and_decimals_scale_the_cash() {
        let pricing = Pricing {
            locked_fraction_e18: ONE / 2,
            token_decimals: 18,
        };
        // 1000 whole tokens (1e21 units), half locked, at 2 USDC (2_000_000) per locked token.
        let asks = [ask(1, 1_000 * ONE, 2_000_000)];
        let result = cleared(tender(&asks, 5_000_000_000, 3_000_000, pricing).expect("clears"));
        assert_eq!(result.volume, 1_000 * ONE);
        assert_eq!(result.charged, 1_000_000_000);
        assert_eq!(result.asks[0].cash, 1_000_000_000);
        assert_eq!(result.refund, 4_000_000_000);
    }
}
