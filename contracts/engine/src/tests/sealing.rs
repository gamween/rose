//! Key release and openings: malformed bids, lost callbacks, `submit_key`, `cancel_no_key`,
//! reveal window boundaries and opening by third parties.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;

use super::*;
use crate::sealing::CkdResponse;
use crate::types::{CancelReason, KeySource, Phase, RoundStatus, Side, VoidReason};

/// `(contract, class, seller, buyer, round, ask, bid)` of an Exit with one ask and one bid.
type ExitFixture = (
    Contract,
    String,
    AccountId,
    AccountId,
    u64,
    (u32, Sealed),
    (u32, Sealed),
);

fn exit_with_orders() -> ExitFixture {
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
    let ask = place_ask(
        &mut contract,
        round,
        &seller,
        2_000_000,
        1_000_000,
        2_000_000,
        ts(3_000),
    );
    let bid = place_bid(
        &mut contract,
        round,
        &buyer,
        2_000_000,
        1_200_000,
        1_500_000,
        ts(3_500),
    );
    (contract, class, seller, buyer, round, ask, bid)
}

#[test]
fn malformed_bid_is_unopenable_and_slashed() {
    let (mut contract, class, seller, buyer, round, (ask, ask_sealed), _) = exit_with_orders();
    // A third bidder submits a ciphertext whose V does not encrypt its sigma.
    let mallory = accounts(3);
    fund(&mut contract, &mallory, 2 * USDC, ts(1_000));
    register(&mut contract, &mallory, ts(1_000));
    let mut sealed = seal(round, &mallory, Side::Buy, 100, 100);
    let mut bytes = hex::decode(&sealed.ciphertext).unwrap();
    bytes[rose_ibe::G2_LEN] ^= 0x80;
    sealed.ciphertext = hex::encode(bytes);
    env(&mallory, BID_STORAGE_DEPOSIT, ts(3_500));
    let bad = contract.place_bid(U64(round), sealed.ciphertext.clone(), U128(USDC));

    let received = close_and_release(&mut contract, round, ts(6_000));
    open(&mut contract, round, ask, &ask_sealed, received + NS);
    env_at(&mallory, received + NS);
    panics_with("Opening does not match the ciphertext", || {
        contract.open_bid(
            U64(round),
            bad,
            sealed.plaintext.clone(),
            sealed.sigma.clone(),
        );
    });
    clear(&mut contract, round, received + REVEAL_WINDOW);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert_eq!(result.fills[bad as usize].void, Some(VoidReason::Unopened));
    assert_eq!(
        result.fills[1].void,
        Some(VoidReason::Unopened),
        "the honest buyer forgot to open too"
    );
    assert_eq!(
        contract.round(round).phase,
        Phase::Cancelled,
        "no valid bid remains"
    );
    settle(&mut contract, round, bad, ts(7_000));
    assert_eq!(cash(&contract, &mallory), USDC, "escrow back, bond slashed");
    assert_eq!(cash(&contract, &treasury()), USDC);
    settle(&mut contract, round, ask, ts(7_000));
    assert_eq!(cash(&contract, &seller), USDC, "opened ask: bond back");
    assert_eq!(
        contract.mt_balance_of(seller.clone(), class.clone()).0,
        2_000_000
    );
    settle(&mut contract, round, 1, ts(7_000));
    assert_eq!(
        cash(&contract, &buyer),
        1_500_000,
        "unopened: escrow back, bond slashed"
    );
}

#[test]
fn opening_uses_the_stored_bidder_and_side() {
    let (mut contract, _, _, buyer, round, (ask, ask_sealed), (bid, _)) = exit_with_orders();
    let received = close_and_release(&mut contract, round, ts(6_000));
    // Anyone can open with the right opening.
    env_at(&accounts(4), received + NS);
    contract.open_bid(
        U64(round),
        ask,
        ask_sealed.plaintext.clone(),
        ask_sealed.sigma.clone(),
    );
    // A ciphertext bound to another bidder has no valid opening for the stored bid.
    let foreign = seal(round, &accounts(4), Side::Buy, 2_000_000, 1_200_000);
    env_at(&buyer, received + NS);
    panics_with("Opening does not match the ciphertext", || {
        contract.open_bid(
            U64(round),
            bid,
            foreign.plaintext.clone(),
            foreign.sigma.clone(),
        );
    });
    env_at(&buyer, received + NS);
    panics_with("Bid already opened", || {
        contract.open_bid(
            U64(round),
            ask,
            ask_sealed.plaintext.clone(),
            ask_sealed.sigma.clone(),
        );
    });
    env_at(&buyer, received + NS);
    panics_with("plaintext must be 48 bytes of hex", || {
        contract.open_bid(U64(round), bid, "zz".into(), ask_sealed.sigma.clone());
    });
    env_at(&buyer, received + NS);
    panics_with("Unknown bid", || {
        contract.open_bid(
            U64(round),
            9,
            ask_sealed.plaintext.clone(),
            ask_sealed.sigma.clone(),
        )
    });
}

