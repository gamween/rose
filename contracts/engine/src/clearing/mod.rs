//! Uniform-price sealed-bid clearing for the three round types (spec section 5.4).
//!
//! # Units and money
//!
//! - Quantities are `u128` units: one unit is a claim on one token base unit of the class
//!   schedule. In an Advance, quantities are claimed token base units.
//! - Prices are `u128` cash base units (USDC, 6 decimals: one tick is `1e-6` USDC) per whole
//!   locked token at the settlement time `ts`.
//! - [`Pricing`] converts: the cash for `q` units at price `P` is
//!   `q * locked_fraction * P / (ONE * 10^decimals)`. Buyers are charged that amount rounded up,
//!   sellers are paid it rounded down, so dust stays in the pool.
//!
//! # Determinism
//!
//! Orders are processed in a fixed total order (price priority, then ascending id); rationing uses
//! the largest remainder method with ties to the lower id. Order ids must be unique per side.
//! Every function is `O(n log n)` in the number of orders.

mod tender;
mod uniform;

use core::cmp::Ordering;
use core::fmt;

use crate::math::{self, MathError, Rounding, ONE};

pub use tender::{tender, TenderClearing};
pub use uniform::{advance, exit, AdvanceAsk, UniformClearing};

/// Protocol fee in basis points of settled notional, charged to the buying side on top of the
/// price (spec section 5.5).
pub const FEE_BPS: u128 = 30;

/// Basis points in one.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Fee owed on a settled notional: `ceil(notional * FEE_BPS / BPS_DENOMINATOR)`.
pub fn fee(notional: u128) -> Result<u128, MathError> {
    math::mul_div_ceil(notional, FEE_BPS, BPS_DENOMINATOR)
}

/// One opened bid or ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    /// Identifier, unique on its side of the book.
    pub id: u64,
    /// Quantity in units (claimed token base units in an Advance).
    pub qty: u128,
    /// Limit price (bid) or minimum price (ask) per whole token.
    pub price: u128,
}

/// Fill of one order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    /// Order id.
    pub id: u64,
    /// Filled quantity.
    pub qty: u128,
    /// Cash charged to a buyer (rounded up) or paid to a seller (rounded down), fees excluded.
    pub cash: u128,
}

/// Result of a round.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome<T> {
    /// No price crosses: the round is cancelled and everything is refunded.
    NoCrossing,
    /// The round clears.
    Cleared(T),
}

/// Reason a book cannot be cleared.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClearingError {
    /// An intermediate amount does not fit.
    Math(MathError),
    /// Two orders on the same side share an id.
    DuplicateOrderId(u64),
    /// The quantities of one side sum above `u128::MAX`.
    QuantityOverflow,
    /// `locked_fraction_e18 > ONE` or `10^token_decimals` does not fit in 128 bits.
    InvalidPricing,
    /// The Advance minimum fill exceeds the claim.
    MinFillAboveClaim,
    /// The Tender charge would exceed the budget (unreachable: the volume is affordable).
    BudgetExceeded,
}

impl fmt::Display for ClearingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Math(error) => write!(f, "clearing arithmetic: {error}"),
            Self::DuplicateOrderId(id) => write!(f, "duplicate order id {id}"),
            Self::QuantityOverflow => f.write_str("order quantities overflow"),
            Self::InvalidPricing => f.write_str("invalid pricing parameters"),
            Self::MinFillAboveClaim => f.write_str("minimum fill exceeds the claim"),
            Self::BudgetExceeded => f.write_str("charge exceeds the budget"),
        }
    }
}

impl From<MathError> for ClearingError {
    fn from(error: MathError) -> Self {
        Self::Math(error)
    }
}

/// Conversion between unit quantities, prices per whole locked token and cash.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pricing {
    /// Locked fraction of one unit at the settlement time, `ONE - f(ts)`.
    pub locked_fraction_e18: u128,
    /// Decimals of the class token.
    pub token_decimals: u8,
}

impl Pricing {
    /// Pricing of an Advance: prices are per claimed token, and a claimed token is one whole
    /// future token, so no locked fraction applies.
    pub fn per_claimed_token(token_decimals: u8) -> Self {
        Self {
            locked_fraction_e18: ONE,
            token_decimals,
        }
    }

