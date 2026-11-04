//! Property tests of the unlock math: exact ports against literal references, and the class
//! unlock function's monotonicity, bounds, normalization and pool safety.

use proptest::prelude::*;
use rose_engine::math::{mul_div_ceil, mul_div_floor, ONE};
use rose_engine::unlock::{
    accrual, ClassSchedule, SablierLinearParams, SablierLinearStream, StreamflowParams,
    StreamflowStream, Timestamp,
};

/// `LockupMath.calculateStreamedAmountLL` transcribed statement by statement on small values.
fn sablier_reference(p: &SablierLinearParams, now: Timestamp) -> u128 {
    if p.start > now {
        return 0;
    }
    if p.cliff > now {
        return p.start_unlock;
    }
    if p.end <= now {
        return p.deposited;
    }
    let sum = p.start_unlock + p.cliff_unlock;
    if sum >= p.deposited {
        return p.deposited;
    }
    let (elapsed_units, duration) = if p.cliff == 0 {
        ((now - p.start) / p.granularity, p.end - p.start)
    } else {
        ((now - p.cliff) / p.granularity, p.end - p.cliff)
    };
    let streamable = p.deposited - sum;
    let portion =
        u128::from(elapsed_units) * streamable * u128::from(p.granularity) / u128::from(duration);
    sum + portion
}

/// Streamflow rust-sdk `available_to_claim` (+ withdrawn) for a never-paused, never-updated
/// stream, capped at the deposit like the JS SDK.
fn streamflow_reference(p: &StreamflowParams, now: Timestamp) -> u128 {
    let start_time = if p.cliff > 0 { p.cliff } else { p.start_time };
    if start_time > now {
        return 0;
    }
    if now >= p.end_time {
        return u128::from(p.net_amount_deposited);
    }
    let vested = u128::from((now - start_time) / p.period) * u128::from(p.amount_per_period);
    let cliff = if now < p.cliff {
        0
    } else {
        u128::from(p.cliff_amount)
    };
    (vested + cliff).min(u128::from(p.net_amount_deposited))
}

#[derive(Debug, Clone)]
struct SablierCase {
    decimals: u8,
    members: [SablierLinearParams; 2],
}

fn sablier_case() -> impl Strategy<Value = SablierCase> {
    (
        1u64..1_000_000,
        prop::option::of(1u64..10_000),
        1u64..50_000,
        0u8..=18,
        1u128..2_000,
        0u128..=100,
        0u128..=100,
        (1u128..1_000, 1u128..1_000),
        1u64..=8,
    )
        .prop_map(
            |(start, cliff_offset, span, decimals, total, s_pct, c_pct, (m1, m2), g_div)| {
                let start_unlock = total * s_pct / 200;
                let cliff_unlock = if cliff_offset.is_some() {
                    total * c_pct / 200
                } else {
                    0
                };
                let cliff = cliff_offset.map_or(0, |offset| start + offset);
                let base = if cliff == 0 { start } else { cliff };
                let end = base + span;
                let granularity = (span / g_div).max(1);
                let floor_multiplier = 10u128.pow(u32::from(decimals)).div_ceil(total);
                let member = |m: u128| {
                    let scale = floor_multiplier * m;
                    SablierLinearParams {
                        start,
                        cliff,
                        end,
                        granularity,
                        start_unlock: start_unlock * scale,
                        cliff_unlock: cliff_unlock * scale,
                        deposited: total * scale,
                    }
                };
                SablierCase {
                    decimals,
                    members: [member(m1), member(m2)],
                }
            },
        )
}

fn times(start: Timestamp, end: Timestamp) -> impl Strategy<Value = Vec<Timestamp>> {
    prop::collection::vec(start.saturating_sub(50)..end + 50, 1..24).prop_map(|mut times| {
        times.sort_unstable();
        times
    })
}

