//! Advance end to end: the holder's sealed reserve, funders' bids, the lien delivering `K`
//! tokens then releasing the units.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;

use super::*;
use crate::math::ONE;
use crate::types::{ClaimSource, Holder, VoidReason};

fn setup() -> (Contract, String, AccountId, AccountId, AccountId, u64) {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, f1, f2) = (accounts(1), accounts(2), accounts(3));
    mint(&mut contract, &class, &holder, 10_000_000, ts(1_000));
    fund(&mut contract, &holder, USDC, ts(1_000));
    fund(&mut contract, &f1, 3_000_000, ts(1_000));
    fund(&mut contract, &f2, 2_100_000, ts(1_000));
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 4_000_000,
            claim: 1_500_000,
            min_fill: 500_000,
            max_price: 2_000_000,
        },
        ts(2_500),
        ts(6_000),
    );
    (contract, class, holder, f1, f2, round)
}

#[test]
fn advance_funds_a_claim_and_the_lien_delivers_it_then_releases() {
    let (mut contract, class, holder, f1, f2, round) = setup();
    assert_eq!(
        contract.mt_balance_of(holder.clone(), class.clone()).0,
        6_000_000
    );
    let holding = contract.get_holding(holder.clone(), class.clone());
    assert_eq!(holding.locked_in_rounds, U128(4_000_000));

    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &holder,
        1_500_000,
        900_000,
        1_500_000,
        ts(3_000),
    );
    assert_eq!(
        cash(&contract, &holder),
        0,
        "bond max(1 USDC, 1% of 3 USDC)"
    );
    let (bid1, sealed1) = place_bid(
        &mut contract,
        round,
        &f1,
        1_000_000,
        1_500_000,
        2_000_000,
        ts(3_500),
    );
    let (bid2, sealed2) = place_bid(
        &mut contract,
        round,
        &f2,
        1_000_000,
        1_000_000,
        1_100_000,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid1, &sealed1, received + NS);
    open(&mut contract, round, bid2, &sealed2, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);

    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.price, U128(950_000));
    assert_eq!(result.volume, U128(1_500_000));
    assert_eq!(result.notional, U128(1_425_000));
    assert_eq!(result.fee, U128(2_850 + 1_425));
    assert_eq!(result.fills[bid1 as usize].fill_quantity, U128(1_000_000));
    assert_eq!(result.fills[bid2 as usize].fill_quantity, U128(500_000));
    assert_eq!(result.fills[ask as usize].cash, U128(1_425_000));
    let view = contract.get_round(U64(round)).unwrap();
    assert_eq!(view.lien_id, Some(U64(0)));
    let lien = contract.get_lien(U64(0)).unwrap();
    assert_eq!(
        (lien.units, lien.claim_total, lien.holder.clone()),
        (U128(4_000_000), U128(1_500_000), holder.clone())
    );
    // 10M units from 0 to 0.1 at creation, then the lock from 0.1 to 0.5 before becoming a lien.
    assert_eq!(
        contract
            .holding(&Holder::Account(holder.clone()), &class)
            .claimable,
        1_000_000 + 1_600_000
    );
    assert_eq!(
        contract
            .get_holding(holder.clone(), class.clone())
            .encumbered,
        U128(4_000_000)
    );
    assert_eq!(
        contract
            .get_holding(holder.clone(), class.clone())
            .locked_in_rounds,
        U128(0)
    );

    settle(&mut contract, round, ask, ts(7_000));
    settle(&mut contract, round, bid1, ts(7_000));
    settle(&mut contract, round, bid2, ts(7_000));
    assert_eq!(cash(&contract, &holder), USDC + 1_425_000);
    assert_eq!(cash(&contract, &f1), USDC + 2_000_000 - 950_000 - 2_850);
    assert_eq!(cash(&contract, &f2), USDC + 1_100_000 - 475_000 - 1_425);
    assert_eq!(cash(&contract, &treasury()), 4_275);
    assert_eq!(
        contract.mt_balance_of(f1.clone(), class.clone()).0,
        0,
        "funders hold lien shares, not units"
    );

    // f = 0.7: 800k delivered, shares pro rata and rounded down.
    env_at(&engine(), ts(8_000));
    let (held, shares) = contract.get_liens(f1.clone());
    assert!(held.is_empty());
    assert_eq!(shares[0].claim, U128(1_000_000));
    assert_eq!(shares[0].claimable, U128(533_333));
    assert_eq!(contract.get_liens(f2.clone()).1[0].claimable, U128(266_666));
    assert_eq!(contract.get_lien(U64(0)).unwrap().delivered, U128(800_000));
    let f1_source = ClaimSource::LienShare {
        lien_id: 0,
        funder: f1.clone(),
    };
    let receipt = contract.take_claimable(&f1_source, 500_000);
    assert_eq!(receipt.restricted_to, None);
    assert_eq!(contract.claimable_of(&f1_source), 33_333);
    panics_with("Not enough claimable tokens", || {
        contract.take_claimable(&f1_source, 33_334);
    });
    env_at(&engine(), ts(8_000));
    panics_with("Lien claim is not fully delivered yet", || {
        contract.release_lien(U64(0))
    });

    // f = 0.9: the claim is complete, the excess goes to the holder, the units come back.
    env_at(&holder, ts(10_000));
    let lien = contract.get_lien(U64(0)).unwrap();
    assert_eq!(
        (lien.delivered, lien.pending_excess),
        (U128(1_500_000), U128(100_000))
    );
    contract.release_lien(U64(0));
    let h = contract.holding(&Holder::Account(holder.clone()), &class);
    assert_eq!(h.balance, 10_000_000);
    // 1M (10M to 0.1) + 1.6M (lock to 0.5) + 6M free from 0.1 to 0.9 (4.8M) + 100k excess.
    assert_eq!(h.claimable, 1_000_000 + 1_600_000 + 4_800_000 + 100_000);
    assert_eq!(h.checkpoint, 9 * ONE / 10);
    assert!(contract.get_lien(U64(0)).unwrap().released);
    assert_eq!(
        contract
            .get_holding(holder.clone(), class.clone())
            .encumbered,
        U128(0)
    );
    assert_eq!(contract.claimable_of(&f1_source), 500_000);
    assert_eq!(
        contract.claimable_of(&ClaimSource::LienShare {
            lien_id: 0,
            funder: f2.clone()
        }),
        500_000
    );
    env_at(&holder, ts(10_000));
    panics_with("Lien already released", || contract.release_lien(U64(0)));
    let released = events("rose").last().unwrap().clone();
    assert_eq!(released["event"], "lien_released");
    assert_eq!(released["data"]["units"], "4000000");
}

