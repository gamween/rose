//! The event history is bounded in bytes: every entry, of every variant, fits
//! `EVENT_RECORD_MAX_BYTES`, so the reserve `new` requires covers the full history; free texts
//! are cut; a zero-deposit storage top-up records nothing; an underfunded engine refuses to
//! initialize.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken};

use super::*;
use crate::custody::ReplayKey;
use crate::events::{EVENT_HISTORY_RESERVE_BYTES, EVENT_RECORD_MAX_BYTES, EVENT_TEXT_MAX_BYTES};
use crate::types::{CancelReason, Chain, KeySource, RoundKind, Side, Venue, VoidReason};
use crate::RoseEvent;

fn longest() -> AccountId {
    "a".repeat(64).parse().unwrap()
}

fn class() -> String {
    "f".repeat(64)
}

fn venue() -> Venue {
    Venue::Base {
        token: format!("0x{}", "e".repeat(40)),
    }
}

/// A text longer than any event keeps.
fn text() -> String {
    "é".repeat(EVENT_TEXT_MAX_BYTES)
}

/// The largest replay key: a durable nonce (two base58 keys of 44 characters).
fn key() -> ReplayKey {
    ReplayKey::SolNonce {
        account: "1".repeat(44),
        value: "1".repeat(44),
    }
}

fn big() -> U128 {
    U128(u128::MAX)
}

/// One worst case of every variant.
fn worst_cases() -> Vec<RoseEvent> {
    let account = longest;
    vec![
        RoseEvent::ClassCreated { class_id: class() },
        RoseEvent::PositionRegistered {
            position_id: U64(u64::MAX),
            class_id: class(),
            depositor: account(),
            allocation: big(),
        },
        RoseEvent::PositionReleased {
            position_id: U64(u64::MAX),
            class_id: class(),
            account: account(),
        },
        RoseEvent::UnitsMinted {
            class_id: class(),
            account: account(),
            units: big(),
        },
        RoseEvent::UnitsBurned {
            class_id: class(),
            account: account(),
            units: big(),
        },
        RoseEvent::UnitsTransferred {
            class_id: class(),
            from: account(),
            to: account(),
            units: big(),
        },
        RoseEvent::CashDeposited {
            account: account(),
            venue: venue(),
            amount: big(),
        },
        RoseEvent::CashWithdrawn {
            account: account(),
            venue: venue(),
            amount: big(),
        },
        RoseEvent::CashWithdrawalFailed {
            account: account(),
            venue: venue(),
            amount: big(),
        },
        RoseEvent::RoundCreated {
            round_id: U64(u64::MAX),
            kind: RoundKind::Advance,
            class_id: class(),
            venue: venue(),
            creator: account(),
            opens_at: U64(u64::MAX),
            closes_at: U64(u64::MAX),
            max_price: big(),
        },
        RoseEvent::BidPlaced {
            round_id: U64(u64::MAX),
            bid_id: u32::MAX,
            bidder: account(),
            side: Side::Sell,
            escrow: big(),
            locked_units: big(),
            bond: big(),
        },
        RoseEvent::RoundCancelled {
            round_id: U64(u64::MAX),
            reason: CancelReason::NoCrossing,
        },
        RoseEvent::KeyRequested {
            round_id: U64(u64::MAX),
        },
        RoseEvent::KeyRequestFailed {
            round_id: U64(u64::MAX),
        },
        RoseEvent::KeyIgnored {
            round_id: U64(u64::MAX),
        },
        RoseEvent::ClearingFailed {
            round_id: U64(u64::MAX),
            error: text(),
        },
        RoseEvent::StorageDeposited {
            account: account(),
            amount: big(),
            total: big(),
        },
        RoseEvent::StorageWithdrawn {
            account: account(),
            amount: big(),
        },
        RoseEvent::StorageUnregistered {
            account: account(),
            refund: big(),
        },
        RoseEvent::KeyReceived {
            round_id: U64(u64::MAX),
            source: KeySource::Submitted,
            key: rose_ibe::format_near_g1_bytes(&[0xff; 48]),
        },
        RoseEvent::BidOpened {
            round_id: U64(u64::MAX),
            bid_id: u32::MAX,
            quantity: big(),
            price: big(),
            void: Some(VoidReason::QuantityAboveLocked),
        },
        RoseEvent::RoundCleared {
            round_id: U64(u64::MAX),
            price: big(),
            volume: big(),
            notional: big(),
            fee: big(),
            remaining_lock_secs: U64(u64::MAX),
        },
        RoseEvent::BidSettled {
            round_id: U64(u64::MAX),
            bid_id: u32::MAX,
            bidder: account(),
            fill_quantity: big(),
            cash: big(),
            refund: big(),
            bond_refunded: true,
        },
        RoseEvent::LienCreated {
            lien_id: U64(u64::MAX),
            round_id: U64(u64::MAX),
            class_id: class(),
            holder: account(),
            units: big(),
            claim_total: big(),
        },
        RoseEvent::LienReleased {
            lien_id: U64(u64::MAX),
            holder: account(),
            units: big(),
        },
        RoseEvent::ClaimableTaken {
            class_id: class(),
            source: text(),
            amount: big(),
        },
        RoseEvent::BootstrapRequested,
        RoseEvent::Bootstrapped {
            vault_base: format!("0x{}", "e".repeat(40)),
            vault_sol: "1".repeat(44),
            gas_sol: "1".repeat(44),
        },
        RoseEvent::BootstrapFailed,
        RoseEvent::DepositVerificationRequested { key: key() },
        RoseEvent::DepositVerificationFailed { key: key() },
        RoseEvent::DepositMismatch { key: key() },
        RoseEvent::DepositRefused {
            key: key(),
            reason: text(),
        },
        RoseEvent::DepositRegistered {
            key: key(),
            chain: Chain::Solana,
            position_id: U64(u64::MAX),
            class_id: class(),
            account: account(),
            units: big(),
            checkpoint: big(),
        },
        RoseEvent::BaseCashRegistered {
            key: key(),
            account: account(),
            token: format!("0x{}", "e".repeat(40)),
            amount: big(),
            round_id: U64(u64::MAX),
            accepted: true,
        },
        RoseEvent::SolDepositAttributed {
            metadata: "1".repeat(44),
            account: account(),
            class_id: class(),
            deposit_address: "1".repeat(44),
        },
        RoseEvent::PayoutRequested {
            payout_id: U64(u64::MAX),
            chain: Chain::Solana,
            requester: account(),
        },
        RoseEvent::PayoutSigned {
            payout_id: U64(u64::MAX),
        },
        RoseEvent::PayoutAwaitingGasSignature {
            payout_id: U64(u64::MAX),
        },
        RoseEvent::PayoutFailed {
            payout_id: U64(u64::MAX),
            reason: text(),
        },
        RoseEvent::PositionReleaseRequested {
            position_id: U64(u64::MAX),
            payout_id: U64(u64::MAX),
            account: account(),
        },
        RoseEvent::PayoutLanded {
            payout_id: U64(u64::MAX),
        },
        RoseEvent::PayoutCancelling {
            payout_id: U64(u64::MAX),
        },
        RoseEvent::SolStreamSwept {
            position_id: U64(u64::MAX),
            class_id: class(),
            amount: U64(u64::MAX),
        },
    ]
}