    /// Cash charged to a buyer for `qty` units at `price`, rounded up.
    pub fn charge(&self, qty: u128, price: u128) -> Result<u128, ClearingError> {
        self.cash(qty, price, Rounding::Up)
    }

    /// Cash paid to a seller for `qty` units at `price`, rounded down.
    pub fn payout(&self, qty: u128, price: u128) -> Result<u128, ClearingError> {
        self.cash(qty, price, Rounding::Down)
    }

    /// Largest quantity whose cost at `price` fits in `budget`:
    /// `floor(budget * ONE * 10^decimals / (locked_fraction * price))`, saturating at
    /// `u128::MAX` (and unbounded when the cost per unit is zero).
    pub fn affordable(&self, budget: u128, price: u128) -> Result<u128, ClearingError> {
        if self.locked_fraction_e18 == 0 || price == 0 {
            return Ok(u128::MAX);
        }
        match math::mul_div_wide(
            &[budget, ONE, self.scale()?],
            &[self.locked_fraction_e18, price],
            Rounding::Down,
        ) {
            Ok(quantity) => Ok(quantity),
            Err(MathError::Overflow) => Ok(u128::MAX),
            Err(error) => Err(error.into()),
        }
    }

    fn validate(&self) -> Result<(), ClearingError> {
        if self.locked_fraction_e18 > ONE {
            return Err(ClearingError::InvalidPricing);
        }
        self.scale().map(|_| ())
    }

    fn scale(&self) -> Result<u128, ClearingError> {
        math::pow10(self.token_decimals).map_err(|_| ClearingError::InvalidPricing)
    }

    fn cash(&self, qty: u128, price: u128, rounding: Rounding) -> Result<u128, ClearingError> {
        Ok(math::mul_div_wide(
            &[qty, self.locked_fraction_e18, price],
            &[ONE, self.scale()?],
            rounding,
        )?)
    }
}

fn ensure_unique_ids(orders: &[Order]) -> Result<(), ClearingError> {
    let mut ids: Vec<u64> = orders.iter().map(|order| order.id).collect();
    ids.sort_unstable();
    match ids.windows(2).find(|pair| pair[0] == pair[1]) {
        Some(pair) => Err(ClearingError::DuplicateOrderId(pair[0])),
        None => Ok(()),
    }
}

/// Indices of the orders with a positive quantity, sorted by price priority then ascending id.
/// `better` orders two prices: `Less` means the first has priority.
fn priority(orders: &[Order], better: fn(&u128, &u128) -> Ordering) -> Vec<usize> {
    let mut indices: Vec<usize> = (0..orders.len()).filter(|&i| orders[i].qty > 0).collect();
    indices.sort_unstable_by(|&a, &b| {
        better(&orders[a].price, &orders[b].price).then(orders[a].id.cmp(&orders[b].id))
    });
    indices
}

fn sum_qty(orders: &[Order], indices: &[usize]) -> Result<u128, ClearingError> {
    indices.iter().try_fold(0u128, |sum, &i| {
        sum.checked_add(orders[i].qty)
            .ok_or(ClearingError::QuantityOverflow)
    })
}

/// Fills `target` units from `eligible` (sorted by price priority, then id): whole price levels
/// are filled while the cumulative quantity stays within `target`; the first level that does not
/// fit (the marginal level) is rationed with [`ration`]; later levels get nothing. When the
/// eligible quantity equals `target` (the short side), every eligible order fills fully.
fn allocate(
    orders: &[Order],
    eligible: &[usize],
    target: u128,
    fills: &mut [u128],
) -> Result<(), ClearingError> {
    let mut remaining = target;
    let mut start = 0;
    while start < eligible.len() && remaining > 0 {
        let price = orders[eligible[start]].price;
        let end = start
            + eligible[start..]
                .iter()
                .take_while(|&&i| orders[i].price == price)
                .count();
        let level = &eligible[start..end];
        let level_qty = sum_qty(orders, level)?;
        if level_qty <= remaining {
            for &i in level {
                fills[i] = orders[i].qty;
            }
            remaining -= level_qty;
        } else {
            ration(orders, level, remaining, level_qty, fills)?;
            remaining = 0;
        }
        start = end;
    }
    Ok(())
}