#[test]
fn advance_claim_mismatch_voids_the_reserve_and_cancels() {
    let (mut contract, class, holder, f1, _, round) = setup();
    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &holder,
        1_400_000,
        900_000,
        1_500_000,
        ts(3_000),
    );
    let (bid1, sealed1) = place_bid(
        &mut contract,
        round,
        &f1,
        1_000_000,
        1_500_000,
        2_000_000,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid1, &sealed1, received + NS);
    assert_eq!(
        contract.get_bid(U64(round), ask).unwrap().void,
        Some(VoidReason::ClaimMismatch)
    );
    clear(&mut contract, round, received + REVEAL_WINDOW);
    assert_eq!(
        contract.round(round).cancel_reason,
        Some(crate::types::CancelReason::NoCrossing)
    );
    // Units came back to the holder with their accrual: everything accrued to 0.5 (clear time).
    let h = contract.holding(&Holder::Account(holder.clone()), &class);
    assert_eq!((h.balance, h.claimable), (10_000_000, 10_000_000 * 5 / 10));
    settle(&mut contract, round, ask, ts(7_000));
    settle(&mut contract, round, bid1, ts(7_000));
    assert_eq!(cash(&contract, &holder), 0, "void reserve: bond slashed");
    assert_eq!(cash(&contract, &f1), 3_000_000, "full refund");
    assert_eq!(contract.get_round(U64(round)).unwrap().lien_id, None);
}

