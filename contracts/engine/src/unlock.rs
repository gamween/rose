//! Unlock schedules of deposited positions and of position classes.
//!
//! Two layers live here:
//!
//! - Exact ports of the foreign protocols' vesting math, per position: [`SablierLinearStream`]
//!   (Sablier Lockup v4, Lockup Linear model) and [`StreamflowStream`] (Streamflow on Solana).
//!   They return token base units, exactly as the foreign contract would.
//! - The class schedule ([`ClassSchedule`]): the normalized schedule shared by every position of a
//!   class, which defines the unlock function `f(t)` in `[0, ONE]` used for accrual accounting.
//!
//! Timestamps are Unix seconds (Sablier stores `uint40`, Streamflow `u64`); the contract converts
//! NEAR block timestamps (nanoseconds) before calling in.
//!
//! # Rounding always favors the pool
//!
//! For every position `p` of a class with allocation `D_p` and every time `t`:
//! `D_p * f(t) / ONE <= streamed_p(t)`. Units are fungible inside a class, so the sum of the
//! entitlements of all holders never exceeds what the foreign streams have actually unlocked.
//!
//! # What "same normalized schedule" means
//!
//! Two positions belong to the same class when their [`ClassSchedule`] values are equal (the
//! contract adds chain, protocol and token to the key). Normalization keeps the timestamps as they
//! are and divides the amounts by their greatest common divisor:
//!
//! - Sablier LL: `(start, cliff, end, granularity)` are kept; `(deposited, start_unlock,
//!   cliff_unlock)` are divided by `gcd(deposited, start_unlock, cliff_unlock)`. Two streams are
//!   in the same class exactly when the timestamps and granularity are equal and
//!   `start_unlock / deposited` and `cliff_unlock / deposited` are equal as exact rationals. The
//!   class also records `min_deposit = 10^token_decimals` (one whole token): smaller streams are
//!   refused, see [`LinearClass`] for why.
//! - Streamflow: the effective start (`cliff` when non-zero, else `start_time`, which is the only
//!   start the program's math reads), `end_time` and `period` are kept; `(net_amount_deposited,
//!   cliff_amount, amount_per_period)` are divided by their gcd. Two streams are in the same class
//!   exactly when those timestamps and the period are equal and `cliff_amount / deposited` and
//!   `amount_per_period / deposited` are equal as exact rationals.

use core::fmt;

use borsh::{BorshDeserialize, BorshSerialize};

use crate::math::{self, Rounding, ONE};

/// Unix timestamp in seconds.
pub type Timestamp = u64;

/// Reason a schedule is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleError {
    /// The deposited amount is zero.
    ZeroDeposit,
    /// The start time is zero (Sablier refuses it at creation).
    ZeroStartTime,
    /// The cliff is set and is not strictly after the start.
    StartNotBeforeCliff,
    /// The cliff is set and is not strictly before the end.
    CliffNotBeforeEnd,
    /// There is no cliff and the start is not strictly before the end.
    StartNotBeforeEnd,
    /// A cliff unlock amount was given without a cliff time.
    CliffUnlockWithoutCliff,
    /// The unlock granularity is zero (Sablier stores at least one second).
    ZeroGranularity,
    /// The unlock granularity exceeds the streamable range.
    GranularityTooHigh,
    /// The start and cliff unlock amounts exceed the deposited amount.
    UnlockAmountsExceedDeposit,
    /// The Streamflow period is zero.
    ZeroPeriod,
    /// The Streamflow cliff amount exceeds the deposited amount.
    CliffAmountExceedsDeposit,
    /// The Streamflow end time is before its effective start.
    EndBeforeStart,
    /// The position is smaller than the class minimum (one whole token).
    DepositBelowMinimum,
    /// `10^decimals` does not fit in 128 bits.
    TokenDecimalsTooLarge,
}

