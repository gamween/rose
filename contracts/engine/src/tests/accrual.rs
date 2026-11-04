//! Accrual accounting across transfers, round locks and settlement: the sum of every claimable
//! balance never exceeds the class's unlocked amount and lags it by at most one base unit per
//! balance change.

use near_sdk::json_types::U128;
use near_sdk::test_utils::accounts;
use proptest::prelude::*;

use super::*;
use crate::math::ONE;
use crate::types::{ClaimSource, Holder};
use crate::unlock::accrual;

#[derive(Clone, Debug)]
enum Op {
    Transfer { from: usize, to: usize, share: u8 },
    Distribute { from: usize, share: u8 },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0usize..3, 0usize..3, 0u8..=100).prop_map(|(from, to, share)| Op::Transfer {
            from,
            to,
            share
        }),
        (0usize..3, 0u8..=100).prop_map(|(from, share)| Op::Distribute { from, share }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    #[test]
    fn claimable_never_exceeds_the_unlocked_amount(
        supply in 1u128..1_000_000_000_000u128,
        steps in proptest::collection::vec((op(), 1_000u64..12_000), 1..12),
    ) {
        let mut contract = init();
        let class = stepped_class(&mut contract, 6);
        let holders: Vec<AccountId> = (1..=3).map(accounts).collect();
        mint(&mut contract, &class, &holders[0], supply, ts(1_000));
        // Block time never goes backwards on chain.
        let mut steps = steps;
        steps.sort_by_key(|(_, t)| *t);
        let mut changes = 0u128;
        for (op, t) in &steps {
            let at = ts(*t);
            match op {
                Op::Transfer { from, to, share } if from != to => {
                    let balance = contract.mt_balance_of(holders[*from].clone(), class.clone()).0;
                    let amount = balance * u128::from(*share) / 100;
                    if amount > 0 {
                        env(&holders[*from], one_yocto(), at);
                        contract.mt_transfer(holders[*to].clone(), class.clone(), U128(amount), None, None);
                        changes += 2;
                    }
                }
                Op::Distribute { from, share } => {
                    let balance = contract.mt_balance_of(holders[*from].clone(), class.clone()).0;
                    let amount = balance * u128::from(*share) / 100 / 2;
                    if amount > 0 {
                        let receivers: Vec<(AccountId, U128)> = holders
                            .iter()
                            .enumerate()
                            .filter(|(i, _)| i != from)
                            .map(|(_, h)| (h.clone(), U128(amount)))
                            .collect();
                        env(&holders[*from], one_yocto(), at);
                        contract.distribute_units(class.clone(), receivers);
                        changes += 3;
                    }
                }
                Op::Transfer { .. } => {}
            }
        }
        let f_end = stepped_schedule().fraction(12_000);
        env_at(&engine(), ts(12_000));
        let total: u128 = holders
            .iter()
            .map(|h| contract.claimable_of(&ClaimSource::Holding { account: h.clone(), class_id: class.clone() }))
            .sum();
        let balances: u128 = holders.iter().map(|h| contract.holding(&Holder::Account(h.clone()), &class).balance).sum();
        prop_assert_eq!(balances, supply);
        prop_assert_eq!(f_end, ONE);
        prop_assert!(total <= supply);
        prop_assert!(supply - total <= changes + 1);
    }
}

#[test]
fn locks_and_settlement_conserve_the_unlocked_amount() {
    // Exit round: the seller's lock accrues to the seller until ts, the buyer accrues from ts,
    // and the sum equals the whole class accrual to the base unit.
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &seller, 3_000_000, ts(1_000));
    fund(&mut contract, &seller, USDC, ts(1_000));
    fund(&mut contract, &buyer, 3 * USDC, ts(1_000));
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &seller,
        2_000_000,
        1_000_000,
        2_000_000,
        ts(3_000),
    );
    let (bid, bid_sealed) = place_bid(
        &mut contract,
        round,
        &buyer,
        2_000_000,
        1_200_000,
        1_500_000,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + 2 * NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    settle(&mut contract, round, ask, ts(8_000));
    settle(&mut contract, round, bid, ts(8_000));
    env_at(&engine(), ts(9_000));
    let seller_claimable = contract.get_claimable(seller.clone(), class.clone()).0;
    let buyer_claimable = contract.get_claimable(buyer.clone(), class.clone()).0;
    // Seller: 3M units from 0 to 0.2 (600k), 2M locked from 0.2 to 0.5 (600k), 1M free from
    // 0.2 to 0.8 (600k). Buyer: 2M from 0.5 to 0.8 (600k).
    assert_eq!(seller_claimable, 1_800_000);
    assert_eq!(buyer_claimable, 600_000);
    assert_eq!(
        seller_claimable + buyer_claimable,
        accrual(3_000_000, 0, stepped_schedule().fraction(9_000))
    );
}