fn sablier_case_with_times() -> impl Strategy<Value = (SablierCase, Vec<Timestamp>)> {
    sablier_case().prop_flat_map(|case| {
        let p = case.members[0];
        (Just(case), times(p.start, p.end))
    })
}

#[derive(Debug, Clone)]
struct StreamflowCase {
    members: [StreamflowParams; 2],
}

fn streamflow_case() -> impl Strategy<Value = StreamflowCase> {
    (
        1u64..1_000_000,
        prop::option::of(0u64..10_000),
        1u64..5_000,
        1u64..10_000,
        0u64..=100,
        0u64..=100,
        (1u64..1_000_000, 1u64..1_000_000),
        -3i64..3,
    )
        .prop_map(
            |(start_time, cliff_offset, period, total, c_pct, a_pct, (m1, m2), end_shift)| {
                let cliff = cliff_offset.map_or(0, |offset| start_time + offset);
                let effective_start = if cliff > 0 { cliff } else { start_time };
                let cliff_amount = total * c_pct / 100;
                let amount_per_period = (total * a_pct / 1_000).max(1);
                let periods = (total - cliff_amount).div_ceil(amount_per_period);
                let end_time = (effective_start + periods * period)
                    .saturating_add_signed(end_shift)
                    .max(effective_start);
                let member = |m: u64| StreamflowParams {
                    start_time,
                    cliff,
                    cliff_amount: cliff_amount * m,
                    period,
                    amount_per_period: amount_per_period * m,
                    net_amount_deposited: total * m,
                    end_time,
                };
                StreamflowCase {
                    members: [member(m1), member(m2)],
                }
            },
        )
}

fn streamflow_case_with_times() -> impl Strategy<Value = (StreamflowCase, Vec<Timestamp>)> {
    streamflow_case().prop_flat_map(|case| {
        let p = case.members[0];
        (Just(case), times(p.start_time, p.end_time))
    })
}

