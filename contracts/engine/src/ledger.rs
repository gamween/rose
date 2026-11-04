//! Accrual accounting for class units (spec section 4).
//!
//! Every account holds `(balance, checkpoint, claimable, carry)` per class. Before any balance
//! change the holding accrues `balance * (f(now) - checkpoint)` into `claimable` and moves its
//! checkpoint to `f(now)`; the fractional part of each accrual is carried to the next one, so a
//! holding's lifetime accrual is the floor of its exact accrual rather than a sum of floors (a
//! holder who never moved its units has exactly `floor(units * (f - checkpoint))`, the amount a
//! redeem of their stream computes in one step). Units locked into a round or encumbered by a
//! lien leave the holding and carry their own checkpoint, so the right party accrues them for the
//! right period. Every division rounds down, so the sum of entitlements never exceeds what the
//! underlying streams released.
//!
//! This module is pure: no NEAR SDK, no I/O.

use core::fmt;

use borsh::{BorshDeserialize, BorshSerialize};

use crate::math;
use crate::unlock::accrual;

/// Errors of ledger operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LedgerError {
    /// The holding has fewer free units than requested.
    InsufficientUnits,
    /// The holding has fewer claimable tokens than requested.
    InsufficientClaimable,
    /// A balance does not fit in 128 bits.
    Overflow,
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InsufficientUnits => "not enough units",
            Self::InsufficientClaimable => "not enough claimable tokens",
            Self::Overflow => "amount overflow",
        })
    }
}

/// One owner's units of one class.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Holding {
    /// Free (transferable) units.
    pub balance: u128,
    /// Class fraction (1e18 fixed point) up to which `balance` has accrued.
    pub checkpoint: u128,
    /// Unlocked tokens owed to the owner, in token base units.
    pub claimable: u128,
    /// Fractional part of the accruals so far, `(sum of balance * delta f) mod ONE`: below one
    /// base unit, carried into the next accrual.
    pub carry: u128,
}

impl Holding {
    /// Accrues the balance up to `f_now`.
    pub fn accrue(&mut self, f_now: u128) -> Result<(), LedgerError> {
        if f_now > self.checkpoint {
            let (earned, carry) = self.accrued(self.balance, self.checkpoint, f_now);
            self.claimable = self
                .claimable
                .checked_add(earned)
                .ok_or(LedgerError::Overflow)?;
            self.carry = carry;
            self.checkpoint = f_now;
        }
        Ok(())
    }

    /// Tokens the holding would hold as claimable once accrued up to `f_now`, without mutating.
    pub fn claimable_at(&self, f_now: u128) -> u128 {
        let (earned, _) = self.accrued(self.balance, self.checkpoint, f_now);
        self.claimable.saturating_add(earned)
    }

    /// Whole tokens `units` accrue from `from` to `to` together with the carry, and the new
    /// carry: `(carry + units * (to - from)) divmod ONE`.
    fn accrued(&self, units: u128, from: u128, to: u128) -> (u128, u128) {
        if to <= from {
            return (0, self.carry);
        }
        let (whole, fraction) =
            math::mul_div_rem(units, to - from, math::ONE).unwrap_or((accrual(units, from, to), 0));
        let fraction = fraction + self.carry;
        (
            whole.saturating_add(fraction / math::ONE),
            fraction % math::ONE,
        )
    }

    /// Adds units that accrue to this owner from `f_now` on.
    pub fn credit(&mut self, f_now: u128, units: u128) -> Result<(), LedgerError> {
        self.credit_since(f_now, units, f_now)
    }

    /// Adds units that belonged to this owner since `f_from` (`f_from <= f_now`): the tokens they
    /// unlocked between `f_from` and `f_now` are credited as claimable.
    pub fn credit_since(
        &mut self,
        f_now: u128,
        units: u128,
        f_from: u128,
    ) -> Result<(), LedgerError> {
        self.accrue(f_now)?;
        self.balance = self
            .balance
            .checked_add(units)
            .ok_or(LedgerError::Overflow)?;
        let (earned, carry) = self.accrued(units, f_from, f_now);
        self.carry = carry;
        self.add_claimable(earned)
    }

    /// Removes units after accruing them up to `f_now`.
    pub fn debit(&mut self, f_now: u128, units: u128) -> Result<(), LedgerError> {
        self.accrue(f_now)?;
        self.balance = self
            .balance
            .checked_sub(units)
            .ok_or(LedgerError::InsufficientUnits)?;
        Ok(())
    }

    /// Adds already unlocked tokens to the claimable balance.
    pub fn add_claimable(&mut self, tokens: u128) -> Result<(), LedgerError> {
        self.claimable = self
            .claimable
            .checked_add(tokens)
            .ok_or(LedgerError::Overflow)?;
        Ok(())
    }

    /// Takes `amount` claimable tokens out for a payout, after accruing up to `f_now`.
    pub fn take_claimable(&mut self, f_now: u128, amount: u128) -> Result<(), LedgerError> {
        self.accrue(f_now)?;
        self.claimable = self
            .claimable
            .checked_sub(amount)
            .ok_or(LedgerError::InsufficientClaimable)?;
        Ok(())
    }

