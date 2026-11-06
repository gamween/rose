//! Tender end to end: the spec example (asks 100 @ 9 and 10 @ 10, budget 950), fee escrow and
//! refund, retired units.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;

use super::*;
use crate::math::ONE;
use crate::types::{ClaimSource, Holder, Phase, RoundStatus, Side, VoidReason};
use crate::views::BidStatus;

/// Class with 0 decimals, round closing before the schedule starts: prices are plain `qty * P`.
fn setup() -> (Contract, String, AccountId, AccountId, AccountId) {
    let mut contract = init();
    let class = stepped_class(&mut contract, 0);
    let (issuer, a, b) = (accounts(0), accounts(1), accounts(2));
    mint(&mut contract, &class, &a, 100, ts(500));
    mint(&mut contract, &class, &b, 10, ts(500));
    fund(&mut contract, &issuer, 953, ts(500));
    fund(&mut contract, &a, USDC, ts(500));
    fund(&mut contract, &b, USDC, ts(500));
    (contract, class, issuer, a, b)
}

#[test]
fn spec_example_clears_at_nine_and_refunds_the_unused_budget_and_fee() {
    let (mut contract, class, issuer, a, b) = setup();
    let round = create_tender(&mut contract, &issuer, &class, 950, 10, ts(500), ts(900));
    assert_eq!(
        cash(&contract, &issuer),
        0,
        "escrow = budget + fee(budget) = 950 + 3"
    );
    let view = contract.get_round(U64(round)).unwrap();
    assert_eq!(view.issuer_escrow, Some(U128(953)));
    assert_eq!(view.f_ts, U128(0));
    assert_eq!(view.status, RoundStatus::Open);

    let (ask_a, sealed_a) = place_ask(&mut contract, round, &a, 100, 9, 100, ts(600));
    let (ask_b, sealed_b) = place_ask(&mut contract, round, &b, 10, 10, 10, ts(600));
    assert_eq!(cash(&contract, &a), 0, "bond floor of 1 USDC");
    assert_eq!(contract.mt_balance_of(a.clone(), class.clone()).0, 0);
    assert_eq!(
        contract
            .get_holding(a.clone(), class.clone())
            .locked_in_rounds,
        U128(100)
    );

    let received = close_and_release(&mut contract, round, ts(900));
    assert_eq!(
        contract.get_round(U64(round)).unwrap().status,
        RoundStatus::Revealing
    );
    open(&mut contract, round, ask_a, &sealed_a, received + NS);
    open(&mut contract, round, ask_b, &sealed_b, received + 2 * NS);
    assert_eq!(
        contract.get_bid(U64(round), ask_a).unwrap().status,
        BidStatus::Opened
    );

    clear(&mut contract, round, received + REVEAL_WINDOW);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.price, U128(9));
    assert_eq!(result.volume, U128(100));
    assert_eq!(result.notional, U128(900));
    assert_eq!(result.fee, U128(3));
    assert_eq!(result.issuer_charged, U128(900));
    assert_eq!(result.issuer_refund, U128(50), "953 - 900 - fee(900) = 50");
    assert_eq!(cash(&contract, &issuer), 50);
    assert_eq!(cash(&contract, &treasury()), 3);
    assert_eq!(result.fills[0].fill_quantity, U128(100));
    assert_eq!(result.fills[0].cash, U128(900));
    assert_eq!(result.fills[1].fill_quantity, U128(0));
    assert_eq!(contract.stats().volume_settled_usdc, U128(900));
    assert_eq!(contract.stats().rounds_settled, 1);
    let history = contract.get_price_history(class.clone(), None, None);
    assert_eq!(history.total, 1);
    let history = history.points;
    assert_eq!(history[0].price, U128(9));
    assert_eq!(history[0].remaining_lock_secs, U64(11_000 - 900));

    // Settlement at f = 0.2: sold units sit in the retired lot and accrue from ts (f = 0).
    settle(&mut contract, round, ask_a, ts(3_000));
    settle(&mut contract, round, ask_b, ts(3_000));
    assert_eq!(cash(&contract, &a), USDC + 900, "bond back plus proceeds");
    assert_eq!(cash(&contract, &b), USDC, "bond back, nothing sold");
    assert_eq!(contract.mt_balance_of(a.clone(), class.clone()).0, 0);
    assert_eq!(contract.mt_balance_of(b.clone(), class.clone()).0, 10);
    assert_eq!(contract.get_claimable(b.clone(), class.clone()).0, 2);
    let retired = contract.get_retired_lot(U64(round)).unwrap();
    assert_eq!(retired.units, U128(100));
    assert_eq!(retired.claimable, U128(20));
    assert_eq!(retired.retire_to, RETIRE_TO);
    assert_eq!(contract.mt_supply(class.clone()), Some(U128(110)));
    assert_eq!(contract.get_round(U64(round)).unwrap().settled_count, 2);
    assert_eq!(
        contract.get_bid(U64(round), ask_a).unwrap().status,
        BidStatus::Settled
    );
    assert_eq!(contract.get_bids(U64(round)).len(), 2);

    // Storage deposits: both bidders got theirs back, the issuer's stays with the settled round.
    assert_eq!(transferred_to(&a), bid_refund(&contract, round, ask_a));
    assert_eq!(transferred_to(&b), bid_refund(&contract, round, ask_b));
    assert!(bid_refund(&contract, round, ask_a) < BID_STORAGE_DEPOSIT.as_yoctonear());
    assert_eq!(transferred_to(&issuer), 0);
    assert_eq!(
        contract.round(round).storage_deposit,
        ROUND_STORAGE_DEPOSIT.as_yoctonear()
    );

    env_at(&accounts(5), ts(3_000));
    panics_with("Bid already settled or unknown", || {
        contract.settle_bid(U64(round), ask_a)
    });
}