fn check_fraction_shape(class: &ClassSchedule, start: Timestamp, end: Timestamp, ts: &[Timestamp]) {
    let mut previous = 0;
    for &t in ts {
        let f = class.fraction(t);
        assert!(f <= ONE);
        assert!(f >= previous, "monotone");
        if t < start {
            assert_eq!(f, 0);
        }
        if t >= end {
            assert_eq!(f, ONE);
        }
        previous = f;
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1_000))]

    #[test]
    fn sablier_port_matches_reference((case, ts) in sablier_case_with_times()) {
        for params in case.members {
            let stream = SablierLinearStream::new(params).unwrap();
            let mut previous = 0;
            for &t in &ts {
                let streamed = stream.streamed_amount(t);
                prop_assert_eq!(streamed, sablier_reference(&params, t));
                prop_assert!(streamed >= previous && streamed <= params.deposited);
                previous = streamed;
            }
        }
    }

    #[test]
    fn sablier_class_is_shared_monotone_and_safe((case, ts) in sablier_case_with_times()) {
        let streams = case.members.map(|params| SablierLinearStream::new(params).unwrap());
        let class = ClassSchedule::from_sablier(&streams[0], case.decimals).unwrap();
        prop_assert_eq!(class, ClassSchedule::from_sablier(&streams[1], case.decimals).unwrap());
        let ClassSchedule::Linear(linear) = class else {
            unreachable!("a Sablier stream yields a linear class")
        };
        let p = case.members[0];
        check_fraction_shape(&class, p.start, p.end, &ts);
        for &t in &ts {
            let f = class.fraction(t);
            for stream in &streams {
                let deposited = stream.params().deposited;
                let streamed = stream.streamed_amount(t);
                // D * f / ONE <= streamed, exactly.
                prop_assert!(mul_div_ceil(deposited, f, ONE).unwrap() <= streamed);
                let exact = mul_div_floor(streamed, ONE, deposited).unwrap();
                prop_assert!(f + linear.margin() + 2 >= exact, "tight within the margin");
            }
        }
    }

    #[test]
    fn streamflow_port_matches_reference((case, ts) in streamflow_case_with_times()) {
        for params in case.members {
            let stream = StreamflowStream::new(params).unwrap();
            let mut previous = 0;
            for &t in &ts {
                let unlocked = stream.unlocked_amount(t);
                prop_assert_eq!(unlocked, streamflow_reference(&params, t));
                prop_assert!(unlocked >= previous);
                prop_assert!(unlocked <= u128::from(params.net_amount_deposited));
                previous = unlocked;
            }
        }
    }

    #[test]
    fn streamflow_class_is_shared_and_exact((case, ts) in streamflow_case_with_times()) {
        let streams = case.members.map(|params| StreamflowStream::new(params).unwrap());
        let class = ClassSchedule::from_streamflow(&streams[0]);
        prop_assert_eq!(class, ClassSchedule::from_streamflow(&streams[1]));
        check_fraction_shape(&class, streams[0].effective_start(), case.members[0].end_time, &ts);
        for &t in &ts {
            for stream in &streams {
                let deposited = u128::from(stream.params().net_amount_deposited);
                let exact = mul_div_floor(stream.unlocked_amount(t), ONE, deposited).unwrap();
                prop_assert_eq!(class.fraction(t), exact);
            }
        }
    }

    #[test]
    fn holders_never_accrue_more_than_the_streams_unlocked(
        (case, ts) in sablier_case_with_times(),
        shares in prop::collection::vec(1u128..1_000, 1..6),
        schedules in prop::collection::vec(prop::collection::vec(any::<bool>(), 24), 6),
    ) {
        let streams = case.members.map(|params| SablierLinearStream::new(params).unwrap());
        let class = ClassSchedule::from_sablier(&streams[0], case.decimals).unwrap();
        let units: u128 = streams.iter().map(|stream| stream.params().deposited).sum();
        let share_total: u128 = shares.iter().sum();
        let mut balances: Vec<u128> = shares.iter().map(|share| units * share / share_total).collect();
        balances[0] += units - balances.iter().sum::<u128>();

        let last = *ts.last().unwrap();
        let mut accrued = 0u128;
        for (balance, checkpoints) in balances.iter().zip(&schedules) {
            let mut checkpoint = 0u128;
            for (&t, &touch) in ts.iter().zip(checkpoints) {
                if touch {
                    let f = class.fraction(t);
                    accrued += accrual(*balance, checkpoint, f);
                    checkpoint = f;
                }
            }
            accrued += accrual(*balance, checkpoint, class.fraction(last));
        }
        let unlocked: u128 = streams.iter().map(|stream| stream.streamed_amount(last)).sum();
        prop_assert!(accrued <= unlocked, "rounding favors the pool");
    }

    #[test]
    fn accrual_is_superadditive_within_two_units(
        balance in 0u128..1_000_000_000_000_000_000_000_000_000,
        mut marks in prop::collection::vec(0u128..=ONE, 3),
    ) {
        marks.sort_unstable();
        let (a, b, c) = (marks[0], marks[1], marks[2]);
        let whole = accrual(balance, a, c);
        let split = accrual(balance, a, b) + accrual(balance, b, c);
        prop_assert!(whole >= split);
        prop_assert!(whole - split < 2);
        prop_assert_eq!(accrual(balance, c, a), 0);
    }

    #[test]
    fn non_proportional_amounts_change_the_class(
        case in sablier_case(),
        bump in 1u128..1_000,
    ) {
        let p = case.members[0];
        prop_assume!(p.start_unlock + p.cliff_unlock + bump <= p.deposited);
        let base = SablierLinearStream::new(p).unwrap();
        let bumped = SablierLinearStream::new(SablierLinearParams {
            start_unlock: p.start_unlock + bump,
            ..p
        })
        .unwrap();
        prop_assert_ne!(
            ClassSchedule::from_sablier(&base, case.decimals).unwrap(),
            ClassSchedule::from_sablier(&bumped, case.decimals).unwrap()
        );
    }
}