impl fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ZeroDeposit => "deposited amount is zero",
            Self::ZeroStartTime => "start time is zero",
            Self::StartNotBeforeCliff => "start time is not before the cliff time",
            Self::CliffNotBeforeEnd => "cliff time is not before the end time",
            Self::StartNotBeforeEnd => "start time is not before the end time",
            Self::CliffUnlockWithoutCliff => "cliff unlock amount without a cliff time",
            Self::ZeroGranularity => "unlock granularity is zero",
            Self::GranularityTooHigh => "unlock granularity exceeds the streamable range",
            Self::UnlockAmountsExceedDeposit => "unlock amounts exceed the deposited amount",
            Self::ZeroPeriod => "unlock period is zero",
            Self::CliffAmountExceedsDeposit => "cliff amount exceeds the deposited amount",
            Self::EndBeforeStart => "end time is before the start time",
            Self::DepositBelowMinimum => "position is smaller than one whole token",
            Self::TokenDecimalsTooLarge => "token decimals are too large",
        };
        f.write_str(message)
    }
}

/// Raw parameters of a Sablier Lockup v4 Lockup Linear stream, as read from the contract
/// (`getStartTime`, `getCliffTime`, `getEndTime`, `getGranularity`, `getUnlockAmounts`,
/// `getDepositedAmount`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SablierLinearParams {
    /// Start time.
    pub start: Timestamp,
    /// Cliff time, `0` when the stream has no cliff.
    pub cliff: Timestamp,
    /// End time.
    pub end: Timestamp,
    /// Unlock granularity in seconds (Sablier stores at least `1`).
    pub granularity: u64,
    /// Amount unlocked at the start time.
    pub start_unlock: u128,
    /// Amount unlocked at the cliff time.
    pub cliff_unlock: u128,
    /// Deposited amount.
    pub deposited: u128,
}

/// A validated Sablier Lockup v4 Lockup Linear stream.
///
/// [`Self::streamed_amount`] is a line-by-line port of `LockupMath.calculateStreamedAmountLL` in
/// `lockup/src/libraries/LockupMath.sol` of `sablier-labs/evm-monorepo` at tag `lockup@v4.0.1`
/// (commit `fae38dc7e43c6cab6de8f97124c559f42ed5b77a`; the function is byte-identical at
/// `lockup@v4.0.0`, commit `93abe6848b0dbb2efb293bf0f66a934a6bf76954`, which is the release
/// deployed on Base Sepolia at `0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e`):
/// <https://github.com/sablier-labs/evm-monorepo/blob/fae38dc7e43c6cab6de8f97124c559f42ed5b77a/lockup/src/libraries/LockupMath.sol>.
/// Lockup v4 uses plain integer arithmetic for this model (no UD60x18): the streamed portion is
/// `floor(floor(elapsed / granularity) * streamable * granularity / streamable_duration)`.
///
/// Validation mirrors `LockupHelpers._checkTimestampsAndUnlockAmounts` and
/// `LockupHelpers._checkCreateStream` at the same commit, so every stream Sablier can create is
/// accepted. Under those checks the port's last branch (`streamed > deposited`, which returns the
/// withdrawn amount as a bug guard) is unreachable and is therefore not reproduced.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SablierLinearStream {
    params: SablierLinearParams,
}