/// Fails to compile when a variant is added without a worst case above.
fn variant_index(event: &RoseEvent) -> usize {
    match event {
        RoseEvent::ClassCreated { .. } => 0,
        RoseEvent::PositionRegistered { .. } => 1,
        RoseEvent::PositionReleased { .. } => 2,
        RoseEvent::UnitsMinted { .. } => 3,
        RoseEvent::UnitsBurned { .. } => 4,
        RoseEvent::UnitsTransferred { .. } => 5,
        RoseEvent::CashDeposited { .. } => 6,
        RoseEvent::CashWithdrawn { .. } => 7,
        RoseEvent::CashWithdrawalFailed { .. } => 8,
        RoseEvent::RoundCreated { .. } => 9,
        RoseEvent::BidPlaced { .. } => 10,
        RoseEvent::RoundCancelled { .. } => 11,
        RoseEvent::KeyRequested { .. } => 12,
        RoseEvent::KeyRequestFailed { .. } => 13,
        RoseEvent::KeyIgnored { .. } => 14,
        RoseEvent::ClearingFailed { .. } => 15,
        RoseEvent::StorageDeposited { .. } => 16,
        RoseEvent::StorageWithdrawn { .. } => 17,
        RoseEvent::StorageUnregistered { .. } => 18,
        RoseEvent::KeyReceived { .. } => 19,
        RoseEvent::BidOpened { .. } => 20,
        RoseEvent::RoundCleared { .. } => 21,
        RoseEvent::BidSettled { .. } => 22,
        RoseEvent::LienCreated { .. } => 23,
        RoseEvent::LienReleased { .. } => 24,
        RoseEvent::ClaimableTaken { .. } => 25,
        RoseEvent::BootstrapRequested => 26,
        RoseEvent::Bootstrapped { .. } => 27,
        RoseEvent::BootstrapFailed => 28,
        RoseEvent::DepositVerificationRequested { .. } => 29,
        RoseEvent::DepositVerificationFailed { .. } => 30,
        RoseEvent::DepositMismatch { .. } => 31,
        RoseEvent::DepositRefused { .. } => 32,
        RoseEvent::DepositRegistered { .. } => 33,
        RoseEvent::BaseCashRegistered { .. } => 34,
        RoseEvent::SolDepositAttributed { .. } => 35,
        RoseEvent::PayoutRequested { .. } => 36,
        RoseEvent::PayoutSigned { .. } => 37,
        RoseEvent::PayoutAwaitingGasSignature { .. } => 38,
        RoseEvent::PayoutFailed { .. } => 39,
        RoseEvent::PositionReleaseRequested { .. } => 40,
        RoseEvent::PayoutLanded { .. } => 41,
        RoseEvent::PayoutCancelling { .. } => 42,
        RoseEvent::SolStreamSwept { .. } => 43,
    }
}