#[test]
fn reveal_window_boundaries() {
    let (mut contract, _, _, _, round, (ask, ask_sealed), (bid, bid_sealed)) = exit_with_orders();
    env(&accounts(5), one_yocto(), ts(6_000) - 1);
    panics_with("Round is still open", || contract.close(U64(round)));
    env_at(&accounts(5), ts(6_000));
    panics_with("Round is not revealing", || {
        contract.open_bid(
            U64(round),
            ask,
            ask_sealed.plaintext.clone(),
            ask_sealed.sigma.clone(),
        );
    });
    let received = close_and_release(&mut contract, round, ts(6_000));
    assert_eq!(
        contract.get_round(U64(round)).unwrap().reveal_ends_at,
        Some(U64(received + REVEAL_WINDOW))
    );
    env_at(&accounts(5), received + REVEAL_WINDOW - 1);
    panics_with("Reveal window is still open", || contract.clear(U64(round)));
    open(
        &mut contract,
        round,
        ask,
        &ask_sealed,
        received + REVEAL_WINDOW - 1,
    );
    env_at(&accounts(5), received + REVEAL_WINDOW);
    assert_eq!(
        contract.get_round(U64(round)).unwrap().status,
        RoundStatus::Clearing
    );
    panics_with("Reveal window is over", || {
        contract.open_bid(
            U64(round),
            bid,
            bid_sealed.plaintext.clone(),
            bid_sealed.sigma.clone(),
        );
    });
    env_at(&accounts(5), received + REVEAL_WINDOW);
    panics_with("Round has not ended", || {
        contract.settle_bid(U64(round), ask)
    });
    clear(&mut contract, round, received + REVEAL_WINDOW);
    env_at(&accounts(5), received + REVEAL_WINDOW);
    panics_with("Round is not revealing", || contract.clear(U64(round)));
}

#[test]
fn close_retries_while_the_key_is_missing_and_bad_responses_store_nothing() {
    let (mut contract, _, _, _, round, _, _) = exit_with_orders();
    env(&accounts(5), one_yocto(), ts(6_000));
    assert!(contract.close(U64(round)).is_some());
    assert_eq!(
        contract.get_round(U64(round)).unwrap().status,
        RoundStatus::KeyRequested
    );
    env_at(&engine(), ts(6_005));
    assert!(!contract.on_round_key(U64(round), Err(near_sdk::PromiseError::Failed)));
    assert_eq!(
        events("rose").last().unwrap()["event"],
        "key_request_failed"
    );
    assert!(contract.round(round).key.is_none());
    // A response for another round unwraps to a key that fails the pairing check.
    env_at(&engine(), ts(6_005));
    assert!(!contract.on_round_key(U64(round), Ok(ckd_response(round + 1))));
    assert!(contract.round(round).key.is_none());
    env_at(&engine(), ts(6_005));
    assert!(!contract.on_round_key(
        U64(round),
        Ok(CkdResponse {
            big_y: "bls12381g1:11".into(),
            big_c: "x".into()
        })
    ));
    assert!(contract.round(round).key.is_none());
    env_at(&engine(), ts(6_005));
    assert!(!contract.on_round_key(
        U64(round),
        Ok(CkdResponse {
            big_y: rose_ibe::format_near_g1_bytes(&[0xffu8; 48]),
            big_c: rose_ibe::format_near_g1_bytes(&[0xffu8; 48]),
        })
    ));
    assert!(contract.round(round).key.is_none());
    // Retry.
    env(&account("retry"), one_yocto(), ts(6_100));
    assert!(contract.close(U64(round)).is_some());
    env_at(&engine(), ts(6_105));
    assert!(contract.on_round_key(U64(round), Ok(ckd_response(round))));
    let view = contract.get_round(U64(round)).unwrap();
    assert_eq!(view.key_source, Some(KeySource::Callback));
    assert_eq!(view.key, Some(rose_ibe::format_near_g1(&round_key(round))));
    assert_eq!(view.key_received_at, Some(U64(ts(6_105))));
    // A late duplicate callback is ignored.
    env_at(&engine(), ts(6_110));
    assert!(!contract.on_round_key(U64(round), Ok(ckd_response(round))));
    assert_eq!(events("rose").last().unwrap()["event"], "key_ignored");
    assert_eq!(
        contract.get_round(U64(round)).unwrap().key_received_at,
        Some(U64(ts(6_105)))
    );
    env(&account("retry"), one_yocto(), ts(6_200));
    panics_with("Round is not closable", || contract.close(U64(round)));
}