impl SablierLinearStream {
    /// Validates raw stream parameters with Sablier's own creation rules.
    pub fn new(params: SablierLinearParams) -> Result<Self, ScheduleError> {
        if params.deposited == 0 {
            return Err(ScheduleError::ZeroDeposit);
        }
        if params.start == 0 {
            return Err(ScheduleError::ZeroStartTime);
        }
        let streamable_range = if params.cliff > 0 {
            if params.start >= params.cliff {
                return Err(ScheduleError::StartNotBeforeCliff);
            }
            if params.cliff >= params.end {
                return Err(ScheduleError::CliffNotBeforeEnd);
            }
            params.end - params.cliff
        } else {
            if params.cliff_unlock > 0 {
                return Err(ScheduleError::CliffUnlockWithoutCliff);
            }
            if params.start >= params.end {
                return Err(ScheduleError::StartNotBeforeEnd);
            }
            params.end - params.start
        };
        if params.granularity == 0 {
            return Err(ScheduleError::ZeroGranularity);
        }
        if params.granularity > streamable_range {
            return Err(ScheduleError::GranularityTooHigh);
        }
        match params.start_unlock.checked_add(params.cliff_unlock) {
            Some(sum) if sum <= params.deposited => Ok(Self { params }),
            _ => Err(ScheduleError::UnlockAmountsExceedDeposit),
        }
    }

    /// The validated parameters.
    pub fn params(&self) -> &SablierLinearParams {
        &self.params
    }

    /// Amount streamed (unlocked) at time `t`, in token base units, exactly as Sablier computes it.
    pub fn streamed_amount(&self, t: Timestamp) -> u128 {
        let p = &self.params;
        if p.start > t {
            return 0;
        }
        if p.cliff > t {
            return p.start_unlock;
        }
        if p.end <= t {
            return p.deposited;
        }
        let unlock_amounts_sum = p.start_unlock + p.cliff_unlock;
        if unlock_amounts_sum >= p.deposited {
            return p.deposited;
        }
        let base = if p.cliff == 0 { p.start } else { p.cliff };
        let elapsed_units = (t - base) / p.granularity;
        let streamable_total_duration = p.end - base;
        let streamable_amount = p.deposited - unlock_amounts_sum;
        // `elapsed_units * granularity <= t - base < streamable_total_duration`, so the portion is
        // below `streamable_amount` and the division cannot fail.
        let streamed_portion = math::mul_div_wide(
            &[
                u128::from(elapsed_units),
                streamable_amount,
                u128::from(p.granularity),
            ],
            &[u128::from(streamable_total_duration)],
            Rounding::Down,
        )
        .unwrap_or(0);
        unlock_amounts_sum + streamed_portion
    }
}

/// Raw parameters of a Streamflow stream, as read from its metadata account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StreamflowParams {
    /// `ix.start_time`.
    pub start_time: Timestamp,
    /// `ix.cliff`, `0` when unset.
    pub cliff: Timestamp,
    /// `ix.cliff_amount`.
    pub cliff_amount: u64,
    /// `ix.period` in seconds.
    pub period: u64,
    /// `ix.amount_per_period`.
    pub amount_per_period: u64,
    /// `ix.net_amount_deposited`.
    pub net_amount_deposited: u64,
    /// `end_time`, computed by the program at creation and stored in the account.
    pub end_time: Timestamp,
}

/// A validated Streamflow stream (stepped unlock).
///
/// [`Self::unlocked_amount`] ports `Contract::start_time`, `Contract::vested_available`,
/// `Contract::cliff_available` and the time guards of `Contract::available_to_claim` (plus the
/// withdrawn amount it subtracts) from `programs/streamflow-sdk/src/state.rs` of
/// `streamflow-finance/rust-sdk` at commit `63df7d7b831340daa27f31d007eec2a98380364c`:
/// <https://github.com/streamflow-finance/rust-sdk/blob/63df7d7b831340daa27f31d007eec2a98380364c/programs/streamflow-sdk/src/state.rs>,
/// cross-checked against `calculateUnlockedAmount` in `packages/stream/solana/contractUtils.ts` of
/// `streamflow-finance/js-sdk` at `v13.4.0` (commit `fb236fff325ab02d7ff5d0ff5e393be8934cda9d`):
/// <https://github.com/streamflow-finance/js-sdk/blob/fb236fff325ab02d7ff5d0ff5e393be8934cda9d/packages/stream/solana/contractUtils.ts>.
///
/// The formula, for a stream that was never paused and whose rate was never updated
/// (`last_rate_change_time == 0`, `funds_unlocked_at_last_rate_change == 0`; the contract refuses
/// pausable, rate-updatable and top-up streams):
///
/// - `start = cliff` when `cliff > 0`, else `start_time`;
/// - `t < start`: `0`;
/// - `t >= end_time`: `net_amount_deposited`;
/// - otherwise `min(cliff_amount + floor((t - start) / period) * amount_per_period,
///   net_amount_deposited)`.
///
/// The Rust SDK treats `t == end_time` as fully unlocked and the JS SDK as `t > end`; the Rust SDK
/// mirrors the program, so `>=` is used. The cap at the deposit comes from the JS SDK and never
/// raises the amount above what the program releases.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StreamflowStream {
    params: StreamflowParams,
}