    /// True when the holding carries nothing and its storage can be released.
    pub fn is_empty(&self) -> bool {
        self.balance == 0 && self.claimable == 0
    }
}

/// Units taken out of a holding into a round. They keep accruing to their owner until the
/// round's settlement time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Lock {
    /// Locked units.
    pub units: u128,
    /// Class fraction at which the units were locked.
    pub checkpoint: u128,
}

impl Lock {
    /// Locks `units` at the class fraction `f_now`.
    pub fn new(units: u128, f_now: u128) -> Self {
        Self {
            units,
            checkpoint: f_now,
        }
    }

    /// Tokens the locked units unlocked between the lock and `f_ts`, owed to the owner.
    pub fn accrued_until(&self, f_ts: u128) -> u128 {
        accrual(self.units, self.checkpoint, f_ts)
    }
}

/// Senior claim on the first `claim_total` tokens unlocked by `units` encumbered units (Advance
/// rounds, spec section 4).
///
/// Delivery is computed cumulatively from `f_start`, never step by step: with
/// `total = accrual(units, f_start, f_now)`, the lien has received `min(claim_total, total)` and
/// the holder `total - delivered`. Per-step floors would otherwise lose up to one base unit per
/// touch and a claim at the maximum (`units * (1 - f_start)`) could never be satisfied.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Lien {
    /// Encumbered units.
    pub units: u128,
    /// Class fraction the lien starts at (the round's settlement time).
    pub f_start: u128,
    /// Class fraction up to which the lien was last accrued.
    pub checkpoint: u128,
    /// Tokens owed to the lien holders in total.
    pub claim_total: u128,
    /// Tokens delivered to the lien so far.
    pub delivered: u128,
    /// Excess tokens already credited to the holder.
    pub excess_credited: u128,
}

impl Lien {
    /// Encumbers `units` from the class fraction `f_start` for a claim of `claim_total` tokens.
    pub fn new(units: u128, f_start: u128, claim_total: u128) -> Self {
        Self {
            units,
            f_start,
            checkpoint: f_start,
            claim_total,
            delivered: 0,
            excess_credited: 0,
        }
    }

    /// Accrues the encumbered units up to `f_now`. Tokens go to the lien until `claim_total` is
    /// delivered; the returned excess belongs to the holder and is credited exactly once.
    pub fn accrue(&mut self, f_now: u128) -> u128 {
        if f_now <= self.checkpoint {
            return 0;
        }
        let total = accrual(self.units, self.f_start, f_now);
        self.checkpoint = f_now;
        self.delivered = total.min(self.claim_total);
        let excess = total
            .saturating_sub(self.delivered)
            .saturating_sub(self.excess_credited);
        self.excess_credited = self.excess_credited.saturating_add(excess);
        excess
    }

    /// Tokens still owed to the lien.
    pub fn outstanding(&self) -> u128 {
        self.claim_total.saturating_sub(self.delivered)
    }

    /// `(delivered, excess)` the lien would show once accrued up to `f_now`, without mutating.
    pub fn preview(&self, f_now: u128) -> (u128, u128) {
        let mut copy = *self;
        let excess = copy.accrue(f_now);
        (copy.delivered, excess)
    }

    /// True once the claim is fully delivered: the units return to the holder.
    pub fn is_satisfied(&self) -> bool {
        self.delivered >= self.claim_total
    }

