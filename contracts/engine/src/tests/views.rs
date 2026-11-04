//! View shapes: `stats`, round listing and filters, bids, portfolio, events paging, classes.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;
use serde_json::json;

use super::*;
use crate::events::EVENT_CAPACITY;
use crate::types::{Position, PositionSource, PositionState, RoundKind, RoundStatus};
use crate::views::{RoundFilter, ScheduleView};

#[test]
fn stats_have_the_exact_shape() {
    let mut contract = init();
    assert_eq!(
        serde_json::to_value(contract.stats()).unwrap(),
        json!({ "rounds_total": 0, "rounds_settled": 0, "volume_settled_usdc": "0", "classes": 0, "positions": 0 })
    );
    let class = stepped_class(&mut contract, 6);
    env_at(&engine(), ts(1_000));
    let position_id = contract.insert_position(Position {
        class_id: class.clone(),
        source: PositionSource::SolanaStream {
            metadata: "Meta111".into(),
        },
        allocation: U128(5),
        depositor: accounts(1),
        deposited_at: U64(ts(1_000)),
        state: PositionState::Held,
    });
    let round = create_exit(&mut contract, &accounts(0), &class, 1, ts(2_000), ts(6_000));
    assert_eq!(
        serde_json::to_value(contract.stats()).unwrap(),
        json!({ "rounds_total": 1, "rounds_settled": 0, "volume_settled_usdc": "0", "classes": 1, "positions": 1 })
    );
    let position = contract.get_position(U64(position_id)).unwrap();
    assert_eq!(position.position.state, PositionState::Held);
    assert_eq!(contract.get_positions(None, None).len(), 1);
    env_at(&engine(), ts(1_000));
    contract.positions.get_mut(&position_id).unwrap().state = PositionState::Releasing;
    contract.mark_position_released(position_id, &accounts(1));
    assert_eq!(
        contract
            .get_position(U64(position_id))
            .unwrap()
            .position
            .state,
        PositionState::Released
    );
    panics_with("Position is not being released", || {
        contract.mark_position_released(position_id, &accounts(1))
    });
    let json = serde_json::to_value(contract.get_position(U64(position_id)).unwrap()).unwrap();
    assert_eq!(json["position_id"], "0");
    assert_eq!(
        json["source"],
        json!({ "SolanaStream": { "metadata": "Meta111" } })
    );
    assert_eq!(
        contract.get_round(U64(round)).unwrap().kind,
        RoundKind::Exit
    );
}

#[test]
fn classes_and_schedules() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let same = stepped_class(&mut contract, 6);
    let other = stepped_class(&mut contract, 9);
    assert_eq!(class, same);
    assert_ne!(class, other);
    assert_eq!(class.len(), 64);
    let classes = contract.get_classes(None, None);
    assert_eq!(classes.len(), 2);
    assert_eq!(contract.get_classes(Some(1), Some(5)).len(), 1);
    env_at(&engine(), ts(3_000));
    let view = contract.get_class(class.clone()).unwrap();
    assert_eq!(view.fraction_now, U128(crate::math::ONE / 5));
    match view.schedule {
        ScheduleView::Stepped {
            start,
            end,
            period,
            amount_per_period,
            total,
            ..
        } => {
            assert_eq!((start, end, period), (U64(1_000), U64(11_000), U64(1_000)));
            assert_eq!((amount_per_period, total), (U128(1), U128(10)));
        }
        ScheduleView::Linear { .. } => panic!("stepped class expected"),
    }
    assert!(contract.get_class("nope".into()).is_none());
    assert_eq!(
        events("rose")
            .iter()
            .filter(|e| e["event"] == "class_created")
            .count(),
        2
    );
}

