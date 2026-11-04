//! Deterministic JSON test vectors for the TypeScript reference implementation
//! (`packages/sdk`). The test fails when the committed files differ from what the engine computes;
//! run it with `ROSE_UPDATE_VECTORS=1` to regenerate them after an intended change.
//!
//! Every integer that can exceed 2^53 is encoded as a decimal string.

use std::{env, fs, path::PathBuf};

use rose_engine::clearing::{
    advance, exit, fee, tender, AdvanceAsk, Fill, Order, Outcome, Pricing, UniformClearing,
    BPS_DENOMINATOR, FEE_BPS,
};
use rose_engine::math::ONE;
use rose_engine::unlock::{
    accrual, ClassSchedule, SablierLinearParams, SablierLinearStream, StreamflowParams,
    StreamflowStream, Timestamp,
};
use serde_json::{json, Value};

/// xorshift64*: a fixed generator so the vectors never change between runs.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn text(value: u128) -> Value {
    Value::String(value.to_string())
}

fn order(id: u64, qty: u128, price: u128) -> Order {
    Order { id, qty, price }
}

fn orders_json(orders: &[Order]) -> Value {
    orders
        .iter()
        .map(|o| json!({ "id": o.id, "qty": text(o.qty), "price": text(o.price) }))
        .collect()
}

fn fills_json(fills: &[Fill], with_fee: bool) -> Value {
    fills
        .iter()
        .map(|f| {
            let mut fill = json!({ "id": f.id, "qty": text(f.qty), "cash": text(f.cash) });
            if with_fee {
                fill["fee"] = text(fee(f.cash).unwrap());
            }
            fill
        })
        .collect()
}

fn pricing_json(pricing: Pricing) -> Value {
    json!({
        "locked_fraction_e18": text(pricing.locked_fraction_e18),
        "token_decimals": pricing.token_decimals,
    })
}

const UNIT: Pricing = Pricing {
    locked_fraction_e18: ONE,
    token_decimals: 0,
};

fn tender_case(
    name: &str,
    asks: &[Order],
    budget: u128,
    max_price: u128,
    pricing: Pricing,
) -> Value {
    let expected = match tender(asks, budget, max_price, pricing).unwrap() {
        Outcome::NoCrossing => json!({ "outcome": "no_crossing" }),
        Outcome::Cleared(c) => json!({
            "outcome": "cleared",
            "price": text(c.price),
            "volume": text(c.volume),
            "asks": fills_json(&c.asks, false),
            "charged": text(c.charged),
            "fee": text(fee(c.charged).unwrap()),
            "refund": text(c.refund),
        }),
    };
    json!({
        "name": name,
        "round": "tender",
        "input": {
            "pricing": pricing_json(pricing),
            "budget": text(budget),
            "max_price": text(max_price),
            "asks": orders_json(asks),
        },
        "expected": expected,
    })
}

fn uniform_expected(outcome: Outcome<UniformClearing>) -> Value {
    match outcome {
        Outcome::NoCrossing => json!({ "outcome": "no_crossing" }),
        Outcome::Cleared(c) => json!({
            "outcome": "cleared",
            "price": text(c.price),
            "volume": text(c.volume),
            "bids": fills_json(&c.bids, true),
            "asks": fills_json(&c.asks, false),
            "notional": text(c.notional),
        }),
    }
}

fn exit_case(name: &str, bids: &[Order], asks: &[Order], pricing: Pricing) -> Value {
    json!({
        "name": name,
        "round": "exit",
        "input": {
            "pricing": pricing_json(pricing),
            "bids": orders_json(bids),
            "asks": orders_json(asks),
        },
        "expected": uniform_expected(exit(bids, asks, pricing).unwrap()),
    })
}

fn advance_case(name: &str, ask: AdvanceAsk, bids: &[Order], token_decimals: u8) -> Value {
    json!({
        "name": name,
        "round": "advance",
        "input": {
            "token_decimals": token_decimals,
            "ask": {
                "id": ask.id,
                "claim": text(ask.claim),
                "reserve": text(ask.reserve),
                "min_fill": text(ask.min_fill),
            },
            "bids": orders_json(bids),
        },
        "expected": uniform_expected(advance(ask, bids, token_decimals).unwrap()),
    })
}

fn random_book(rng: &mut Rng, len: u64, max_qty: u64, max_price: u64) -> Vec<Order> {
    (0..rng.below(len) + 1)
        .map(|i| {
            order(
                i * 2 + 1,
                u128::from(rng.below(max_qty)),
                u128::from(rng.below(max_price)),
            )
        })
        .collect()
}

