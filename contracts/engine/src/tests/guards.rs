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
    // Base venue accepted when configured, in any spelling of its address; a scheduled round
    // waits for opens_at.
    let base = Venue::Base {
        token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e".into(),
    };
    env(&creator, ROUND_STORAGE_DEPOSIT, ts(2_000));
    let round = contract.create_exit(ExitParams {
        window: RoundWindow {
            opens_at: Some(U64(ts(3_000))),
            ..window(ts(6_000))
        },
        ..exit(
            ts(6_000),
            Venue::Base {
                token: "036CbD53842c5426634e7929541eC2318f3dCF7e".into(),
            },
            1,
        )
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
    // Cash the engine owed the buyer registered it with a zero deposit: no room for units yet.
    env_at(&engine(), ts(1_000));
    contract.credit_cash(&buyer, &Venue::Near, 3 * USDC);
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
        "Insufficient storage deposit for charlie: top up with storage_deposit",
        || contract.place_bid(U64(round), ct.clone(), U128(USDC)),
    );
    let min = contract.storage_balance_bounds().min.0;
    env(&buyer, NearToken::from_yoctonear(min), ts(3_000));
    contract.storage_deposit(None, None);
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

/// A G2 curve point outside the prime-order subgroup (the cofactor of G2 is not 1).
fn g2_outside_subgroup() -> G2Affine {
    use ark_bls12_381::{Fq, Fq2};
    (1u64..)
        .find_map(|x| {
            G2Affine::get_point_from_x_unchecked(Fq2::new(Fq::from(x), Fq::from(0u64)), false)
                .filter(|p| !p.is_in_correct_subgroup_assuming_on_curve())
        })
        .expect("a small x gives a curve point outside the subgroup")
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
        default_key_timeout: Some(U64(120 * NS)),
        default_reveal_window: Some(U64(900 * NS)),
    };
    panics_with("Invalid CKD public key: not a bls12381g2 key", || {
        Contract::new(args("ed25519:abc"));
    });
    // 96 bytes that decode are not enough: the key must be a non-zero G2 subgroup point.
    for key in [g2_outside_subgroup(), G2Affine::zero()] {
        panics_with(
            "Invalid CKD public key: not a non-zero point of the G2 subgroup",
            || {
                Contract::new(args(&rose_ibe::format_near_g2(&key)));
            },
        );
    }
    panics_with(
        "Invalid CKD public key: not a non-zero point of the G2 subgroup",
        || {
            Contract::new(args(&rose_ibe::format_near_g2_bytes(&[0xffu8; 96])));
        },
    );
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
    panics_with("Base cash tokens must be 20-byte hex addresses", || {
        Contract::new(InitArgs {
            base_cash_tokens: vec!["0x036CBD53842C5426634E7929541EC2318F3DCF".into()],
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    panics_with("key_timeout must be between", || {
        Contract::new(InitArgs {
            default_key_timeout: Some(U64(1)),
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    panics_with("reveal_window must be between", || {
        Contract::new(InitArgs {
            default_reveal_window: Some(U64(2)),
            ..args(&rose_ibe::format_near_g2(&mpk()))
        });
    });
    // Every configured EVM address is stored in its canonical spelling, whatever the spelling
    // given at init.
    let contract = Contract::new(InitArgs {
        base_cash_tokens: vec!["036CBD53842C5426634E7929541EC2318F3DCF7E".into()],
        rose_vault: "0x11111111111111111111111111111111111111AA".into(),
        sablier_lockup: "A65A1ecEf02C2B9BDc604951c6A6D02335D4532e".into(),
        ..args(&rose_ibe::format_near_g2(&mpk()))
    });
    let config = contract.get_config();
    assert_eq!(
        config.base_cash_tokens,
        vec!["0x036cbd53842c5426634e7929541ec2318f3dcf7e".to_string()]
    );
    assert_eq!(
        config.rose_vault,
        "0x11111111111111111111111111111111111111aa"
    );
    assert_eq!(
        config.sablier_lockup,
        "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e"
    );
    assert_eq!(config.default_key_timeout, U64(120 * NS));
    assert_eq!(config.default_reveal_window, U64(900 * NS));
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
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("Engine is not bootstrapped", || {
        contract.create_tender(tender(RETIRE_TO))
    });
    with_derived_addresses(&mut contract);
    for bad in [
        "",
        "0x000000000000000000000000000000000000dead",
        "111",
        "0OIl",
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with(
            "retire_to must be a 20-byte hex address (Base) or a 32-byte base58 key (Solana)",
            || contract.create_tender(tender(bad)),
        );
    }
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("retire_to must not be the zero address", || {
        contract.create_tender(tender("11111111111111111111111111111111"))
    });
    for engine_key in [TEST_VAULT_SOL, TEST_GAS_SOL] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with("retire_to must not be RoseVault", || {
            contract.create_tender(tender(engine_key))
        });
    }
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    contract.create_tender(tender(RETIRE_TO));
    // A Base class takes an EVM address in any spelling and stores it canonical.
    env_at(&engine(), ts(100));
    let base = contract.ensure_class(
        crate::types::Chain::Base,
        "0xtoken".into(),
        6,
        stepped_schedule(),
    );
    let base_tender = |retire_to: &str| crate::rounds::TenderParams {
        class_id: base.clone(),
        ..tender(retire_to)
    };
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    panics_with("retire_to must be a 20-byte hex address", || {
        contract.create_tender(base_tender(RETIRE_TO))
    });
    for refused in [
        "0x0000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000",
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with("retire_to must not be the zero address", || {
            contract.create_tender(base_tender(refused))
        });
    }
    for engine_address in [
        "0x1111111111111111111111111111111111111111",
        "00000000000000000000000000000000000000B5",
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with("retire_to must not be RoseVault", || {
            contract.create_tender(base_tender(engine_address))
        });
    }
    for spelling in [
        "0x000000000000000000000000000000000000dEaD",
        "000000000000000000000000000000000000DEAD",
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        let round = contract.create_tender(base_tender(spelling));
        assert_eq!(
            contract.get_round(round).unwrap().retire_to.as_deref(),
            Some("0x000000000000000000000000000000000000dead")
        );
    }
}

#[test]
fn round_windows_are_bounded() {
    let mut contract = init();
    let class = stepped_class(&mut contract, 6);
    let creator = accounts(0);
    let at = ts(2_000);
    let exit = |window: RoundWindow| ExitParams {
        class_id: class.clone(),
        venue: Venue::Near,
        max_price: U128(1),
        window,
    };
    let with = |key_timeout: u64, reveal_window: u64| RoundWindow {
        key_timeout: Some(U64(key_timeout)),
        reveal_window: Some(U64(reveal_window)),
        ..window(ts(6_000))
    };
    for (key_timeout, reveal_window, message) in [
        (
            crate::MIN_KEY_TIMEOUT_NS - 1,
            REVEAL_WINDOW,
            "key_timeout must be between",
        ),
        (
            crate::MAX_KEY_TIMEOUT_NS + 1,
            REVEAL_WINDOW,
            "key_timeout must be between",
        ),
        (KEY_TIMEOUT, 0, "reveal_window must be between"),
        (KEY_TIMEOUT, NS, "reveal_window must be between"),
        (
            KEY_TIMEOUT,
            crate::MIN_REVEAL_WINDOW_NS - 1,
            "reveal_window must be between",
        ),
        (KEY_TIMEOUT, u64::MAX, "reveal_window must be between"),
        (
            KEY_TIMEOUT,
            crate::MAX_REVEAL_WINDOW_NS + 1,
            "reveal_window must be between",
        ),
    ] {
        env(&creator, ROUND_STORAGE_DEPOSIT, at);
        panics_with(message, || {
            contract.create_exit(exit(with(key_timeout, reveal_window)))
        });
    }
    env(&creator, ROUND_STORAGE_DEPOSIT, at);
    panics_with("closes_at must be at most 30 days ahead", || {
        contract.create_exit(exit(window(at + crate::MAX_ROUND_HORIZON_NS + 1)))
    });
    // The bounds themselves are accepted, the 60-second key timeout of the live
    // `cancel_no_key` proof included.
    for (key_timeout, reveal_window) in [
        (crate::MIN_KEY_TIMEOUT_NS, crate::MIN_REVEAL_WINDOW_NS),
        (crate::MAX_KEY_TIMEOUT_NS, crate::MAX_REVEAL_WINDOW_NS),
    ] {
        env(&creator, ROUND_STORAGE_DEPOSIT, at);
        let round = contract.create_exit(exit(with(key_timeout, reveal_window)));
        let view = contract.get_round(round).unwrap();
        assert_eq!(view.key_timeout, U64(key_timeout));
        assert_eq!(view.reveal_window, U64(reveal_window));
    }
    let long = {
        let stream = crate::unlock::StreamflowStream::new(crate::unlock::StreamflowParams {
            start_time: 1_000,
            period: 1_000_000,
            amount_per_period: 100,
            net_amount_deposited: 1_000,
            end_time: 10_001_000,
            ..crate::unlock::StreamflowParams::default()
        })
        .unwrap();
        env_at(&engine(), ts(100));
        contract.ensure_class(
            crate::types::Chain::Solana,
            "LongMint1111111111111111111111111111111111".into(),
            6,
            crate::unlock::ClassSchedule::from_streamflow(&stream),
        )
    };
    env(&creator, ROUND_STORAGE_DEPOSIT, at);
    contract.create_exit(ExitParams {
        class_id: long,
        ..exit(window(at + crate::MAX_ROUND_HORIZON_NS))
    });
    let limits = contract.get_limits();
    assert_eq!(limits.min_key_timeout, U64(60 * NS));
    assert_eq!(limits.max_key_timeout, U64(7 * 86_400 * NS));
    assert_eq!(limits.min_reveal_window, U64(300 * NS));
    assert_eq!(limits.max_reveal_window, U64(7 * 86_400 * NS));
    assert_eq!(limits.max_round_horizon, U64(30 * 86_400 * NS));
}