#[test]
fn every_history_entry_fits_its_bound_and_the_reserve_covers_the_full_history() {
    let mut contract = init();
    env_at(&longest(), ts(1_000));
    let cases = worst_cases();
    let mut seen: Vec<usize> = cases.iter().map(variant_index).collect();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(
        seen,
        (0..cases.len()).collect::<Vec<_>>(),
        "one case per variant"
    );
    let mut largest = 0;
    for event in cases {
        contract.events.flush();
        let before = near_sdk::env::storage_usage();
        contract.record(event);
        contract.events.flush();
        let bytes = near_sdk::env::storage_usage() - before;
        assert!(
            bytes <= EVENT_RECORD_MAX_BYTES,
            "an entry uses {bytes} bytes, bound {EVENT_RECORD_MAX_BYTES}"
        );
        largest = largest.max(bytes);
    }
    assert!(
        largest + 32 >= EVENT_RECORD_MAX_BYTES,
        "the bound is the measured worst case ({largest} bytes) with a small margin"
    );
    assert_eq!(
        EVENT_HISTORY_RESERVE_BYTES,
        u64::from(crate::EVENT_CAPACITY) * EVENT_RECORD_MAX_BYTES
    );
}

#[test]
fn free_texts_are_cut_at_a_character_boundary() {
    let RoseEvent::PayoutFailed { reason, .. } = (RoseEvent::PayoutFailed {
        payout_id: U64(0),
        reason: text(),
    })
    .bounded() else {
        unreachable!()
    };
    assert!(reason.len() <= EVENT_TEXT_MAX_BYTES);
    assert!(reason.len() + 2 > EVENT_TEXT_MAX_BYTES);
    assert!(reason.chars().all(|c| c == 'é'));
}

#[test]
fn a_zero_deposit_top_up_records_nothing() {
    let mut contract = init();
    register(&mut contract, &accounts(1), ts(1_000));
    let total = contract.events_total;
    env(&accounts(2), NearToken::from_yoctonear(0), ts(1_001));
    contract.storage_deposit(Some(accounts(1)), None);
    assert_eq!(contract.events_total, total, "no event, no history entry");
    env(&accounts(2), NearToken::from_yoctonear(5), ts(1_002));
    contract.storage_deposit(Some(accounts(1)), None);
    assert_eq!(contract.events_total, total + 1);
}

#[test]
fn an_engine_that_cannot_pay_its_full_history_refuses_to_initialize() {
    init();
    let required = crate::storage::bytes_cost(
        near_sdk::env::storage_usage() + crate::INIT_STATE_BYTES + EVENT_HISTORY_RESERVE_BYTES,
    ) + crate::custody::MPC_BALANCE_RESERVE.as_yoctonear();
    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .predecessor_account_id(engine())
        .account_balance(NearToken::from_yoctonear(required - 1))
        .build();
    testing_env!(context);
    panics_with("Fund the engine with at least", init_args_contract);
    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .predecessor_account_id(engine())
        .account_balance(NearToken::from_yoctonear(required))
        .build();
    testing_env!(context);
    init_args_contract();
}

/// `Contract::new` with the test arguments, in the current context.
fn init_args_contract() -> Contract {
    Contract::new(test_init_args())
}