fn clearing_vectors() -> Value {
    let mut cases = vec![
        tender_case(
            "tender: spec example",
            &[order(1, 100, 9), order(2, 10, 10)],
            950,
            10,
            UNIT,
        ),
        tender_case(
            "tender: marginal level rationed by largest remainder",
            &[order(1, 30, 5), order(2, 40, 8), order(3, 20, 8)],
            400,
            10,
            UNIT,
        ),
        tender_case(
            "tender: equal volumes tie to the lowest price",
            &[order(1, 10, 5), order(2, 10, 6)],
            60,
            10,
            UNIT,
        ),
        tender_case(
            "tender: equal remainders tie to the lower id",
            &[order(9, 1, 5), order(3, 1, 5), order(5, 1, 5)],
            10,
            5,
            UNIT,
        ),
        tender_case(
            "tender: asks above the max price never fill",
            &[order(1, 10, 11), order(2, 5, 12)],
            1_000,
            10,
            UNIT,
        ),
        tender_case("tender: zero budget", &[order(1, 10, 1)], 0, 10, UNIT),
        tender_case("tender: empty book", &[], 1_000, 10, UNIT),
        tender_case(
            "tender: zero-price asks",
            &[order(1, 7, 0), order(2, 3, 4)],
            8,
            5,
            UNIT,
        ),
        tender_case(
            "tender: rounding dust stays in the pool",
            &[order(1, 7, 100), order(2, 5, 100)],
            3,
            100,
            Pricing {
                locked_fraction_e18: ONE / 3,
                token_decimals: 2,
            },
        ),
        tender_case(
            "tender: 18 decimals, 60% locked, USDC prices",
            &[
                order(1, 250_000 * ONE, 410_000),
                order(2, 100_000 * ONE, 395_000),
                order(3, 400_000 * ONE, 450_000),
            ],
            100_000_000_000,
            430_000,
            Pricing {
                locked_fraction_e18: 600_000_000_000_000_000,
                token_decimals: 18,
            },
        ),
        exit_case(
            "exit: midpoint of the tied interval",
            &[order(1, 10, 15), order(2, 10, 12)],
            &[order(1, 15, 5)],
            UNIT,
        ),
        exit_case(
            "exit: smallest imbalance wins the tie",
            &[order(1, 10, 10), order(2, 5, 7)],
            &[order(1, 10, 6), order(2, 10, 8)],
            UNIT,
        ),
        exit_case(
            "exit: long buyers rationed, extra unit to the lowest id",
            &[order(3, 6, 10), order(1, 6, 10), order(2, 6, 10)],
            &[order(1, 10, 10)],
            UNIT,
        ),
        exit_case(
            "exit: long sellers rationed at the margin",
            &[order(1, 25, 20)],
            &[order(1, 10, 3), order(2, 12, 7), order(3, 8, 7)],
            UNIT,
        ),
        exit_case(
            "exit: balanced book",
            &[order(1, 10, 9), order(2, 10, 8)],
            &[order(1, 10, 6), order(2, 10, 7)],
            UNIT,
        ),
        exit_case(
            "exit: no overlap",
            &[order(1, 10, 4)],
            &[order(1, 10, 5)],
            UNIT,
        ),
        exit_case("exit: empty book", &[], &[], UNIT),
        exit_case(
            "exit: 6 decimals, 25% locked",
            &[
                order(1, 3_000_000_000, 2_100_000),
                order(2, 1_500_000_000, 1_900_000),
            ],
            &[
                order(1, 4_000_000_000, 1_800_000),
                order(2, 900_000_000, 2_000_000),
            ],
            Pricing {
                locked_fraction_e18: 250_000_000_000_000_000,
                token_decimals: 6,
            },
        ),
        advance_case(
            "advance: partial fill above the minimum",
            AdvanceAsk {
                id: 7,
                claim: 100,
                reserve: 10,
                min_fill: 40,
            },
            &[order(1, 30, 12), order(2, 20, 11)],
            0,
        ),
        advance_case(
            "advance: below the minimum fill",
            AdvanceAsk {
                id: 7,
                claim: 100,
                reserve: 10,
                min_fill: 51,
            },
            &[order(1, 30, 12), order(2, 20, 11)],
            0,
        ),
        advance_case(
            "advance: oversubscribed, funders rationed",
            AdvanceAsk {
                id: 1,
                claim: 50,
                reserve: 8,
                min_fill: 50,
            },
            &[order(1, 40, 9), order(2, 20, 9), order(3, 10, 12)],
            0,
        ),
        advance_case(
            "advance: 18 decimals",
            AdvanceAsk {
                id: 1,
                claim: 5_000 * ONE,
                reserve: 700_000,
                min_fill: 1_000 * ONE,
            },
            &[
                order(1, 2_000 * ONE, 750_000),
                order(2, 4_000 * ONE, 720_000),
            ],
            18,
        ),
    ];

    let mut rng = Rng(0x5eed_c1ea_0005_0f0f);
    for k in 0..4 {
        let asks = random_book(&mut rng, 8, 40, 14);
        let budget = u128::from(rng.below(800));
        let max_price = u128::from(rng.below(14));
        cases.push(tender_case(
            &format!("tender: generated {k}"),
            &asks,
            budget,
            max_price,
            UNIT,
        ));
    }
    for k in 0..5 {
        let bids = random_book(&mut rng, 8, 40, 14);
        let asks = random_book(&mut rng, 8, 40, 14);
        let pricing = Pricing {
            locked_fraction_e18: u128::from(rng.below(1_000_000)) * 1_000_000_000_000 + 1,
            token_decimals: 0,
        };
        cases.push(exit_case(
            &format!("exit: generated {k}"),
            &bids,
            &asks,
            pricing,
        ));
    }
    for k in 0..3 {
        let bids = random_book(&mut rng, 8, 40, 14);
        let claim = u128::from(rng.below(120)) + 1;
        let ask = AdvanceAsk {
            id: 1,
            claim,
            reserve: u128::from(rng.below(14)),
            min_fill: claim * u128::from(rng.below(100)) / 100,
        };
        cases.push(advance_case(
            &format!("advance: generated {k}"),
            ask,
            &bids,
            0,
        ));
    }

    json!({
        "description": "rose clearing vectors. Quantities are units (token base units); prices are cash base units per whole locked token (per claimed token in an Advance); buyers' cash is rounded up, sellers' cash rounded down; fees are ceil(cash * fee_bps / bps_denominator) per buyer.",
        "fee_bps": FEE_BPS,
        "bps_denominator": BPS_DENOMINATOR,
        "cases": cases,
    })
}