#[test]
fn advance_guards() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, other) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &holder, 10_000_000, ts(1_000));
    fund(&mut contract, &holder, 3 * USDC, ts(1_000));
    fund(&mut contract, &other, 3 * USDC, ts(1_000));
    env(&holder, ROUND_STORAGE_DEPOSIT, ts(2_500));
    panics_with(
        "Claim exceeds the tokens still locked at the close time",
        || {
            create_advance(
                &mut contract,
                &holder,
                &class,
                AdvanceSpec {
                    units: 4_000_000,
                    claim: 2_000_001,
                    min_fill: 0,
                    max_price: 2_000_000,
                },
                ts(2_500),
                ts(6_000),
            );
        },
    );
    panics_with("min_fill exceeds the claim", || {
        create_advance(
            &mut contract,
            &holder,
            &class,
            AdvanceSpec {
                units: 4_000_000,
                claim: 1_000_000,
                min_fill: 1_000_001,
                max_price: 2_000_000,
            },
            ts(2_500),
            ts(6_000),
        );
    });
    panics_with("not enough units", || {
        create_advance(
            &mut contract,
            &holder,
            &class,
            AdvanceSpec {
                units: 10_000_001,
                claim: 1,
                min_fill: 0,
                max_price: 2_000_000,
            },
            ts(2_500),
            ts(6_000),
        );
    });
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 4_000_000,
            claim: 1_500_000,
            min_fill: 0,
            max_price: 2_000_000,
        },
        ts(2_500),
        ts(6_000),
    );
    env(&other, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Only the Advance holder can place its reserve", || {
        contract.place_ask(
            U64(round),
            seal(round, &other, crate::types::Side::Sell, 1, 1).ciphertext,
            U128(1_500_000),
        );
    });
    env(&holder, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("An Advance ask covers exactly the claim", || {
        contract.place_ask(
            U64(round),
            seal(round, &holder, crate::types::Side::Sell, 1, 1).ciphertext,
            U128(1_400_000),
        );
    });
    // Cancelling before any bid returns the units with their accrual.
    env_at(&holder, ts(4_000));
    contract.cancel_round(U64(round));
    let h = contract.holding(&Holder::Account(holder.clone()), &class);
    assert_eq!((h.balance, h.claimable), (10_000_000, 3_000_000));
    assert_eq!(
        transferred_to(&holder),
        0,
        "the round deposit stays with the record"
    );
    assert!(contract.get_portfolio(holder.clone()).holdings[0].locked_in_rounds == U128(0));
}

#[test]
fn lien_at_the_maximum_claim_is_satisfied_on_chain_after_many_touches() {
    // Units 3,333,333 encumbered from f(ts) = 0.5: the largest claim is 1,666,666.
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, funder) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &holder, 3_333_333, ts(1_000));
    fund(&mut contract, &holder, USDC, ts(1_000));
    fund(&mut contract, &funder, 3_000_000, ts(1_000));
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 3_333_333,
            claim: 1_666_666,
            min_fill: 0,
            max_price: 2_000_000,
        },
        ts(2_500),
        ts(6_000),
    );
    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &holder,
        1_666_666,
        1_000_000,
        1_666_666,
        ts(3_000),
    );
    let (bid, bid_sealed) = place_bid(
        &mut contract,
        round,
        &funder,
        1_666_666,
        1_000_000,
        2_000_000,
        ts(3_500),
    );
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &bid_sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    settle(&mut contract, round, ask, ts(7_000));
    settle(&mut contract, round, bid, ts(7_000));
    let lien_id = contract.get_round(U64(round)).unwrap().lien_id.unwrap();
    assert_eq!(
        contract.get_lien(lien_id).unwrap().claim_total,
        U128(1_666_666)
    );
    for step in 1..=6u64 {
        env_at(&accounts(5), ts(6_000 + step * 1_000) - 1);
        contract.touch_lien(lien_id.0);
        env_at(&accounts(5), ts(6_000 + step * 1_000));
        contract.touch_lien(lien_id.0);
    }
    env_at(&accounts(5), ts(12_000));
    let lien = contract.get_lien(lien_id).unwrap();
    assert_eq!(lien.delivered, U128(1_666_666));
    assert_eq!(lien.pending_excess, U128(0));
    contract.release_lien(lien_id);
    assert!(contract.get_lien(lien_id).unwrap().released);
    assert_eq!(
        contract.mt_balance_of(holder.clone(), class.clone()).0,
        3_333_333
    );
    // Whole class: 3,333,333 units from 0 to 1 = 3,333,333 tokens, split between the funder's
    // claim and the holder (accrual to 0.1, lock to 0.5, excess beyond the claim).
    let share = crate::types::ClaimSource::LienShare {
        lien_id: lien_id.0,
        funder: funder.clone(),
    };
    let holder_claimable = contract.get_claimable(holder.clone(), class.clone()).0;
    assert_eq!(contract.claimable_of(&share), 1_666_666);
    let total = holder_claimable + 1_666_666;
    assert!(
        total <= 3_333_333 && 3_333_333 - total <= 2,
        "at most one unit of dust per cut"
    );
}

