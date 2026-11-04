//! Exit end to end: sealed asks against sealed bids with real locked-fraction pricing.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;

use super::*;
use crate::math::ONE;
use crate::types::{Holder, Side, VoidReason};

#[test]
fn exit_clears_at_the_midpoint_and_moves_units_with_their_accrual() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer, buyer2) = (accounts(1), accounts(2), accounts(3));
    mint(&mut contract, &class, &seller, 2_000_000, ts(1_000));
    fund(&mut contract, &seller, USDC, ts(1_000));
    fund(&mut contract, &buyer, 2_500_000, ts(1_000));
    fund(&mut contract, &buyer2, 1_500_000, ts(1_000));
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    assert_eq!(contract.get_round(U64(round)).unwrap().f_ts, U128(ONE / 2));

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
    let (bid2, bid2_sealed) = place_bid(
        &mut contract,
        round,
        &buyer2,
        1_000_000,
        800_000,
        500_000,
        ts(3_500),
    );
    assert_eq!(cash(&contract, &buyer), 0, "escrow 1.5M plus bond 1 USDC");
    assert_eq!(cash(&contract, &buyer2), 0, "escrow 0.5M plus bond 1 USDC");
    let quote = contract.quote_buy(U64(round), U128(2_000_000), U128(1_200_000));
    assert_eq!(
        (quote.charge, quote.fee, quote.escrow_required, quote.bond),
        (U128(1_200_000), U128(3_600), U128(1_203_600), U128(USDC))
    );
    let quote = contract.quote_sell(U64(round), U128(2_000_000));
    assert_eq!((quote.valuation, quote.bond), (U128(2_000_000), U128(USDC)));

    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    open(&mut contract, round, bid2, &bid2_sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);

    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.price, U128(1_100_000));
    assert_eq!(result.volume, U128(2_000_000));
    assert_eq!(result.notional, U128(1_100_000));
    assert_eq!(result.fee, U128(3_300));
    assert_eq!(result.fills[bid as usize].cash, U128(1_100_000));
    assert_eq!(result.fills[bid as usize].fee, U128(3_300));
    assert_eq!(result.fills[bid2 as usize].fill_quantity, U128(0));
    assert_eq!(result.fills[ask as usize].cash, U128(1_100_000));

    settle(&mut contract, round, ask, ts(8_000));
    settle(&mut contract, round, bid, ts(8_000));
    settle(&mut contract, round, bid2, ts(8_000));
    assert_eq!(cash(&contract, &seller), USDC + 1_100_000);
    assert_eq!(
        cash(&contract, &buyer),
        USDC + 1_500_000 - 1_100_000 - 3_300
    );
    assert_eq!(cash(&contract, &buyer2), USDC + 500_000);
    assert_eq!(cash(&contract, &treasury()), 3_300);
    let s = contract.holding(&Holder::Account(seller.clone()), &class);
    let b = contract.holding(&Holder::Account(buyer.clone()), &class);
    assert_eq!((s.balance, s.claimable), (0, 400_000 + 600_000));
    assert_eq!(
        (b.balance, b.claimable, b.checkpoint),
        (2_000_000, 400_000, 7 * ONE / 10)
    );
    assert_eq!(contract.mt_supply(class.clone()), Some(U128(2_000_000)));
    assert_eq!(contract.get_portfolio(buyer.clone()).bids.len(), 0);
    let cleared = events("rose")
        .iter()
        .find(|e| e["event"] == "round_cleared")
        .cloned()
        .unwrap();
    assert_eq!(cleared["data"]["price"], "1100000");
    assert_eq!(cleared["data"]["remaining_lock_secs"], "5000");
}

#[test]
fn void_bids_are_excluded_and_slashed() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer, cheap) = (accounts(1), accounts(2), accounts(3));
    mint(&mut contract, &class, &seller, 2_000_000, ts(1_000));
    fund(&mut contract, &seller, USDC, ts(1_000));
    fund(&mut contract, &buyer, 2_500_000, ts(1_000));
    fund(&mut contract, &cheap, 2 * USDC, ts(1_000));
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
    // 2M units at 2M per token would cost 2M + fee: escrow 1M is too small.
    let (void_bid, void_sealed) = place_bid(
        &mut contract,
        round,
        &cheap,
        2_000_000,
        2_000_000,
        USDC,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    open(&mut contract, round, void_bid, &void_sealed, received + NS);
    assert_eq!(
        contract.get_bid(U64(round), void_bid).unwrap().void,
        Some(VoidReason::EscrowTooSmall)
    );
    clear(&mut contract, round, received + REVEAL_WINDOW);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(
        result.price,
        U128(1_100_000),
        "the void bid did not move the price"
    );
    settle(&mut contract, round, void_bid, ts(8_000));
    assert_eq!(cash(&contract, &cheap), USDC, "escrow back, bond slashed");
    assert_eq!(cash(&contract, &treasury()), USDC);
}