impl StreamflowStream {
    /// Validates raw stream parameters.
    pub fn new(params: StreamflowParams) -> Result<Self, ScheduleError> {
        if params.net_amount_deposited == 0 {
            return Err(ScheduleError::ZeroDeposit);
        }
        if params.period == 0 {
            return Err(ScheduleError::ZeroPeriod);
        }
        if params.cliff_amount > params.net_amount_deposited {
            return Err(ScheduleError::CliffAmountExceedsDeposit);
        }
        let stream = Self { params };
        if params.end_time < stream.effective_start() {
            return Err(ScheduleError::EndBeforeStart);
        }
        Ok(stream)
    }

    /// The validated parameters.
    pub fn params(&self) -> &StreamflowParams {
        &self.params
    }

    /// The only start the program's math reads: the cliff when set, else the start time.
    pub fn effective_start(&self) -> Timestamp {
        if self.params.cliff > 0 {
            self.params.cliff
        } else {
            self.params.start_time
        }
    }

    /// Amount unlocked at time `t`, in token base units.
    pub fn unlocked_amount(&self, t: Timestamp) -> u128 {
        let p = &self.params;
        let start = self.effective_start();
        if t < start {
            return 0;
        }
        let deposited = u128::from(p.net_amount_deposited);
        if t >= p.end_time {
            return deposited;
        }
        let periods = u128::from((t - start) / p.period);
        // Both factors are below 2^64, so the product and the sum fit in 128 bits.
        let vested = periods * u128::from(p.amount_per_period) + u128::from(p.cliff_amount);
        vested.min(deposited)
    }
}

/// Normalized schedule of a class: the schedule part of the class key and its unlock function.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, BorshSerialize, BorshDeserialize,
)]
pub enum ClassSchedule {
    /// A class of Sablier Lockup Linear streams.
    Linear(LinearClass),
    /// A class of Streamflow streams.
    Stepped(SteppedClass),
}

impl ClassSchedule {
    /// The class schedule of a Sablier LL stream of a token with `token_decimals` decimals.
    pub fn from_sablier(
        stream: &SablierLinearStream,
        token_decimals: u8,
    ) -> Result<Self, ScheduleError> {
        LinearClass::new(stream, token_decimals).map(Self::Linear)
    }

    /// The class schedule of a Streamflow stream.
    pub fn from_streamflow(stream: &StreamflowStream) -> Self {
        Self::Stepped(SteppedClass::new(stream))
    }

    /// Unlocked fraction `f(t)` in `[0, ONE]`: non-decreasing in `t`, `0` before the start (the
    /// start unlock excepted), `ONE` at and after the end, and never above the exact unlocked
    /// fraction of any position of the class.
    pub fn fraction(&self, t: Timestamp) -> u128 {
        match self {
            Self::Linear(class) => class.fraction(t),
            Self::Stepped(class) => class.fraction(t),
        }
    }
}

