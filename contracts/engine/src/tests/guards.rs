//! Guards of round creation, cancellation and orders, plus init validation.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::accounts;
use near_sdk::NearToken;

use super::*;
use crate::rounds::ExitParams;
use crate::types::{RoundStatus, Side};

#[test]
fn round_creation_guards() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let creator = accounts(0);
    let exit = |closes_at: u64, venue: Venue, max_price: u128| ExitParams {
        class_id: class.clone(),
        venue,
        max_price: U128(max_price),
        window: window(closes_at),
    };
    env_at(&creator, ts(2_000));
    panics_with("Attach the round storage deposit", || {
        contract.create_exit(exit(ts(6_000), Venue::Near, 1))
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("max_price must be positive", || {
        contract.create_exit(exit(ts(6_000), Venue::Near, 0))
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("Unsupported cash venue", || {
        contract.create_exit(exit(
            ts(6_000),
            Venue::Base {
                token: "0xdead".into(),
            },
            1,
        ))
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("closes_at must be in the future", || {
        contract.create_exit(exit(ts(2_000), Venue::Near, 1))
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("Class is fully unlocked at the close time", || {
        contract.create_exit(exit(ts(11_000), Venue::Near, 1))
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("Unknown class", || {
        contract.create_exit(ExitParams {
            class_id: "nope".into(),
            ..exit(ts(6_000), Venue::Near, 1)
        })
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("closes_at must be after opens_at", || {
        contract.create_exit(ExitParams {
            window: RoundWindow {
                opens_at: Some(U64(ts(7_000))),
                ..window(ts(6_000))
            },
            ..exit(ts(6_000), Venue::Near, 1)
        })
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("reveal_window must be positive", || {
        contract.create_exit(ExitParams {
            window: RoundWindow {
                reveal_window: Some(U64(0)),
                ..window(ts(6_000))
            },
            ..exit(ts(6_000), Venue::Near, 1)
        })
    });
    // Base venue accepted when configured; a scheduled round waits for opens_at.
    let base = Venue::Base {
        token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e".into(),
    };
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    let round = contract.create_exit(ExitParams {
        window: RoundWindow {
            opens_at: Some(U64(ts(3_000))),
            ..window(ts(6_000))
        },
        ..exit(ts(6_000), base.clone(), 1)
    });
    assert_eq!(
        contract.get_round(round).unwrap().status,
        RoundStatus::Scheduled
    );
    assert_eq!(contract.get_round(round).unwrap().venue, base);
    env(&accounts(1), BID_STORAGE_DEPOSIT, ts(2_500));
    panics_with("Round has not opened yet", || {
        contract.place_bid(
            round,
            seal(round.0, &accounts(1), Side::Buy, 1, 1).ciphertext,
            U128(1),
        );
    });
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("Budget must be positive", || {
        create_tender(&mut contract, &creator, &class, 0, 1, ts(2_000), ts(6_000));
    });
    panics_with("Insufficient cash", || {
        create_tender(
            &mut contract,
            &creator,
            &class,
            1_000,
            1,
            ts(2_000),
            ts(6_000),
        );
    });
}

#[test]
fn order_guards() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (seller, buyer) = (accounts(1), accounts(2));
    mint(&mut contract, &class, &seller, 1_000_000, ts(1_000));
    fund(&mut contract, &buyer, 3 * USDC, ts(1_000));
    let round = create_exit(
        &mut contract,
        &accounts(0),
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    let ct = seal(round, &buyer, Side::Buy, 1, 1).ciphertext;
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with(
        "Exit buyers receive units: call storage_deposit first",
        || contract.place_bid(U64(round), ct.clone(), U128(USDC)),
    );
    register(&mut contract, &buyer, ts(3_000));
    env_at(&buyer, ts(3_000));
    panics_with("Attach the bid storage deposit", || {
        contract.place_bid(U64(round), ct.clone(), U128(USDC))
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Escrow must be positive", || {
        contract.place_bid(U64(round), ct.clone(), U128(0))
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Insufficient cash", || {
        contract.place_bid(U64(round), ct.clone(), U128(3 * USDC))
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Ciphertext must be 192 bytes", || {
        contract.place_bid(U64(round), "00ff".into(), U128(USDC))
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("ciphertext_hex is not hex", || {
        contract.place_bid(U64(round), "zz".into(), U128(USDC))
    });
    env(&seller, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Insufficient cash", || {
        contract.place_ask(
            U64(round),
            seal(round, &seller, Side::Sell, 1, 1).ciphertext,
            U128(1),
        )
    });
    fund(&mut contract, &seller, USDC, ts(3_000));
    env(&seller, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("not enough units", || {
        contract.place_ask(
            U64(round),
            seal(round, &seller, Side::Sell, 1, 1).ciphertext,
            U128(1_000_001),
        )
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(6_000));
    panics_with("Round is closed", || {
        contract.place_bid(U64(round), ct.clone(), U128(USDC))
    });
    env(&buyer, BID_STORAGE_DEPOSIT, ts(3_000));
    panics_with("Unknown round", || {
        contract.place_bid(U64(9), ct.clone(), U128(USDC))
    });
}

#[test]
fn cancel_round_only_by_the_creator_before_the_first_bid() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let (creator, buyer) = (accounts(0), accounts(2));
    fund(&mut contract, &buyer, 3 * USDC, ts(1_000));
    let round = create_exit(
        &mut contract,
        &creator,
        &class,
        2_000_000,
        ts(2_500),
        ts(6_000),
    );
    env_at(&buyer, ts(3_000));
    panics_with("Only the creator can cancel", || {
        contract.cancel_round(U64(round))
    });
    place_bid(&mut contract, round, &buyer, 1, 1, USDC, ts(3_000));
    env_at(&creator, ts(3_000));
    panics_with("Round already has bids", || {
        contract.cancel_round(U64(round))
    });
    let round2 = create_exit(
        &mut contract,
        &creator,
        &class,
        2_000_000,
        ts(3_000),
        ts(6_000),
    );
    env_at(&creator, ts(6_000));
    panics_with("Round already closed", || {
        contract.cancel_round(U64(round2))
    });
    env_at(&creator, ts(5_000));
    contract.cancel_round(U64(round2));
    assert_eq!(
        contract.get_round(U64(round2)).unwrap().status,
        RoundStatus::Cancelled
    );
    assert_eq!(
        transferred_to(&creator),
        0,
        "the round deposit stays with the record"
    );
    assert_eq!(
        contract.round(round2).storage_deposit,
        ROUND_STORAGE_DEPOSIT.as_yoctonear()
    );
    env_at(&creator, ts(5_000));
    panics_with("Round is not open", || contract.cancel_round(U64(round2)));
    assert_eq!(events("rose").last().unwrap()["data"]["reason"], "Creator");
}

#[test]
fn cash_guards() {
    let mut contract = init();
    let alice = accounts(1);
    env_at(&alice, ts(1_000));
    panics_with("Only the configured cash token is accepted", || {
        contract
            .ft_on_transfer(alice.clone(), U128(1), String::new())
            .detach();
    });
    env_at(&cash_token(), ts(1_000));
    panics_with("msg must be empty", || {
        contract
            .ft_on_transfer(alice.clone(), U128(1), "x".into())
            .detach();
    });
    fund(&mut contract, &alice, 5 * USDC, ts(1_000));
    assert_eq!(cash(&contract, &alice), 5 * USDC);
    env_at(&alice, ts(1_000));
    panics_with("exactly 1 yoctoNEAR", || {
        contract.withdraw_near_cash(U128(1)).detach()
    });
    env(&alice, one_yocto(), ts(1_000));
    panics_with("Insufficient cash", || {
        contract.withdraw_near_cash(U128(6 * USDC)).detach()
    });
    env(&alice, one_yocto(), ts(1_000));
    contract.withdraw_near_cash(U128(2 * USDC)).detach();
    assert_eq!(cash(&contract, &alice), 3 * USDC);
    env_at(&engine(), ts(1_000));
    assert!(!contract.on_near_cash_withdrawn(
        alice.clone(),
        U128(2 * USDC),
        Err(near_sdk::PromiseError::Failed)
    ));
    assert_eq!(
        cash(&contract, &alice),
        5 * USDC,
        "failed transfer credited back"
    );
    assert_eq!(
        events("rose").last().unwrap()["event"],
        "cash_withdrawal_failed"
    );
    env_at(&engine(), ts(1_000));
    assert!(contract.on_near_cash_withdrawn(alice.clone(), U128(2 * USDC), Ok(())));
    assert_eq!(cash(&contract, &alice), 5 * USDC);
    let withdrawn = events("rose").last().unwrap().clone();
    assert_eq!(withdrawn["event"], "cash_withdrawn");
    assert_eq!(withdrawn["data"]["venue"], "Near");
    assert_eq!(contract.get_cash(alice.clone())[0].amount, U128(5 * USDC));
}

#[test]
fn init_validates_its_arguments() {
    env_at(&engine(), ts(100));
    let args = |key: &str| InitArgs {
        mpc_account: "v1.signer-prod.testnet".parse().unwrap(),
        sign_secp256k1_domain: 0,
        sign_ed25519_domain: 1,
        ckd_domain: 2,
        foreign_tx_domain: 3,
        ckd_public_key: key.to_string(),
        fee_recipient: treasury(),
        near_cash_token: cash_token(),
        base_cash_tokens: vec![],
        rose_vault: "0x1111111111111111111111111111111111111111".to_string(),
        base_chain_id: 84532,
        sablier_lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e".to_string(),
        streamflow_program: "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ".to_string(),
        default_key_timeout: Some(U64(1)),
        default_reveal_window: Some(U64(2)),
    };
    panics_with("Invalid CKD public key", || {
        Contract::new(args("ed25519:abc"));
    });
    panics_with("Base chain id is required", || {
        Contract::new(InitArgs {
            base_chain_id: 0,
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    panics_with("Invalid RoseVault address", || {
        Contract::new(InitArgs {
            rose_vault: "0xABC".into(),
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    panics_with("Base cash tokens must be lowercase 0x addresses", || {
        Contract::new(InitArgs {
            base_cash_tokens: vec!["0x036CBD53842C5426634E7929541EC2318F3DCF7E".into()],
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    let contract = Contract::new(args(&rose_ibe::format_near_g2(&mpk())));
    let config = contract.get_config();
    assert_eq!(config.default_key_timeout, U64(1));
    assert_eq!(config.default_reveal_window, U64(2));
    assert!(config.derived_addresses.is_none());
    let limits = contract.get_limits();
    assert_eq!(
        limits.bid_storage_deposit,
        U128(NearToken::from_millinear(20).as_yoctonear())
    );
    assert_eq!(limits.fee_bps, 30);
}

#[test]
fn retire_to_must_match_the_class_chain() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let issuer = accounts(0);
    fund(&mut contract, &issuer, 10 * USDC, ts(1_000));
    let tender = |retire_to: &str| crate::rounds::TenderParams {
        class_id: class.clone(),
        venue: Venue::Near,
        budget: U128(USDC),
        max_price: U128(1),
        reference_price: None,
        retire_to: retire_to.to_string(),
        window: window(ts(6_000)),
    };
    for bad in [
        "",
        "0x000000000000000000000000000000000000dead",
        "111",
        "0OIl",
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with(
            "retire_to must be a lowercase 0x address (Base) or a 32-byte base58 key (Solana)",
            || contract.create_tender(tender(bad)),
        );
    }
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    contract.create_tender(tender(RETIRE_TO));
    // A Base class takes an EVM address.
    env_at(&engine(), ts(100));
    let base = contract.ensure_class(
        crate::types::Chain::Base,
        "0xtoken".into(),
        6,
        stepped_schedule(),
    );
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("retire_to must be a lowercase 0x address", || {
        contract.create_tender(crate::rounds::TenderParams {
            class_id: base.clone(),
            ..tender(RETIRE_TO)
        })
    });
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    contract.create_tender(crate::rounds::TenderParams {
        class_id: base,
        ..tender("0x000000000000000000000000000000000000dead")
    });
}