#[test]
fn retired_units_are_claimable_only_toward_retire_to() {
    let (mut contract, class, issuer, a, b) = setup();
    let round = create_tender(&mut contract, &issuer, &class, 950, 10, ts(500), ts(900));
    let (ask_a, sealed_a) = place_ask(&mut contract, round, &a, 100, 9, 100, ts(600));
    let (ask_b, sealed_b) = place_ask(&mut contract, round, &b, 10, 10, 10, ts(600));
    let received = close_and_release(&mut contract, round, ts(900));
    open(&mut contract, round, ask_a, &sealed_a, received + NS);
    open(&mut contract, round, ask_b, &sealed_b, received + 2 * NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    settle(&mut contract, round, ask_a, ts(3_000));
    settle(&mut contract, round, ask_b, ts(3_000));

    // Nobody holds the retired units as an account: they cannot be transferred.
    assert_eq!(contract.mt_balance_of(issuer.clone(), class.clone()).0, 0);
    assert_eq!(contract.mt_balance_of(a.clone(), class.clone()).0, 0);
    assert_eq!(
        contract.holding(&Holder::Retired(round), &class).balance,
        100
    );

    env_at(&engine(), ts(6_000));
    let source = ClaimSource::Retired { round_id: round };
    assert_eq!(contract.claimable_of(&source), 50);
    let receipt = contract.take_claimable(&source, 30);
    assert_eq!(receipt.restricted_to.as_deref(), Some(RETIRE_TO));
    assert_eq!(receipt.class_id, class);
    assert_eq!(contract.claimable_of(&source), 20);
    contract.refund_claimable(&source, 30);
    assert_eq!(contract.claimable_of(&source), 50);
    panics_with("not enough claimable tokens", || {
        contract.take_claimable(&source, 51);
    });
    let event = events("rose").last().unwrap().clone();
    assert_eq!(event["event"], "claimable_taken");
    assert_eq!(event["data"]["source"], format!("retired:{round}"));
}

#[test]
fn asks_above_max_price_and_the_issuer_are_refused_or_unfilled() {
    let (mut contract, class, issuer, a, b) = setup();
    let round = create_tender(&mut contract, &issuer, &class, 950, 10, ts(500), ts(900));
    env(&issuer, BID_STORAGE_DEPOSIT, ts(600));
    panics_with("The issuer cannot ask in its own Tender", || {
        contract.place_ask(
            U64(round),
            seal(round, &issuer, Side::Sell, 1, 1).ciphertext,
            U128(1),
        );
    });
    env(&issuer, BID_STORAGE_DEPOSIT, ts(600));
    panics_with("A Tender has one buyer", || {
        contract.place_bid(
            U64(round),
            seal(round, &issuer, Side::Buy, 1, 1).ciphertext,
            U128(1),
        );
    });
    let (ask_a, sealed_a) = place_ask(&mut contract, round, &a, 100, 11, 100, ts(600));
    let (ask_b, sealed_b) = place_ask(&mut contract, round, &b, 10, 10, 10, ts(600));
    let received = close_and_release(&mut contract, round, ts(900));
    open(&mut contract, round, ask_a, &sealed_a, received + NS);
    open(&mut contract, round, ask_b, &sealed_b, received + 2 * NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.price, U128(10));
    assert_eq!(result.volume, U128(10));
    assert_eq!(result.fills[0].fill_quantity, U128(0));
    assert!(
        result.fills[0].void.is_none(),
        "above max_price is unfilled, not void"
    );
    assert_eq!(result.issuer_refund, U128(953 - 100 - 1));
    settle(&mut contract, round, ask_a, ts(900));
    assert_eq!(cash(&contract, &a), USDC);
    assert_eq!(contract.mt_balance_of(a.clone(), class.clone()).0, 100);
}

#[test]
fn tender_with_no_crossing_is_cancelled_and_refunds_everything() {
    let (mut contract, class, issuer, a, _) = setup();
    let round = create_tender(&mut contract, &issuer, &class, 950, 10, ts(500), ts(900));
    // Seller asks 100 @ 9 but has only 100 locked: sealed quantity 101 is void.
    let (ask_a, sealed_a) = place_ask(&mut contract, round, &a, 101, 9, 100, ts(600));
    let received = close_and_release(&mut contract, round, ts(900));
    open(&mut contract, round, ask_a, &sealed_a, received + NS);
    assert_eq!(
        contract.get_bid(U64(round), ask_a).unwrap().void,
        Some(VoidReason::QuantityAboveLocked)
    );
    clear(&mut contract, round, received + REVEAL_WINDOW);
    let round_view = contract.get_round(U64(round)).unwrap();
    assert_eq!(round_view.status, RoundStatus::Cancelled);
    assert_eq!(contract.round(round).phase, Phase::Cancelled);
    assert_eq!(cash(&contract, &issuer), 953);
    assert_eq!(
        transferred_to(&issuer),
        0,
        "the round deposit stays with the record"
    );
    settle(&mut contract, round, ask_a, ts(3_000));
    assert_eq!(cash(&contract, &a), 0, "void bid: bond slashed");
    assert_eq!(cash(&contract, &treasury()), USDC);
    assert_eq!(contract.mt_balance_of(a.clone(), class.clone()).0, 100);
    assert_eq!(
        contract.get_claimable(a.clone(), class.clone()).0,
        20,
        "units return with their accrual"
    );
    assert_eq!(contract.stats().rounds_settled, 0);
    assert_eq!(
        contract.holding(&Holder::Account(a), &class).checkpoint,
        ONE / 5
    );
}

#[test]
fn a_tender_escrows_the_canonical_venue_whatever_its_spelling() {
    let (mut contract, class, issuer, _, _) = setup();
    let canonical = Venue::Base {
        token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e".into(),
    };
    env_at(&engine(), ts(500));
    contract.credit_cash(&issuer, &canonical, 953);
    with_derived_addresses(&mut contract);
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(500));
    // The address as Basescan prints it (EIP-55 checksum): cash rows are keyed lowercase.
    let round = contract.create_tender(TenderParams {
        class_id: class.clone(),
        venue: Venue::Base {
            token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e".into(),
        },
        budget: U128(950),
        max_price: U128(10),
        reference_price: None,
        retire_to: RETIRE_TO.to_string(),
        window: window(ts(900)),
    });
    assert_eq!(contract.get_round(round).unwrap().venue, canonical);
    assert_eq!(contract.cash_of(&issuer, &canonical), 0);
    assert_eq!(cash(&contract, &issuer), 953, "the NEAR venue is untouched");
}