#[test]
fn submit_key_accepts_the_right_key_and_rejects_others() {
    let (mut contract, _, _, _, round, (ask, ask_sealed), _) = exit_with_orders();
    let key = rose_ibe::format_near_g1(&round_key(round));
    env_at(&accounts(5), ts(6_000));
    panics_with("Round does not expect a key", || {
        contract.submit_key(U64(round), key.clone())
    });
    env(&accounts(5), one_yocto(), ts(6_000));
    assert!(contract.close(U64(round)).is_some());
    env_at(&accounts(5), ts(6_000));
    panics_with("Key does not verify for this round", || {
        contract.submit_key(U64(round), rose_ibe::format_near_g1(&round_key(round + 1)));
    });
    env_at(&accounts(5), ts(6_000));
    panics_with("Key must be a bls12381g1:<base58> string", || {
        contract.submit_key(U64(round), "ed25519:abc".into())
    });
    env_at(&accounts(5), ts(6_000));
    panics_with("Key does not verify for this round", || {
        contract.submit_key(U64(round), rose_ibe::format_near_g1_bytes(&[0u8; 48]));
    });
    assert!(contract.round(round).key.is_none());
    // Lost callback: anyone submits the key unwrapped off chain from the public MPC response.
    env_at(&accounts(5), ts(6_010));
    contract.submit_key(U64(round), key.clone());
    let view = contract.get_round(U64(round)).unwrap();
    assert_eq!(view.key_source, Some(KeySource::Submitted));
    assert_eq!(view.status, RoundStatus::Revealing);
    env_at(&accounts(5), ts(6_010));
    panics_with("Round does not expect a key", || {
        contract.submit_key(U64(round), key.clone())
    });
    open(&mut contract, round, ask, &ask_sealed, ts(6_020));
    assert_eq!(contract.get_round(U64(round)).unwrap().opened_count, 1);
}

#[test]
fn cancel_no_key_refunds_everything_after_the_timeout() {
    let (mut contract, class, seller, buyer, round, (ask, _), (bid, _)) = exit_with_orders();
    env(&accounts(5), one_yocto(), ts(6_000));
    assert!(contract.close(U64(round)).is_some());
    env_at(&accounts(5), ts(6_000) + KEY_TIMEOUT - 1);
    panics_with("Key timeout not reached", || {
        contract.cancel_no_key(U64(round))
    });
    env_at(&accounts(5), ts(6_000) + KEY_TIMEOUT);
    contract.cancel_no_key(U64(round));
    assert_eq!(
        contract.round(round).cancel_reason,
        Some(CancelReason::NoKey)
    );
    assert_eq!(transferred_to(&accounts(0)), 0);
    let result = contract.get_round_result(U64(round)).unwrap();
    assert!(
        result.fills.iter().all(|f| f.void.is_none()),
        "nothing could be opened: nothing is slashed"
    );
    env_at(&accounts(5), ts(6_000) + KEY_TIMEOUT);
    panics_with("Round is not waiting for a key", || {
        contract.cancel_no_key(U64(round))
    });
    settle(&mut contract, round, ask, ts(10_000));
    settle(&mut contract, round, bid, ts(10_000));
    assert_eq!(cash(&contract, &seller), USDC);
    assert_eq!(cash(&contract, &buyer), 2_500_000);
    assert_eq!(
        contract.mt_balance_of(seller.clone(), class.clone()).0,
        2_000_000
    );
    // Locked from 0.2, returned at 0.9: full accrual to the seller.
    assert_eq!(
        contract.get_claimable(seller.clone(), class.clone()).0,
        2_000_000 * 9 / 10
    );
    assert_eq!(transferred_to(&seller), bid_refund(&contract, round, ask));
    assert_eq!(transferred_to(&buyer), bid_refund(&contract, round, bid));
    assert!(bid_refund(&contract, round, bid) < BID_STORAGE_DEPOSIT.as_yoctonear());
    // A round that was never closed can also time out.
    let round2 = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(10_000),
        ts(11_000) - 1,
    );
    place_ask(&mut contract, round2, &seller, 1, 1, 1, ts(10_500));
    env_at(&accounts(5), ts(11_000) + KEY_TIMEOUT);
    contract.cancel_no_key(U64(round2));
    assert_eq!(
        contract.get_round(U64(round2)).unwrap().status,
        RoundStatus::Cancelled
    );
}