/// Normalized schedule of a class of Sablier LL streams.
///
/// Sablier floors the streamed portion per stream, and that floor does not scale: two streams
/// with exactly proportional amounts can differ by up to one base unit, so `floor(streamed * ONE
/// / deposited)` of one member can exceed the true fraction of another member. The class therefore
/// uses the exact linear fraction lowered by a margin of `ceil(ONE / min_deposit)`:
///
/// ```text
/// f(t) = 0                                          t < start
///      = floor(ONE * start_unlock / total)           start <= t < cliff
///      = ONE                                        t >= end
///      = max(u0, u0 + floor(ONE * n * g * a / (d * total)) - margin)   otherwise
/// ```
///
/// where `u0 = floor(ONE * (start_unlock + cliff_unlock) / total)`, `a = total - start_unlock -
/// cliff_unlock`, `g` the granularity, `n = floor((t - b) / g)`, `b` the cliff (or the start when
/// there is no cliff) and `d = end - b`. Since a member with allocation `D >= min_deposit` streams
/// at least `D * (u0 + ONE * n * g * a / (d * total)) / ONE - 1` base units, `D * f(t) / ONE` never
/// exceeds its streamed amount. With `min_deposit` one whole token, the margin is at most one base
/// unit per whole token held (`1e-18` of the allocation for an 18-decimal token).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, BorshSerialize, BorshDeserialize,
)]
pub struct LinearClass {
    start: Timestamp,
    cliff: Timestamp,
    end: Timestamp,
    granularity: u64,
    start_unlock: u128,
    cliff_unlock: u128,
    total: u128,
    min_deposit: u128,
}

impl LinearClass {
    fn new(stream: &SablierLinearStream, token_decimals: u8) -> Result<Self, ScheduleError> {
        let p = stream.params();
        let min_deposit =
            math::pow10(token_decimals).map_err(|_| ScheduleError::TokenDecimalsTooLarge)?;
        if p.deposited < min_deposit {
            return Err(ScheduleError::DepositBelowMinimum);
        }
        let divisor = gcd(gcd(p.deposited, p.start_unlock), p.cliff_unlock);
        Ok(Self {
            start: p.start,
            cliff: p.cliff,
            end: p.end,
            granularity: p.granularity,
            start_unlock: p.start_unlock / divisor,
            cliff_unlock: p.cliff_unlock / divisor,
            total: p.deposited / divisor,
            min_deposit,
        })
    }

    /// Start time.
    pub fn start(&self) -> Timestamp {
        self.start
    }

    /// Cliff time, `0` when there is no cliff.
    pub fn cliff(&self) -> Timestamp {
        self.cliff
    }

    /// End time.
    pub fn end(&self) -> Timestamp {
        self.end
    }

    /// Unlock granularity in seconds.
    pub fn granularity(&self) -> u64 {
        self.granularity
    }

    /// Reduced start unlock amount.
    pub fn start_unlock(&self) -> u128 {
        self.start_unlock
    }

    /// Reduced cliff unlock amount.
    pub fn cliff_unlock(&self) -> u128 {
        self.cliff_unlock
    }

    /// Reduced total.
    pub fn total(&self) -> u128 {
        self.total
    }

    /// Smallest deposit accepted in the class (one whole token).
    pub fn min_deposit(&self) -> u128 {
        self.min_deposit
    }

    /// Margin subtracted from the linear segment, `ceil(ONE / min_deposit)`.
    pub fn margin(&self) -> u128 {
        ONE.div_ceil(self.min_deposit)
    }

    fn fraction(&self, t: Timestamp) -> u128 {
        if self.start > t {
            return 0;
        }
        if self.cliff > t {
            return portion(ONE, self.start_unlock, self.total);
        }
        if self.end <= t {
            return ONE;
        }
        let unlocked = self.start_unlock + self.cliff_unlock;
        let at_cliff = portion(ONE, unlocked, self.total);
        let base = if self.cliff == 0 {
            self.start
        } else {
            self.cliff
        };
        let elapsed = (t - base) / self.granularity * self.granularity;
        // `elapsed < end - base` and `total - unlocked <= total`, so the result is below `ONE`;
        // the fallback can only lower the fraction.
        let streamed = math::mul_div_wide(
            &[ONE, u128::from(elapsed), self.total - unlocked],
            &[u128::from(self.end - base), self.total],
            Rounding::Down,
        )
        .unwrap_or(0);
        (at_cliff + streamed)
            .saturating_sub(self.margin())
            .max(at_cliff)
    }
}