    /// Tokens a funder holding `share` of the claim is entitled to so far, rounded down.
    pub fn entitlement(&self, share: u128) -> u128 {
        if self.claim_total == 0 {
            return 0;
        }
        math::mul_div_floor(self.delivered, share, self.claim_total).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::ONE;
    use proptest::prelude::*;

    const HALF: u128 = ONE / 2;

    #[test]
    fn accrue_then_debit_keeps_earned_tokens() {
        let mut h = Holding::default();
        h.credit(0, 1_000).unwrap();
        h.debit(HALF, 400).unwrap();
        assert_eq!(h.claimable, 500);
        assert_eq!(h.balance, 600);
        assert_eq!(h.claimable_at(ONE), 800);
        h.accrue(ONE).unwrap();
        assert_eq!(h.claimable, 800);
        assert!(!h.is_empty());
    }

    #[test]
    fn credit_since_backdates_accrual() {
        let mut h = Holding::default();
        h.credit_since(HALF, 1_000, ONE / 4).unwrap();
        assert_eq!(h.claimable, 250);
        assert_eq!(h.checkpoint, HALF);
    }

    #[test]
    fn take_claimable_rejects_overdraw() {
        let mut h = Holding::default();
        h.credit(0, 100).unwrap();
        assert_eq!(
            h.take_claimable(HALF, 51),
            Err(LedgerError::InsufficientClaimable)
        );
        h.take_claimable(HALF, 50).unwrap();
        assert_eq!(h.claimable, 0);
        assert_eq!(h.debit(HALF, 101), Err(LedgerError::InsufficientUnits));
        let mut full = Holding {
            balance: u128::MAX,
            checkpoint: 0,
            claimable: 0,
            carry: 0,
        };
        assert_eq!(full.credit(0, 1), Err(LedgerError::Overflow));
    }

    #[test]
    fn lock_accrues_to_its_owner_until_settlement() {
        let lock = Lock::new(1_000, ONE / 4);
        assert_eq!(lock.accrued_until(HALF), 250);
        assert_eq!(lock.accrued_until(0), 0);
    }

    #[test]
    fn lien_delivers_senior_tokens_then_excess() {
        let mut l = Lien::new(1_000, 0, 300);
        assert_eq!(l.preview(ONE / 5), (200, 0));
        assert_eq!(l.accrue(ONE / 5), 0);
        assert_eq!(l.delivered, 200);
        assert_eq!(l.outstanding(), 100);
        assert_eq!(l.accrue(ONE / 2), 200);
        assert!(l.is_satisfied());
        assert_eq!(l.entitlement(150), 150);
        assert_eq!(l.accrue(ONE), 500);
        assert_eq!(l.accrue(ONE), 0);
        assert_eq!(Lien::new(1, 0, 0).entitlement(1), 0);
    }

    #[test]
    fn lien_at_the_maximum_claim_is_satisfied_despite_step_floors() {
        // 3,333,333 units from f = 0.5: the largest claim is floor(3,333,333 / 2) = 1,666,666.
        let units = 3_333_333;
        let claim = accrual(units, ONE / 2, ONE);
        assert_eq!(claim, 1_666_666);
        let mut lien = Lien::new(units, ONE / 2, claim);
        let mut excess = 0;
        for step in 1..=6u128 {
            excess += lien.accrue(ONE / 2 + step * ONE / 12);
        }
        assert!(lien.is_satisfied());
        assert_eq!(lien.delivered, claim);
        assert_eq!(excess, accrual(units, ONE / 2, ONE) - claim);
    }

    proptest! {
        /// A holding that keeps its units accrues, over any sequence of touches, exactly the
        /// floor of its exact accrual: the fractions carried between touches are never lost.
        #[test]
        fn a_held_balance_accrues_the_floor_of_its_exact_accrual(
            units in 1u128..1_000_000_000_000_000_000_000u128,
            from in 0u128..ONE / 2,
            steps in proptest::collection::vec(0u128..=ONE, 1..12),
        ) {
            let mut fs = steps;
            fs.sort_unstable();
            let f_now = (from + 1).max(fs[0]);
            let mut h = Holding::default();
            h.credit_since(f_now, units, from).unwrap();
            for f in &fs {
                h.accrue((*f).max(f_now)).unwrap();
            }
            let f_end = fs.last().unwrap().max(&f_now);
            prop_assert_eq!(h.claimable, accrual(units, from, *f_end));
            prop_assert!(h.carry < ONE);
        }

        #[test]
        fn split_holdings_never_exceed_a_single_holding(
            units in 1u128..1_000_000_000_000_000_000_000u128,
            cut in 0u128..=100,
            steps in proptest::collection::vec(0u128..=ONE, 1..8),
        ) {
            let mut fs = steps;
            fs.sort_unstable();
            let moved = units * cut / 100;
            let mut whole = Holding::default();
            whole.credit(0, units).unwrap();
            let mut a = Holding::default();
            a.credit(0, units).unwrap();
            let mut b = Holding::default();
            for (i, f) in fs.iter().enumerate() {
                whole.accrue(*f).unwrap();
                if i == 0 {
                    a.debit(*f, moved).unwrap();
                    b.credit(*f, moved).unwrap();
                } else {
                    a.accrue(*f).unwrap();
                    b.accrue(*f).unwrap();
                }
            }
            let f_end = *fs.last().unwrap();
            whole.accrue(f_end).unwrap();
            prop_assert!(a.claimable + b.claimable <= whole.claimable);
            prop_assert!(whole.claimable - (a.claimable + b.claimable) <= 2 * fs.len() as u128);
            prop_assert!(whole.claimable <= accrual(units, 0, f_end));
        }

        #[test]
        fn lien_never_delivers_more_than_claim(
            units in 1u128..1_000_000_000_000u128,
            claim in 1u128..1_000_000_000_000u128,
            steps in proptest::collection::vec(0u128..=ONE, 1..10),
        ) {
            let mut fs = steps;
            fs.sort_unstable();
            let mut l = Lien::new(units, 0, claim);
            let mut excess = 0;
            for f in fs.iter() {
                excess += l.accrue(*f);
            }
            prop_assert!(l.delivered <= claim);
            let single = accrual(units, 0, *fs.last().unwrap());
            prop_assert_eq!(l.delivered + excess, single);
            prop_assert_eq!(l.is_satisfied(), single >= claim);
        }
    }
}