fn class_json(class: &ClassSchedule) -> Value {
    match class {
        ClassSchedule::Linear(c) => json!({
            "kind": "linear",
            "start": c.start(),
            "cliff": c.cliff(),
            "end": c.end(),
            "granularity": c.granularity(),
            "start_unlock": text(c.start_unlock()),
            "cliff_unlock": text(c.cliff_unlock()),
            "total": text(c.total()),
            "min_deposit": text(c.min_deposit()),
            "margin": text(c.margin()),
        }),
        ClassSchedule::Stepped(c) => json!({
            "kind": "stepped",
            "start": c.start(),
            "end": c.end(),
            "period": c.period(),
            "cliff_amount": text(c.cliff_amount()),
            "amount_per_period": text(c.amount_per_period()),
            "total": text(c.total()),
        }),
    }
}

fn sample_times(start: Timestamp, cliff: Timestamp, end: Timestamp) -> Vec<Timestamp> {
    let mut times = vec![start.saturating_sub(1), start, end - 1, end, end + 1_000];
    if cliff > 0 {
        times.extend([cliff - 1, cliff, cliff + 1]);
    }
    let base = if cliff > 0 { cliff } else { start };
    times.extend((1..8).map(|k| base + (end - base) * k / 8));
    times.sort_unstable();
    times.dedup();
    times
}

fn sablier_case(name: &str, params: SablierLinearParams, token_decimals: u8) -> Value {
    let stream = SablierLinearStream::new(params).unwrap();
    let class = ClassSchedule::from_sablier(&stream, token_decimals).unwrap();
    let points: Vec<Value> = sample_times(params.start, params.cliff, params.end)
        .into_iter()
        .map(|t| {
            json!({
                "t": t,
                "streamed": text(stream.streamed_amount(t)),
                "fraction": text(class.fraction(t)),
            })
        })
        .collect();
    json!({
        "name": name,
        "kind": "sablier_linear",
        "input": {
            "start": params.start,
            "cliff": params.cliff,
            "end": params.end,
            "granularity": params.granularity,
            "start_unlock": text(params.start_unlock),
            "cliff_unlock": text(params.cliff_unlock),
            "deposited": text(params.deposited),
            "token_decimals": token_decimals,
        },
        "class": class_json(&class),
        "points": points,
    })
}