/// Largest remainder (Hamilton) rationing of `amount < level_qty` units over one price level:
/// each order gets `floor(amount * qty / level_qty)`, and the units left over go one each to the
/// orders with the largest remainders `(amount * qty) mod level_qty`, ties to the lower id. The
/// fills sum to `amount` exactly and never exceed an order's quantity.
fn ration(
    orders: &[Order],
    level: &[usize],
    amount: u128,
    level_qty: u128,
    fills: &mut [u128],
) -> Result<(), ClearingError> {
    let mut remainders = Vec::with_capacity(level.len());
    let mut assigned = 0u128;
    for &i in level {
        let (share, remainder) = math::mul_div_rem(amount, orders[i].qty, level_qty)?;
        fills[i] = share;
        assigned += share;
        remainders.push((remainder, orders[i].id, i));
    }
    remainders.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let leftover = usize::try_from(amount - assigned).unwrap_or(usize::MAX);
    for &(_, _, i) in remainders.iter().take(leftover) {
        fills[i] += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_is_thirty_bps_rounded_up() {
        assert_eq!(fee(0), Ok(0));
        assert_eq!(fee(1), Ok(1));
        assert_eq!(fee(10_000), Ok(30));
        assert_eq!(fee(10_001), Ok(31));
        assert_eq!(fee(900), Ok(3));
    }

    #[test]
    fn pricing_rounds_against_the_trader() {
        let pricing = Pricing {
            locked_fraction_e18: ONE / 3,
            token_decimals: 2,
        };
        // 10 units at 100 per whole token, a third locked: 10 * 100 / 3 / 100 = 3.33...
        assert_eq!(pricing.charge(10, 100), Ok(4));
        assert_eq!(pricing.payout(10, 100), Ok(3));
        // A budget of 4 affords floor(4 * 100 * 3 / 100) = 12 units.
        assert_eq!(pricing.affordable(4, 100), Ok(12));
        assert!(pricing.charge(12, 100).expect("charge") <= 4);
        assert!(pricing.charge(13, 100).expect("charge") > 4);
    }

    #[test]
    fn pricing_identity_reduces_to_qty_times_price() {
        let pricing = Pricing {
            locked_fraction_e18: ONE,
            token_decimals: 0,
        };
        assert_eq!(pricing.charge(100, 9), Ok(900));
        assert_eq!(pricing.payout(100, 9), Ok(900));
        assert_eq!(pricing.affordable(950, 10), Ok(95));
        assert_eq!(pricing.affordable(950, 0), Ok(u128::MAX));
    }

    #[test]
    fn invalid_pricing_is_rejected() {
        let over = Pricing {
            locked_fraction_e18: ONE + 1,
            token_decimals: 0,
        };
        assert_eq!(over.validate(), Err(ClearingError::InvalidPricing));
        let decimals = Pricing::per_claimed_token(39);
        assert_eq!(decimals.validate(), Err(ClearingError::InvalidPricing));
    }

    #[test]
    fn ration_uses_largest_remainders_with_ties_to_lower_id() {
        let orders = [
            Order {
                id: 9,
                qty: 1,
                price: 5,
            },
            Order {
                id: 3,
                qty: 1,
                price: 5,
            },
            Order {
                id: 5,
                qty: 1,
                price: 5,
            },
        ];
        let mut fills = [0; 3];
        ration(&orders, &[1, 2, 0], 2, 3, &mut fills).expect("ration");
        assert_eq!(fills, [0, 1, 1]);

        let orders = [
            Order {
                id: 1,
                qty: 5,
                price: 5,
            },
            Order {
                id: 2,
                qty: 3,
                price: 5,
            },
            Order {
                id: 3,
                qty: 2,
                price: 5,
            },
        ];
        let mut fills = [0; 3];
        // Quotas 3.5, 2.1, 1.4: floors 3, 2, 1 and the last unit goes to id 1.
        ration(&orders, &[0, 1, 2], 7, 10, &mut fills).expect("ration");
        assert_eq!(fills, [4, 2, 1]);
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let orders = [
            Order {
                id: 1,
                qty: 1,
                price: 1,
            },
            Order {
                id: 1,
                qty: 2,
                price: 2,
            },
        ];
        assert_eq!(
            ensure_unique_ids(&orders),
            Err(ClearingError::DuplicateOrderId(1))
        );
    }
}