#[test]
fn rounds_can_be_listed_and_filtered() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (issuer, holder) = (accounts(0), accounts(1));
    fund(&mut contract, &issuer, 10 * USDC, ts(1_000));
    mint(&mut contract, &class, &holder, 1_000_000, ts(1_000));
    let exit = create_exit(&mut contract, &issuer, &class, 1, ts(2_000), ts(6_000));
    let tender = create_tender(
        &mut contract,
        &issuer,
        &class,
        USDC,
        1,
        ts(2_000),
        ts(6_000),
    );
    let advance = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 1_000_000,
            claim: 100,
            min_fill: 0,
            max_price: 1,
        },
        ts(2_000),
        ts(6_000),
    );
    env_at(&issuer, ts(3_000));
    contract.cancel_round(U64(tender));
    assert_eq!(cash(&contract, &issuer), 10 * USDC);
    env_at(&issuer, ts(3_000));
    let all = contract.get_rounds(None, None, None).rounds;
    assert_eq!(
        all.iter().map(|r| r.round_id.0).collect::<Vec<_>>(),
        vec![exit, tender, advance]
    );
    let tenders = contract
        .get_rounds(
            Some(RoundFilter {
                kind: Some(RoundKind::Tender),
                ..Default::default()
            }),
            None,
            None,
        )
        .rounds;
    assert_eq!(tenders.len(), 1);
    assert_eq!(tenders[0].status, RoundStatus::Cancelled);
    assert_eq!(tenders[0].budget, Some(U128(USDC)));
    assert_eq!(tenders[0].reference_price, Some(U128(1)));
    let open = contract
        .get_rounds(
            Some(RoundFilter {
                status: Some(RoundStatus::Open),
                ..Default::default()
            }),
            None,
            None,
        )
        .rounds;
    assert_eq!(open.len(), 2);
    let by_holder = contract
        .get_rounds(
            Some(RoundFilter {
                creator: Some(holder.clone()),
                ..Default::default()
            }),
            None,
            None,
        )
        .rounds;
    assert_eq!(by_holder[0].advance_claim, Some(U128(100)));
    let page = contract.get_rounds(None, Some(U64(1)), Some(1));
    assert_eq!(page.rounds.len(), 1);
    assert_eq!(page.next, Some(U64(2)));
    assert_eq!(contract.get_rounds(None, Some(U64(2)), Some(1)).next, None);
    assert_eq!(
        contract
            .get_rounds(
                Some(RoundFilter {
                    class_id: Some("x".into()),
                    ..Default::default()
                }),
                None,
                None
            )
            .rounds
            .len(),
        0
    );
    let view = contract.get_round(U64(exit)).unwrap();
    assert_eq!(
        view.app_id,
        hex::encode(rose_ibe::round_app_id(ENGINE, exit))
    );
    assert_eq!(view.remaining_lock_secs, U64(5_000));
    assert!(view.key.is_none());
    assert!(contract.get_round(U64(7)).is_none());
    assert!(contract.get_round_result(U64(exit)).is_none());
    assert!(contract.get_bids(U64(7)).is_empty());
}

#[test]
fn portfolio_and_bids() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &seller, 2_000_000, ts(1_000));
    fund(&mut contract, &seller, USDC, ts(1_000));
    fund(&mut contract, &buyer, 2_500_000, ts(1_000));
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
        1_500_000,
        1_000_000,
        1_500_000,
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
    env_at(&seller, ts(4_000));
    let portfolio = contract.get_portfolio(seller.clone());
    assert_eq!(portfolio.holdings.len(), 1);
    assert_eq!(portfolio.holdings[0].balance, U128(500_000));
    assert_eq!(portfolio.holdings[0].locked_in_rounds, U128(1_500_000));
    // 2M from 0 to 0.2 plus 500k from 0.2 to 0.3: the lock accrues at settlement.
    assert_eq!(portfolio.holdings[0].claimable, U128(400_000 + 50_000));
    assert_eq!(portfolio.bids.len(), 1);
    assert_eq!(portfolio.bids[0].status, crate::views::BidStatus::Sealed);
    assert_eq!(
        portfolio.bids[0].ciphertext_hex.as_deref(),
        Some(ask_sealed.ciphertext.as_str())
    );
    assert_eq!(portfolio.cash[0].amount, U128(0));
    let bids = contract.get_bids(U64(round));
    assert_eq!(bids.len(), 2);
    assert_eq!(bids[1].escrow, U128(1_500_000));
    assert!(bids[1].opened.is_none());

    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    settle(&mut contract, round, ask, ts(7_000));
    let bids = contract.get_bids(U64(round));
    assert_eq!(bids[0].status, crate::views::BidStatus::Settled);
    assert!(bids[0].ciphertext_hex.is_none());
    assert_eq!(bids[0].fill_quantity, U128(1_500_000));
    assert_eq!(bids[1].status, crate::views::BidStatus::Opened);
    assert_eq!(bids[1].fill_quantity, U128(1_500_000));
    assert_eq!(bids[1].opened.unwrap().price, U128(1_200_000));
    assert!(contract.get_portfolio(seller.clone()).bids.is_empty());
    assert_eq!(contract.get_portfolio(buyer.clone()).bids.len(), 1);
    assert!(contract
        .get_portfolio(account("nobody"))
        .holdings
        .is_empty());
}

