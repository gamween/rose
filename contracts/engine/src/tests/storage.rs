//! NEP-145 storage management: registration, deposits, withdrawals, unregistration, and the
//! storage checks on every path that creates a holding row.

use near_sdk::json_types::U128;
use near_sdk::test_utils::accounts;
use near_sdk::NearToken;

use super::*;
use crate::types::Holder;
use crate::{HOLDING_ROW_BYTES, STORAGE_ACCOUNT_BYTES};

fn byte_cost() -> u128 {
    near_sdk::env::storage_byte_cost().as_yoctonear()
}

#[test]
fn registration_covers_the_record_and_one_holding_row() {
    let mut contract = init();
    let bounds = contract.storage_balance_bounds();
    let min = u128::from(STORAGE_ACCOUNT_BYTES + HOLDING_ROW_BYTES) * byte_cost();
    assert_eq!(bounds.min, U128(min));
    assert_eq!(bounds.max, None);
    let alice = accounts(1);
    assert!(contract.storage_balance_of(alice.clone()).is_none());
    env(&alice, NearToken::from_yoctonear(min - 1), ts(1_000));
    panics_with("Attach at least the minimum storage deposit", || {
        contract.storage_deposit(None, None)
    });
    // Registration only: the excess comes back.
    env(&alice, NearToken::from_yoctonear(min + 5), ts(1_000));
    let balance = contract.storage_deposit(None, Some(true));
    assert_eq!(balance.total, U128(min));
    assert_eq!(
        balance.available,
        U128(u128::from(HOLDING_ROW_BYTES) * byte_cost())
    );
    assert_eq!(transferred_to(&alice), 5);
    // A registered account with registration_only gets everything back.
    env(&alice, NearToken::from_yoctonear(9), ts(1_000));
    contract.storage_deposit(None, Some(true));
    assert_eq!(transferred_to(&alice), 14);
    // A top-up for someone else.
    env(&accounts(2), NearToken::from_yoctonear(1_000), ts(1_000));
    let balance = contract.storage_deposit(Some(alice.clone()), None);
    assert_eq!(balance.total, U128(min + 1_000));
    assert_eq!(events("rose").last().unwrap()["event"], "storage_deposited");
}

#[test]
fn holding_rows_consume_the_deposit_and_free_it_when_emptied() {
    let mut contract = init();
    let class_a = stepped_class(&mut contract, 6);
    let class_b = stepped_class(&mut contract, 9);
    let alice = accounts(1);
    mint(&mut contract, &class_a, &alice, 1_000, ts(1_000));
    let balance = contract.storage_balance_of(alice.clone()).unwrap();
    assert_eq!(
        balance.available,
        U128(0),
        "one row: the registration is fully used"
    );
    env_at(&engine(), ts(1_000));
    panics_with(
        "Insufficient storage deposit for bob: top up with storage_deposit",
        || {
            contract.mint_units(&class_b, &alice, 1, 0);
        },
    );
    // The failed mint must not have left a row behind.
    assert_eq!(
        contract
            .holding(&Holder::Account(alice.clone()), &class_b)
            .balance,
        0
    );
    env(
        &alice,
        NearToken::from_yoctonear(u128::from(HOLDING_ROW_BYTES) * byte_cost()),
        ts(1_000),
    );
    contract.storage_deposit(None, None);
    mint(&mut contract, &class_b, &alice, 1, ts(1_000));
    assert_eq!(
        contract
            .storage_balance_of(alice.clone())
            .unwrap()
            .available,
        U128(0)
    );
    // Burning everything of class B releases its row.
    env_at(&engine(), ts(1_000));
    contract.burn_units(&class_b, &alice, 1);
    let available = contract
        .storage_balance_of(alice.clone())
        .unwrap()
        .available;
    assert_eq!(available, U128(u128::from(HOLDING_ROW_BYTES) * byte_cost()));
    // Withdraw what is free, not more.
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Amount exceeds the available storage balance", || {
        contract.storage_withdraw(Some(U128(available.0 + 1)))
    });
    env(&alice, one_yocto(), ts(1_000));
    let balance = contract.storage_withdraw(None);
    assert_eq!(balance.available, U128(0));
    assert_eq!(transferred_to(&alice), available.0);
    assert_eq!(events("rose").last().unwrap()["event"], "storage_withdrawn");
    env_at(&alice, ts(1_000));
    panics_with("exactly 1 yoctoNEAR", || contract.storage_withdraw(None));
}

#[test]
fn unregister_requires_an_empty_account() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (alice, nobody) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &alice, 1_000, ts(1_000));
    env(&nobody, one_yocto(), ts(1_000));
    assert!(!contract.storage_unregister(None));
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Account still holds units or claimable tokens", || {
        contract.storage_unregister(None)
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Cannot force-unregister an account holding units", || {
        contract.storage_unregister(Some(true))
    });
    env_at(&engine(), ts(1_000));
    contract.burn_units(&class, &alice, 1_000);
    let total = contract.storage_balance_of(alice.clone()).unwrap().total.0;
    env(&alice, one_yocto(), ts(1_000));
    assert!(contract.storage_unregister(None));
    assert_eq!(transferred_to(&alice), total);
    assert!(contract.storage_balance_of(alice.clone()).is_none());
    assert_eq!(
        events("rose").last().unwrap()["event"],
        "storage_unregistered"
    );
    env_at(&engine(), ts(1_000));
    panics_with(
        "Account bob is not registered: call storage_deposit first",
        || {
            contract.mint_units(&class, &alice, 1, 0);
        },
    );
}

#[test]
fn ensure_registered_takes_the_minimum_from_an_attached_budget() {
    let mut contract = init();
    let alice = accounts(1);
    let min = contract.storage_balance_bounds().min.0;
    env_at(&engine(), ts(1_000));
    panics_with("Attach the storage deposit for bob", || {
        contract.ensure_registered(&alice, min - 1);
    });
    assert_eq!(contract.ensure_registered(&alice, min + 3), 3);
    assert!(contract.is_registered(&alice));
    assert_eq!(
        contract.ensure_registered(&alice, 2),
        2,
        "already registered: nothing taken"
    );
}

#[test]
fn settlement_creates_rows_only_for_registered_buyers_and_refunds_net_of_kept_bytes() {
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
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    // The buyer withdrew its storage deposit before settlement: its units cannot land yet.
    env(&buyer, one_yocto(), ts(7_000));
    contract.storage_unregister(None);
    env_at(&accounts(5), ts(7_000));
    panics_with(
        "Account charlie is not registered: call storage_deposit first",
        || contract.settle_bid(U64(round), bid),
    );
    register(&mut contract, &buyer, ts(7_000));
    settle(&mut contract, round, bid, ts(7_000));
    assert_eq!(
        contract.mt_balance_of(buyer.clone(), class.clone()).0,
        2_000_000
    );
    let refund = bid_refund(&contract, round, bid);
    assert!(refund < BID_STORAGE_DEPOSIT.as_yoctonear());
    assert!(refund > BID_STORAGE_DEPOSIT.as_yoctonear() * 9 / 10);
    let min = contract.storage_balance_bounds().min.0;
    assert_eq!(
        transferred_to(&buyer),
        refund + min,
        "plus the unregister refund"
    );
}