#[test]
fn quantity_above_supply_is_void() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &seller, 2_000_000, ts(1_000));
    fund(&mut contract, &buyer, 2 * USDC, ts(1_000));
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    // A zero limit makes any quantity affordable; the supply cap keeps clearing sums bounded.
    let (bid, sealed) = place_bid(&mut contract, round, &buyer, u128::MAX, 0, USDC, ts(3_500));
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, bid, &sealed, received + NS);
    assert_eq!(
        contract.get_bid(U64(round), bid).unwrap().void,
        Some(VoidReason::QuantityAboveSupply)
    );
    clear(&mut contract, round, received + REVEAL_WINDOW);
    assert_eq!(
        contract.round(round).cancel_reason,
        Some(crate::types::CancelReason::NoCrossing)
    );
}

#[test]
fn one_sealed_order_per_account_and_side() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &seller, 2_000_000, ts(1_000));
    fund(&mut contract, &seller, 3 * USDC, ts(1_000));
    fund(&mut contract, &buyer, 5 * USDC, ts(1_000));
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    place_bid(&mut contract, round, &buyer, 1, 1, USDC, ts(3_500));
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_500));
    panics_with("One sealed order per account and side per round", || {
        contract.place_bid(
            U64(round),
            seal(round, &buyer, Side::Buy, 2, 2).ciphertext,
            U128(USDC),
        );
    });
    place_ask(&mut contract, round, &seller, 1, 1, 1_000_000, ts(3_500));
    env(&seller, BID_STORAGE_DEPOSIT, ts(3_500));
    panics_with("One sealed order per account and side per round", || {
        contract.place_ask(
            U64(round),
            seal(round, &seller, Side::Sell, 2, 2).ciphertext,
            U128(1),
        );
    });
    // The same account may be on both sides.
    place_bid(&mut contract, round, &seller, 1, 1, USDC, ts(3_500));
    assert_eq!(
        contract.get_order_id(U64(round), seller.clone(), Side::Buy),
        Some(2)
    );
    assert_eq!(
        contract.get_order_id(U64(round), seller.clone(), Side::Sell),
        Some(1)
    );
    assert_eq!(contract.get_round(U64(round)).unwrap().bid_count, 3);
}

#[test]
fn a_round_holds_at_most_64_sealed_orders_and_clears_them_in_one_call() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let seller = accounts(1);
    mint(&mut contract, &class, &seller, 64_000_000, ts(1_000));
    fund(&mut contract, &seller, USDC, ts(1_000));
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
        63_000_000,
        1_000_000,
        63_000_000,
        ts(3_000),
    );
    let mut bids = Vec::new();
    for i in 0..63u64 {
        let buyer = account(&format!("buyer{i}"));
        fund(&mut contract, &buyer, 3 * USDC, ts(1_000));
        bids.push((
            buyer.clone(),
            place_bid(
                &mut contract,
                round,
                &buyer,
                1_000_000,
                1_000_000 + u128::from(i),
                2 * USDC,
                ts(3_500),
            ),
        ));
    }
    assert_eq!(contract.get_round(U64(round)).unwrap().bid_count, 64);
    let late = account("late");
    fund(&mut contract, &late, 3 * USDC, ts(1_000));
    env(&late, BID_STORAGE_DEPOSIT, ts(3_500));
    panics_with("Round is full (64 sealed orders)", || {
        contract.place_bid(
            U64(round),
            seal(round, &late, Side::Buy, 1, 1).ciphertext,
            U128(USDC),
        );
    });
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    for (_, (bid, sealed)) in &bids {
        open(&mut contract, round, *bid, sealed, received + NS);
    }
    clear(&mut contract, round, received + REVEAL_WINDOW);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.volume, U128(63_000_000));
    assert_eq!(result.price, U128(1_000_000));
    assert_eq!(result.fills.len(), 64);
    assert!(result.fills[1..]
        .iter()
        .all(|f| f.fill_quantity == U128(1_000_000)));
    for (_, (bid, _)) in &bids {
        settle(&mut contract, round, *bid, ts(7_000));
    }
    settle(&mut contract, round, ask, ts(7_000));
    assert_eq!(cash(&contract, &seller), USDC + 63 * 500_000);
    assert_eq!(contract.get_round(U64(round)).unwrap().settled_count, 64);
}