/// The reviewer's scenario: a holder encumbers every unit (its holding row disappears), then
/// tries to take its storage deposit away before the round settles.
fn all_units_advance() -> (Contract, String, AccountId, AccountId, u64) {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, funder) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &holder, 10_000_000, ts(1_000));
    fund(&mut contract, &holder, USDC, ts(1_000));
    fund(&mut contract, &funder, 3_000_000, ts(1_000));
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 10_000_000,
            claim: 1_500_000,
            min_fill: 500_000,
            max_price: 2_000_000,
        },
        ts(1_500),
        ts(6_000),
    );
    assert_eq!(contract.mt_balance_of(holder.clone(), class.clone()).0, 0);
    assert_eq!(
        contract
            .storage_balance_of(holder.clone())
            .unwrap()
            .available,
        U128(0),
        "the empty row is gone but the registration minimum stays"
    );
    env(&holder, one_yocto(), ts(2_600));
    panics_with("locked units", || contract.storage_unregister(None));
    env(&holder, one_yocto(), ts(2_600));
    panics_with("locked units", || contract.storage_withdraw(None));
    (contract, class, holder, funder, round)
}

#[test]
fn advance_holder_cannot_strand_the_funders_by_withdrawing_its_storage_before_clearing() {
    let (mut contract, class, holder, funder, round) = all_units_advance();
    let (ask, ask_sealed) = place_ask(
        &mut contract,
        round,
        &holder,
        1_500_000,
        900_000,
        1_500_000,
        ts(3_000),
    );
    let (bid, sealed) = place_bid(
        &mut contract,
        round,
        &funder,
        1_500_000,
        1_000_000,
        2_000_000,
        ts(3_500),
    );
    env(&holder, one_yocto(), ts(3_600));
    panics_with("live bids", || contract.storage_unregister(None));
    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    open(&mut contract, round, bid, &sealed, received + NS);
    clear(&mut contract, round, received + REVEAL_WINDOW);
    assert_eq!(
        contract.get_round(U64(round)).unwrap().lien_id,
        Some(U64(0))
    );
    assert_eq!(
        contract
            .get_holding(holder.clone(), class.clone())
            .encumbered,
        U128(10_000_000)
    );
    settle(&mut contract, round, ask, received + REVEAL_WINDOW + NS);
    settle(&mut contract, round, bid, received + REVEAL_WINDOW + NS);
    assert!(cash(&contract, &holder) > 0, "the holder was paid");
    env(&holder, one_yocto(), ts(20_000));
    panics_with("liens", || contract.storage_unregister(None));
}

#[test]
fn advance_cancelled_for_lack_of_key_returns_the_units_whatever_the_holder_did_to_its_storage() {
    let (mut contract, class, holder, funder, round) = all_units_advance();
    place_ask(
        &mut contract,
        round,
        &holder,
        1_500_000,
        900_000,
        1_500_000,
        ts(3_000),
    );
    let (bid, _) = place_bid(
        &mut contract,
        round,
        &funder,
        1_500_000,
        1_000_000,
        2_000_000,
        ts(3_500),
    );
    env_at(&accounts(5), ts(6_000) + KEY_TIMEOUT);
    contract.cancel_no_key(U64(round));
    assert_eq!(
        contract.mt_balance_of(holder.clone(), class.clone()).0,
        10_000_000,
        "the encumbered units are back"
    );
    settle(&mut contract, round, bid, ts(6_001) + KEY_TIMEOUT);
    assert_eq!(
        cash(&contract, &funder),
        3_000_000,
        "the funder's escrow and bond are back"
    );
    settle(&mut contract, round, 0, ts(6_001) + KEY_TIMEOUT);
    env(&holder, one_yocto(), ts(7_000) + KEY_TIMEOUT);
    panics_with("still holds units", || contract.storage_unregister(None));
}