#[test]
fn events_are_logged_and_paged_from_a_ring_buffer() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let page = contract.get_events(None, None);
    assert_eq!(page.total, U64(1));
    assert_eq!(
        serde_json::to_value(&page.events[0]).unwrap()["event"],
        "class_created"
    );
    assert_eq!(
        serde_json::to_value(&page.events[0]).unwrap()["data"]["class_id"],
        class
    );
    assert_eq!(
        serde_json::to_value(&page.events[0]).unwrap()["predecessor"],
        ENGINE
    );
    let logged = events("rose")[0].clone();
    assert_eq!(logged["standard"], "rose");
    assert_eq!(logged["version"], "1.0.0");
    assert_eq!(logged["event"], "class_created");
    let holder = accounts(1);
    for i in 0..u64::from(EVENT_CAPACITY) + 10 {
        mint(&mut contract, &class, &holder, 1, ts(1_000 + i));
    }
    // class_created, the holder's registration, then one mint event per unit.
    let total = u64::from(EVENT_CAPACITY) + 12;
    let page = contract.get_events(None, Some(3));
    assert_eq!(page.total, U64(total));
    assert_eq!(page.oldest, U64(12));
    assert_eq!(page.events.len(), 3);
    assert_eq!(page.events[0].seq, U64(12));
    let last = contract.get_events(Some(U64(total - 2)), Some(10));
    assert_eq!(last.events.len(), 2);
    assert_eq!(last.events[1].seq, U64(total - 1));
    assert!(contract
        .get_events(Some(U64(total)), None)
        .events
        .is_empty());
}

#[test]
fn portfolio_lists_the_accounts_own_classes_including_units_away_from_the_holding() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let others: Vec<String> = (7..10).map(|d| stepped_class(&mut contract, d)).collect();
    let (alice, bob) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000, ts(500));
    register(&mut contract, &bob, ts(500));
    env(
        &bob,
        near_sdk::NearToken::from_yoctonear(
            2 * u128::from(crate::HOLDING_ROW_BYTES)
                * near_sdk::env::storage_byte_cost().as_yoctonear(),
        ),
        ts(500),
    );
    contract.storage_deposit(None, None);
    for other in &others {
        mint(&mut contract, other, &bob, 1_000, ts(500));
    }
    fund(&mut contract, &alice, USDC, ts(500));
    let round = create_exit(&mut contract, &accounts(0), &class, USDC, ts(500), ts(900));
    place_ask(&mut contract, round, &alice, 1_000, 1, 1_000, ts(500));
    assert_eq!(
        contract
            .holding(&crate::types::Holder::Account(alice.clone()), &class)
            .balance,
        0,
        "every unit is locked in the ask: the holding row is gone"
    );
    let portfolio = contract.get_portfolio(alice.clone());
    assert_eq!(portfolio.holdings.len(), 1);
    assert_eq!(portfolio.holdings[0].class_id, class);
    assert_eq!(portfolio.holdings[0].locked_in_rounds, U128(1_000));
    let bobs: Vec<String> = contract
        .get_portfolio(bob)
        .holdings
        .into_iter()
        .map(|h| h.class_id)
        .collect();
    assert_eq!(bobs, others);
}