fn streamflow_case(name: &str, params: StreamflowParams) -> Value {
    let stream = StreamflowStream::new(params).unwrap();
    let class = ClassSchedule::from_streamflow(&stream);
    let points: Vec<Value> = sample_times(params.start_time, params.cliff, params.end_time)
        .into_iter()
        .map(|t| {
            json!({
                "t": t,
                "unlocked": text(stream.unlocked_amount(t)),
                "fraction": text(class.fraction(t)),
            })
        })
        .collect();
    json!({
        "name": name,
        "kind": "streamflow",
        "input": {
            "start_time": params.start_time,
            "cliff": params.cliff,
            "cliff_amount": text(u128::from(params.cliff_amount)),
            "period": params.period,
            "amount_per_period": text(u128::from(params.amount_per_period)),
            "net_amount_deposited": text(u128::from(params.net_amount_deposited)),
            "end_time": params.end_time,
        },
        "class": class_json(&class),
        "points": points,
    })
}

fn unlock_vectors() -> Value {
    let day = 86_400;
    let t0 = 1_767_225_600;
    let sablier_base = SablierLinearParams {
        start: t0,
        cliff: 0,
        end: t0 + 365 * day,
        granularity: 1,
        start_unlock: 0,
        cliff_unlock: 0,
        deposited: 1_000_000 * ONE,
    };
    let mut sablier = vec![
        sablier_case("sablier: plain linear, 18 decimals", sablier_base, 18),
        sablier_case(
            "sablier: start unlock, no cliff",
            SablierLinearParams {
                start_unlock: 100_000 * ONE,
                ..sablier_base
            },
            18,
        ),
        sablier_case(
            "sablier: cliff with start and cliff unlocks",
            SablierLinearParams {
                cliff: t0 + 90 * day,
                start_unlock: 50_000 * ONE,
                cliff_unlock: 200_000 * ONE,
                ..sablier_base
            },
            18,
        ),
        sablier_case(
            "sablier: daily granularity",
            SablierLinearParams {
                granularity: day,
                ..sablier_base
            },
            18,
        ),
        sablier_case(
            "sablier: monthly steps after a cliff",
            SablierLinearParams {
                cliff: t0 + 180 * day,
                end: t0 + 540 * day,
                granularity: 30 * day,
                cliff_unlock: 250_000 * ONE,
                ..sablier_base
            },
            18,
        ),
        sablier_case(
            "sablier: everything unlocked at start and cliff",
            SablierLinearParams {
                cliff: t0 + 10 * day,
                start_unlock: 400_000 * ONE,
                cliff_unlock: 600_000 * ONE,
                ..sablier_base
            },
            18,
        ),
        sablier_case(
            "sablier: 6 decimals, odd total, margin visible",
            SablierLinearParams {
                cliff: t0 + 7 * day,
                start_unlock: 1_234_567,
                cliff_unlock: 7_654_321,
                deposited: 123_456_789_012,
                end: t0 + 100 * day,
                ..sablier_base
            },
            6,
        ),
        sablier_case(
            "sablier: minimum deposit of one whole token",
            SablierLinearParams {
                deposited: 1_000_000,
                ..sablier_base
            },
            6,
        ),
        sablier_case(
            "sablier: 0 decimals, tiny stream",
            SablierLinearParams {
                start: 100,
                end: 107,
                deposited: 3,
                ..sablier_base
            },
            0,
        ),
    ];
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for k in 0..6 {
        let start = t0 + rng.below(1_000_000);
        let cliff = if rng.below(2) == 0 {
            0
        } else {
            start + rng.below(100 * day) + 1
        };
        let base = if cliff == 0 { start } else { cliff };
        let span = rng.below(400 * day) + 1;
        let decimals = [6u8, 8, 9, 18][usize::try_from(rng.below(4)).unwrap()];
        let deposited = 10u128.pow(u32::from(decimals)) * (u128::from(rng.below(10_000_000)) + 1)
            + u128::from(rng.below(1_000_000));
        let start_unlock = deposited * u128::from(rng.below(30)) / 100;
        let cliff_unlock = if cliff == 0 {
            0
        } else {
            deposited * u128::from(rng.below(30)) / 100
        };
        sablier.push(sablier_case(
            &format!("sablier: generated {k}"),
            SablierLinearParams {
                start,
                cliff,
                end: base + span,
                granularity: (span / (rng.below(50) + 1)).max(1),
                start_unlock,
                cliff_unlock,
                deposited,
            },
            decimals,
        ));
    }

    let streamflow_base = StreamflowParams {
        start_time: t0,
        cliff: 0,
        cliff_amount: 0,
        period: day,
        amount_per_period: 1_000_000_000,
        net_amount_deposited: 365_000_000_000,
        end_time: t0 + 365 * day,
    };
    let mut streamflow = vec![
        streamflow_case("streamflow: daily unlock, no cliff", streamflow_base),
        streamflow_case(
            "streamflow: cliff amount then weekly",
            StreamflowParams {
                cliff: t0 + 30 * day,
                cliff_amount: 65_000_000_000,
                period: 7 * day,
                amount_per_period: 7_000_000_000,
                end_time: t0 + 30 * day + 43 * 7 * day,
                ..streamflow_base
            },
        ),
        streamflow_case(
            "streamflow: last period capped at the deposit",
            StreamflowParams {
                amount_per_period: 1_100_000_000,
                end_time: t0 + 332 * day,
                ..streamflow_base
            },
        ),
        streamflow_case(
            "streamflow: end before the schedule completes",
            StreamflowParams {
                end_time: t0 + 200 * day,
                ..streamflow_base
            },
        ),
        streamflow_case(
            "streamflow: one-second periods",
            StreamflowParams {
                period: 1,
                amount_per_period: 3,
                net_amount_deposited: 3_000,
                end_time: t0 + 1_000,
                ..streamflow_base
            },
        ),
        streamflow_case(
            "streamflow: token lock (cliff equals deposit)",
            StreamflowParams {
                cliff: t0 + 100 * day,
                cliff_amount: 365_000_000_000,
                amount_per_period: 1,
                end_time: t0 + 100 * day + 1,
                ..streamflow_base
            },
        ),
    ];
    for k in 0..6 {
        let start_time = t0 + rng.below(1_000_000);
        let cliff = if rng.below(2) == 0 {
            0
        } else {
            start_time + rng.below(60 * day)
        };
        let effective = if cliff > 0 { cliff } else { start_time };
        let net_amount_deposited = rng.below(1_000_000_000_000) + 1;
        let cliff_amount = net_amount_deposited * rng.below(40) / 100;
        let amount_per_period = (net_amount_deposited / (rng.below(500) + 1)).max(1);
        let period = rng.below(7 * day) + 1;
        let periods = (net_amount_deposited - cliff_amount).div_ceil(amount_per_period);
        streamflow.push(streamflow_case(
            &format!("streamflow: generated {k}"),
            StreamflowParams {
                start_time,
                cliff,
                cliff_amount,
                period,
                amount_per_period,
                net_amount_deposited,
                end_time: effective + periods * period,
            },
        ));
    }

    let accruals: Vec<Value> = [
        (1_000u128, 0u128, ONE / 3),
        (1_000, ONE / 3, 2 * ONE / 3),
        (1_000, 0, 2 * ONE / 3),
        (
            1_000_000 * ONE,
            123_456_789_012_345_678,
            987_654_321_098_765_432,
        ),
        (7, ONE / 2, ONE / 2),
        (7, ONE, ONE / 2),
        (u128::MAX, 0, ONE),
    ]
    .into_iter()
    .map(|(balance, from, to)| {
        json!({
            "balance": text(balance),
            "from": text(from),
            "to": text(to),
            "accrual": text(accrual(balance, from, to)),
        })
    })
    .collect();

    json!({
        "description": "rose unlock vectors. Timestamps are Unix seconds; fractions are fixed point with 1e18 = fully unlocked; accrual = floor(balance * max(to - from, 0) / 1e18).",
        "one": text(ONE),
        "sablier_linear": sablier,
        "streamflow": streamflow,
        "accrual": accruals,
    })
}

fn check(file: &str, vectors: Value) {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "vectors", file]
        .iter()
        .collect();
    if env::var_os("ROSE_UPDATE_VECTORS").is_some() {
        let rendered = serde_json::to_string_pretty(&vectors).unwrap() + "\n";
        fs::write(&path, rendered).unwrap();
        return;
    }
    let committed = fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "{} is missing; run with ROSE_UPDATE_VECTORS=1",
            path.display()
        )
    });
    // Compared as JSON values: key order depends on whether a workspace crate enables
    // serde_json's `preserve_order` feature, the content does not.
    let committed: Value = serde_json::from_str(&committed).unwrap();
    assert!(
        committed == vectors,
        "{} is stale; run with ROSE_UPDATE_VECTORS=1",
        path.display()
    );
}

#[test]
fn clearing_vectors_are_current() {
    check("clearing.json", clearing_vectors());
}

#[test]
fn unlock_vectors_are_current() {
    check("unlock.json", unlock_vectors());
}