#[test]
fn closing_an_empty_round_cancels_it_without_a_key_request() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    env_at(&accounts(5), ts(6_000));
    panics_with("Round does not expect a key", || {
        contract.submit_key(U64(round), rose_ibe::format_near_g1(&round_key(round)));
    });
    env(&accounts(5), one_yocto(), ts(6_000));
    assert!(contract.close(U64(round)).is_none());
    assert_eq!(
        contract.round(round).cancel_reason,
        Some(CancelReason::Empty)
    );
    assert_eq!(transferred_to(&accounts(0)), 0);
}

/// A late CKD response must never revive a cancelled round: close at the timeout, cancel the
/// next block, then the callback arrives.
fn late_callback_is_ignored(contract: &mut Contract, round: u64) {
    env(&accounts(5), one_yocto(), ts(6_000) + KEY_TIMEOUT);
    assert!(contract.close(U64(round)).is_some());
    env_at(&accounts(5), ts(6_001) + KEY_TIMEOUT);
    contract.cancel_no_key(U64(round));
    env_at(&engine(), ts(6_002) + KEY_TIMEOUT);
    assert!(!contract.on_round_key(U64(round), Ok(ckd_response(round))));
    assert_eq!(events("rose").last().unwrap()["event"], "key_ignored");
    let view = contract.get_round(U64(round)).unwrap();
    assert_eq!(view.status, RoundStatus::Cancelled);
    assert!(view.key.is_none());
    assert_eq!(
        contract.round(round).cancel_reason,
        Some(CancelReason::NoKey)
    );
    env_at(&accounts(5), ts(6_002) + KEY_TIMEOUT);
    panics_with("Round does not expect a key", || {
        contract.submit_key(U64(round), rose_ibe::format_near_g1(&round_key(round)));
    });
}

#[test]
fn late_callback_cannot_revive_a_cancelled_tender() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 0);
    let (issuer, a) = (accounts(0), accounts(1));
    mint(&mut contract, &class, &a, 100, ts(500));
    fund(&mut contract, &issuer, 953, ts(500));
    fund(&mut contract, &a, USDC, ts(500));
    let round = create_tender(&mut contract, &issuer, &class, 950, 10, ts(500), ts(6_000));
    let (ask, _) = place_ask(&mut contract, round, &a, 100, 9, 100, ts(600));
    late_callback_is_ignored(&mut contract, round);
    assert_eq!(cash(&contract, &issuer), 953, "the escrow came back once");
    settle(&mut contract, round, ask, ts(7_000) + KEY_TIMEOUT);
    assert_eq!(cash(&contract, &issuer), 953);
    assert_eq!(cash(&contract, &a), USDC);
    assert_eq!(contract.mt_balance_of(a, class).0, 100);
}

#[test]
fn late_callback_cannot_revive_a_cancelled_exit() {
    let (mut contract, class, seller, buyer, round, (ask, _), (bid, _)) = exit_with_orders();
    late_callback_is_ignored(&mut contract, round);
    settle(&mut contract, round, ask, ts(7_000) + KEY_TIMEOUT);
    settle(&mut contract, round, bid, ts(7_000) + KEY_TIMEOUT);
    assert_eq!(cash(&contract, &seller), USDC);
    assert_eq!(cash(&contract, &buyer), 2_500_000);
    assert_eq!(contract.mt_balance_of(seller, class).0, 2_000_000);
}

#[test]
fn late_callback_cannot_revive_a_cancelled_advance() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (holder, funder) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &holder, 4_000_000, ts(1_000));
    fund(&mut contract, &holder, USDC, ts(1_000));
    fund(&mut contract, &funder, 3_000_000, ts(1_000));
    let round = create_advance(
        &mut contract,
        &holder,
        &class,
        AdvanceSpec {
            units: 4_000_000,
            claim: 1_000_000,
            min_fill: 0,
            max_price: 2_000_000,
        },
        ts(2_500),
        ts(6_000),
    );
    let (ask, _) = place_ask(
        &mut contract,
        round,
        &holder,
        1_000_000,
        1_000_000,
        1_000_000,
        ts(3_000),
    );
    let (bid, _) = place_bid(
        &mut contract,
        round,
        &funder,
        1_000_000,
        1_000_000,
        1_500_000,
        ts(3_500),
    );
    late_callback_is_ignored(&mut contract, round);
    assert_eq!(
        contract.mt_balance_of(holder.clone(), class.clone()).0,
        4_000_000
    );
    settle(&mut contract, round, ask, ts(7_000) + KEY_TIMEOUT);
    settle(&mut contract, round, bid, ts(7_000) + KEY_TIMEOUT);
    assert_eq!(cash(&contract, &holder), USDC);
    assert_eq!(cash(&contract, &funder), 3_000_000);
    assert_eq!(contract.get_round(U64(round)).unwrap().lien_id, None);
}