/// Normalized schedule of a class of Streamflow streams.
///
/// Streamflow's unlocked amount is an exact multiple of the reduced schedule (`min` of two
/// multiples, no rounding), so `f(t) = floor(ONE * unlocked(t) / net_amount_deposited)` is the same
/// for every member and needs no margin.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, BorshSerialize, BorshDeserialize,
)]
pub struct SteppedClass {
    start: Timestamp,
    end: Timestamp,
    period: u64,
    cliff_amount: u128,
    amount_per_period: u128,
    total: u128,
}

impl SteppedClass {
    fn new(stream: &StreamflowStream) -> Self {
        let p = stream.params();
        let total = u128::from(p.net_amount_deposited);
        let cliff_amount = u128::from(p.cliff_amount);
        let amount_per_period = u128::from(p.amount_per_period);
        let divisor = gcd(gcd(total, cliff_amount), amount_per_period);
        Self {
            start: stream.effective_start(),
            end: p.end_time,
            period: p.period,
            cliff_amount: cliff_amount / divisor,
            amount_per_period: amount_per_period / divisor,
            total: total / divisor,
        }
    }

    /// Effective start (the cliff when set, else the start time).
    pub fn start(&self) -> Timestamp {
        self.start
    }

    /// End time.
    pub fn end(&self) -> Timestamp {
        self.end
    }

    /// Period in seconds.
    pub fn period(&self) -> u64 {
        self.period
    }

    /// Reduced cliff amount.
    pub fn cliff_amount(&self) -> u128 {
        self.cliff_amount
    }

    /// Reduced amount per period.
    pub fn amount_per_period(&self) -> u128 {
        self.amount_per_period
    }

    /// Reduced total.
    pub fn total(&self) -> u128 {
        self.total
    }

    fn fraction(&self, t: Timestamp) -> u128 {
        if t < self.start {
            return 0;
        }
        if t >= self.end {
            return ONE;
        }
        let periods = u128::from((t - self.start) / self.period);
        let unlocked = periods
            .checked_mul(self.amount_per_period)
            .and_then(|vested| vested.checked_add(self.cliff_amount))
            .map_or(self.total, |vested| vested.min(self.total));
        portion(ONE, unlocked, self.total)
    }
}

/// Tokens accrued by `balance` units while the class fraction moves from `from` to `to`:
/// `floor(balance * (to - from) / ONE)`. Returns `0` when `to <= from`.
pub fn accrual(balance: u128, from: u128, to: u128) -> u128 {
    portion(balance, to.saturating_sub(from), ONE)
}

/// `floor(value * numerator / denominator)` for `numerator <= denominator`: the result never
/// exceeds `value`. Class constructors guarantee a non-zero denominator; a zero denominator returns
/// `value` unchanged.
fn portion(value: u128, numerator: u128, denominator: u128) -> u128 {
    math::mul_div_floor(value, numerator.min(denominator), denominator).unwrap_or(value)
}

fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        (a, b) = (b, a % b);
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sablier(params: SablierLinearParams) -> SablierLinearStream {
        SablierLinearStream::new(params).expect("valid stream")
    }

    fn base_params() -> SablierLinearParams {
        SablierLinearParams {
            start: 1_000,
            cliff: 2_000,
            end: 11_000,
            granularity: 1,
            start_unlock: 100,
            cliff_unlock: 200,
            deposited: 10_000,
        }
    }

    #[test]
    fn sablier_streamed_amount_follows_lockup_math() {
        let stream = sablier(base_params());
        assert_eq!(stream.streamed_amount(999), 0);
        assert_eq!(stream.streamed_amount(1_000), 100);
        assert_eq!(stream.streamed_amount(1_999), 100);
        assert_eq!(stream.streamed_amount(2_000), 300);
        // 300 + floor(4500 * 9700 / 9000) = 300 + 4850
        assert_eq!(stream.streamed_amount(6_500), 5_150);
        assert_eq!(stream.streamed_amount(10_999), 300 + 9_700 * 8_999 / 9_000);
        assert_eq!(stream.streamed_amount(11_000), 10_000);
    }

    #[test]
    fn sablier_granularity_creates_steps() {
        let stream = sablier(SablierLinearParams {
            cliff: 0,
            cliff_unlock: 0,
            granularity: 1_000,
            ..base_params()
        });
        assert_eq!(stream.streamed_amount(1_000), 100);
        assert_eq!(stream.streamed_amount(1_999), 100);
        assert_eq!(stream.streamed_amount(2_000), 100 + 9_900 / 10);
        assert_eq!(stream.streamed_amount(2_999), 100 + 9_900 / 10);
    }

    #[test]
    fn sablier_validation_mirrors_creation_checks() {
        let invalid = |params, error| {
            assert_eq!(SablierLinearStream::new(params), Err(error));
        };
        let base = base_params();
        invalid(
            SablierLinearParams {
                deposited: 0,
                ..base
            },
            ScheduleError::ZeroDeposit,
        );
        invalid(
            SablierLinearParams { start: 0, ..base },
            ScheduleError::ZeroStartTime,
        );
        invalid(
            SablierLinearParams {
                cliff: 1_000,
                ..base
            },
            ScheduleError::StartNotBeforeCliff,
        );
        invalid(
            SablierLinearParams {
                cliff: 11_000,
                ..base
            },
            ScheduleError::CliffNotBeforeEnd,
        );
        invalid(
            SablierLinearParams { cliff: 0, ..base },
            ScheduleError::CliffUnlockWithoutCliff,
        );
        invalid(
            SablierLinearParams {
                cliff: 0,
                cliff_unlock: 0,
                end: 1_000,
                ..base
            },
            ScheduleError::StartNotBeforeEnd,
        );
        invalid(
            SablierLinearParams {
                granularity: 0,
                ..base
            },
            ScheduleError::ZeroGranularity,
        );
        invalid(
            SablierLinearParams {
                granularity: 9_001,
                ..base
            },
            ScheduleError::GranularityTooHigh,
        );
        invalid(
            SablierLinearParams {
                start_unlock: 9_801,
                ..base
            },
            ScheduleError::UnlockAmountsExceedDeposit,
        );
        invalid(
            SablierLinearParams {
                start_unlock: u128::MAX,
                ..base
            },
            ScheduleError::UnlockAmountsExceedDeposit,
        );
    }

    #[test]
    fn streamflow_unlocked_amount_steps_per_period() {
        let stream = StreamflowStream::new(StreamflowParams {
            start_time: 100,
            cliff: 200,
            cliff_amount: 50,
            period: 10,
            amount_per_period: 7,
            net_amount_deposited: 1_000,
            end_time: 1_560,
        })
        .expect("valid stream");
        assert_eq!(stream.unlocked_amount(150), 0);
        assert_eq!(stream.unlocked_amount(199), 0);
        assert_eq!(stream.unlocked_amount(200), 50);
        assert_eq!(stream.unlocked_amount(209), 50);
        assert_eq!(stream.unlocked_amount(210), 57);
        assert_eq!(stream.unlocked_amount(1_559), 50 + 135 * 7);
        assert_eq!(stream.unlocked_amount(1_560), 1_000);
    }

    #[test]
    fn streamflow_without_cliff_starts_at_start_time() {
        let stream = StreamflowStream::new(StreamflowParams {
            start_time: 100,
            cliff: 0,
            cliff_amount: 0,
            period: 1,
            amount_per_period: 1,
            net_amount_deposited: 10,
            end_time: 110,
        })
        .expect("valid stream");
        assert_eq!(stream.unlocked_amount(99), 0);
        assert_eq!(stream.unlocked_amount(100), 0);
        assert_eq!(stream.unlocked_amount(105), 5);
        assert_eq!(stream.unlocked_amount(110), 10);
    }

    #[test]
    fn proportional_streams_share_a_class() {
        let small = sablier(SablierLinearParams {
            deposited: 1_000_000,
            start_unlock: 10_000,
            cliff_unlock: 20_000,
            ..base_params()
        });
        let large = sablier(SablierLinearParams {
            deposited: 3_000_000,
            start_unlock: 30_000,
            cliff_unlock: 60_000,
            ..base_params()
        });
        let other = sablier(SablierLinearParams {
            deposited: 3_000_001,
            start_unlock: 30_000,
            cliff_unlock: 60_000,
            ..base_params()
        });
        let a = ClassSchedule::from_sablier(&small, 6).expect("class");
        let b = ClassSchedule::from_sablier(&large, 6).expect("class");
        let c = ClassSchedule::from_sablier(&other, 6).expect("class");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, ClassSchedule::from_sablier(&large, 5).expect("class"));
        assert_eq!(
            ClassSchedule::from_sablier(&small, 7),
            Err(ScheduleError::DepositBelowMinimum)
        );
        assert_eq!(
            ClassSchedule::from_sablier(&small, 39),
            Err(ScheduleError::TokenDecimalsTooLarge)
        );
    }

    #[test]
    fn streamflow_classes_normalize_amounts_and_start() {
        let params = StreamflowParams {
            start_time: 100,
            cliff: 200,
            cliff_amount: 50,
            period: 10,
            amount_per_period: 10,
            net_amount_deposited: 1_000,
            end_time: 1_160,
        };
        let a = StreamflowStream::new(params).expect("valid");
        let b = StreamflowStream::new(StreamflowParams {
            start_time: 150,
            cliff_amount: 150,
            amount_per_period: 30,
            net_amount_deposited: 3_000,
            ..params
        })
        .expect("valid");
        let c = StreamflowStream::new(StreamflowParams {
            amount_per_period: 11,
            ..params
        })
        .expect("valid");
        assert_eq!(
            ClassSchedule::from_streamflow(&a),
            ClassSchedule::from_streamflow(&b)
        );
        assert_ne!(
            ClassSchedule::from_streamflow(&a),
            ClassSchedule::from_streamflow(&c)
        );
    }

    #[test]
    fn linear_class_fraction_shape() {
        let stream = sablier(SablierLinearParams {
            deposited: 10_000_000,
            start_unlock: 1_000_000,
            cliff_unlock: 2_000_000,
            ..base_params()
        });
        let class = ClassSchedule::from_sablier(&stream, 6).expect("class");
        assert_eq!(class.fraction(999), 0);
        assert_eq!(class.fraction(1_000), ONE / 10);
        assert_eq!(class.fraction(2_000), 3 * ONE / 10);
        assert_eq!(class.fraction(11_000), ONE);
        let mid = class.fraction(6_500);
        let exact = 3 * ONE / 10 + 7 * ONE / 10 / 2;
        assert!(mid <= exact && exact - mid <= ONE / 1_000_000 + 2);
    }

    #[test]
    fn accrual_is_floor_of_the_fraction_delta() {
        assert_eq!(accrual(1_000, 0, ONE / 3), 333);
        assert_eq!(accrual(1_000, ONE / 3, ONE / 3), 0);
        assert_eq!(accrual(1_000, ONE, 0), 0);
        assert_eq!(accrual(u128::MAX, 0, ONE), u128::MAX);
    }
}
