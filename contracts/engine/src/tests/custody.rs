//! Foreign custody: bootstrap, attested deposits on Base and Solana, refusals and returns,
//! payouts with mocked MPC callbacks (success, mismatch, `PromiseError` refunds), replay
//! protection, in-kind redeems and the deposit checkpoint property.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};
use proptest::prelude::*;

use super::*;
use crate::custody::{
    BaseLogLocation, CashDepositedFields, ClaimSourceArgs, PayoutDebit, PayoutKind, PayoutStatus,
    RefusedAsset, ReplayKey, ReplayState, SolDepositArgs, SolDepositStage, SolNonceProof,
    StreamDepositedFields, PATH_VAULT_SOL, PAYOUT_STORAGE_DEPOSIT,
};
use crate::foreign::evm::{
    self, Eip712Domain, LogLocation, ReleaseAuthorization, StreamDeposited, TransferAuthorization,
    BASE_SEPOLIA_CHAIN_ID,
};
use crate::foreign::mpc::{
    payload_hash, AffinePoint, Bytes32, Bytes64, Ed25519Signature, EvmExtractor, EvmFinality,
    EvmRpcRequest, ExtractedValue, ForeignChainRpcRequest, Scalar, Secp256k1Signature,
    SignatureResponse, SvmAccount, SvmExtractor, SvmFinality, SvmRpcRequest,
    VerifyForeignTransactionResponse,
};
use crate::foreign::solana::{self as sol, SYSTEM_PROGRAM, TOKEN_PROGRAM};
use crate::math::ONE;
use crate::types::{Chain, Holder, PositionState, Venue};
use crate::unlock::{accrual, ClassSchedule, SablierLinearParams, SablierLinearStream};

const VAULT_BASE_KEY: &str =
    "secp256k1:4D8Exx2unEhfBkEa3EcjMKYrEUJgfMbecYd4nG9zE6T49hepuCvMrFEVofBWUVnFkYbjJs2MgaeD7hp72gLAjP65";
const VAULT_BASE: &str = "0x556e29bce7c6ab74a8b36b3c754d3ac2842223b5";
const VAULT_SOL: &str = "ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL";
const GAS_SOL: &str = "CBx96X3pThHzNJYjfXBKjdKktZxVApRaiNS8Ej6G7Qwz";
const RECIPIENT: &str = "0x00000000000000000000000000000000000000aa";
/// Block time of the Base fixtures (after the recorded deposit).
const BASE_NOW: u64 = 1_793_753_800;

/// Sets the context of a callback with several promise results.
fn env_with_results(timestamp: u64, results: Vec<PromiseResult>) {
    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .signer_account_id(engine())
        .predecessor_account_id(engine())
        .block_timestamp(timestamp)
        .block_height(timestamp / NS)
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build();
    testing_env!(
        context,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn json(value: &impl near_sdk::serde::Serialize) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(value).unwrap())
}

fn secp_signature() -> SignatureResponse {
    let mut big_r = [0x11u8; 33];
    big_r[0] = 0x02;
    let mut s = [0u8; 32];
    s[31] = 1;
    SignatureResponse::Secp256k1(Secp256k1Signature {
        big_r: AffinePoint {
            affine_point: big_r,
        },
        s: Scalar { scalar: s },
        recovery_id: 1,
    })
}

fn ed25519_signature(fill: u8) -> SignatureResponse {
    SignatureResponse::Ed25519 {
        signature: Ed25519Signature([fill; 64]),
    }
}

fn foreign_response(payload_hash: [u8; 32]) -> PromiseResult {
    json(&VerifyForeignTransactionResponse {
        payload_hash: Bytes32(payload_hash),
        signature: secp_signature(),
    })
}

fn bootstrapped() -> Contract {
    let mut contract = init();
    env_at(&accounts(5), ts(100));
    contract.bootstrap().detach();
    env_with_results(
        ts(105),
        vec![
            json(&VAULT_BASE_KEY),
            json(&format!("ed25519:{VAULT_SOL}")),
            json(&format!("ed25519:{GAS_SOL}")),
        ],
    );
    assert!(contract.on_bootstrap());
    contract
}

fn payout_env(caller: &AccountId, at: u64) {
    env(caller, PAYOUT_STORAGE_DEPOSIT, at);
}

/// The recorded `StreamDeposited` log of stream 82 (`tests/vectors/foreign/evm_vault_logs.json`).
fn base_location() -> BaseLogLocation {
    BaseLogLocation {
        tx_hash: "0xcddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2".into(),
        block_hash: "0x8015dd9257215c67ebf562e96e1b295aa8e9e41bdb6e726307d1cdc866230535".into(),
        block_number: 0x33a67b1,
        transaction_index: 2,
        log_index: 2,
    }
}

fn base_fields() -> StreamDepositedFields {
    StreamDepositedFields {
        sender: "0xfa76b8f304d2a87fcaee0c258a76118368d0d671".into(),
        stream_id: 82,
        near_account: accounts(1).to_string(),
        lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e".into(),
        token: "0x17e75069dd837eda977abedf7a455adda42868a9".into(),
        decimals: 18,
        deposited: U128(100_000_000_000_000_000_000_000),
        withdrawn: U128(0),
        start: 1778201663,
        cliff: 1809737663,
        end: 1872809663,
        granularity: 1,
        start_unlock: U128(0),
        cliff_unlock: U128(25_000_000_000_000_000_000_000),
        cancelable: false,
        transferable: true,
        timestamp: 1793753725,
    }
}

/// The payload hash the engine expects for a `StreamDeposited` log at `location`.
fn stream_hash(
    contract: &Contract,
    location: &BaseLogLocation,
    fields: &StreamDepositedFields,
) -> [u8; 32] {
    let event = StreamDeposited {
        sender: evm::parse_address(&fields.sender).unwrap(),
        stream_id: fields.stream_id,
        near_account: fields.near_account.clone(),
        lockup: evm::parse_address(&fields.lockup).unwrap(),
        token: evm::parse_address(&fields.token).unwrap(),
        decimals: fields.decimals,
        deposited: fields.deposited.0,
        withdrawn: fields.withdrawn.0,
        start: fields.start,
        cliff: fields.cliff,
        end: fields.end,
        granularity: fields.granularity,
        start_unlock: fields.start_unlock.0,
        cliff_unlock: fields.cliff_unlock.0,
        cancelable: fields.cancelable,
        transferable: fields.transferable,
        timestamp: fields.timestamp,
    };
    let tx_hash = crate::foreign::mpc::parse_hex_array(&location.tx_hash).unwrap();
    let log = event.evm_log(
        evm::parse_address(&contract.get_config().rose_vault).unwrap(),
        &LogLocation {
            transaction_hash: tx_hash,
            transaction_index: location.transaction_index,
            block_hash: crate::foreign::mpc::parse_hex_array(&location.block_hash).unwrap(),
            block_number: location.block_number,
            log_index: location.log_index,
        },
    );
    let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
        tx_id: Bytes32(tx_hash),
        extractors: vec![EvmExtractor::Log {
            log_index: location.log_index,
        }],
        finality: EvmFinality::Safe,
    });
    payload_hash(request, vec![ExtractedValue::log(log)])
}

fn base_key() -> ReplayKey {
    ReplayKey::BaseLog {
        tx_hash: "cddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2".into(),
        log_index: 2,
    }
}

fn registration_deposit(contract: &Contract, account: &AccountId) -> NearToken {
    let class = contract
        .compute_base_class_id(
            base_fields().token,
            18,
            crate::custody::SablierScheduleArgs {
                start: base_fields().start,
                cliff: base_fields().cliff,
                end: base_fields().end,
                granularity: 1,
                start_unlock: base_fields().start_unlock,
                cliff_unlock: base_fields().cliff_unlock,
                deposited: base_fields().deposited,
            },
        )
        .unwrap();
    NearToken::from_yoctonear(contract.registration_deposit_for(account.clone(), class).0)
}

/// Registers the recorded stream for `accounts(1)` and returns the class id.
fn register_base(contract: &mut Contract, fields: StreamDepositedFields) -> String {
    let deposit = registration_deposit(contract, &accounts(1));
    env(&accounts(5), deposit, ts(BASE_NOW));
    contract
        .register_base_deposit(base_location(), fields.clone())
        .detach();
    let hash = stream_hash(contract, &base_location(), &fields);
    env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
    assert!(contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        fields,
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    contract.get_position(U64(0)).unwrap().position.class_id
}

#[test]
fn bootstrap_stores_the_derived_addresses_once() {
    let mut contract = init();
    env_at(&accounts(5), ts(100));
    contract.bootstrap().detach();
    env_with_results(
        ts(105),
        vec![json(&VAULT_BASE_KEY), PromiseResult::Failed, json(&"x")],
    );
    assert!(!contract.on_bootstrap());
    assert!(contract.get_config().derived_addresses.is_none());

    let contract = bootstrapped();
    let derived = contract.get_config().derived_addresses.unwrap();
    assert_eq!(derived.vault_base, VAULT_BASE);
    assert_eq!(derived.vault_sol, VAULT_SOL);
    assert_eq!(derived.gas_sol, GAS_SOL);

    let mut contract = contract;
    env_at(&accounts(5), ts(200));
    panics_with("Already bootstrapped", || contract.bootstrap());
    env_with_results(ts(205), vec![json(&"secp256k1:x"), json(&"x"), json(&"x")]);
    assert!(contract.on_bootstrap(), "a late callback never rewrites");
    assert_eq!(
        contract.get_config().derived_addresses.unwrap().vault_base,
        VAULT_BASE
    );
}

#[test]
fn base_deposit_mints_the_allocation_once() {
    let mut contract = bootstrapped();
    let class = register_base(&mut contract, base_fields());
    let position = contract.get_position(U64(0)).unwrap().position;
    assert_eq!(position.allocation, base_fields().deposited);
    assert_eq!(position.depositor, accounts(1));
    assert_eq!(position.state, PositionState::Held);
    assert_eq!(
        contract.mt_balance_of(accounts(1), class.clone()).0,
        base_fields().deposited.0
    );
    let class_view = contract.get_class(class).unwrap();
    assert_eq!(class_view.chain, Chain::Base);
    assert_eq!(contract.get_replay(base_key()), Some(ReplayState::Consumed));
    assert!(events("rose")
        .iter()
        .any(|e| e["event"] == "deposit_registered"));

    env(
        &accounts(5),
        registration_deposit(&contract, &accounts(1)),
        ts(BASE_NOW + 100),
    );
    panics_with("Already registered", || {
        contract.register_base_deposit(base_location(), base_fields())
    });
}

#[test]
fn base_deposit_mismatch_and_failure_clear_the_key() {
    let mut contract = bootstrapped();
    let deposit = registration_deposit(&contract, &accounts(1));
    env(&accounts(5), deposit, ts(BASE_NOW));
    contract
        .register_base_deposit(base_location(), base_fields())
        .detach();
    assert!(matches!(
        contract.get_replay(base_key()),
        Some(ReplayState::Pending { .. })
    ));
    env(&accounts(5), deposit, ts(BASE_NOW + 1));
    panics_with("already in flight", || {
        contract.register_base_deposit(base_location(), base_fields())
    });

    let hash = stream_hash(&contract, &base_location(), &base_fields());
    env_with_results(ts(BASE_NOW + 7), vec![foreign_response([9u8; 32])]);
    assert!(!contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        base_fields(),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(contract.get_replay(base_key()), None);
    assert!(contract.get_position(U64(0)).is_none());
    assert_eq!(transferred_to(&accounts(5)), deposit.as_yoctonear());

    env(&accounts(5), deposit, ts(BASE_NOW + 10));
    contract
        .register_base_deposit(base_location(), base_fields())
        .detach();
    env_with_results(ts(BASE_NOW + 130), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        base_fields(),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(contract.get_replay(base_key()), None);
    let names: Vec<String> = events("rose")
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"deposit_mismatch".to_string()));
    assert!(names.contains(&"deposit_verification_failed".to_string()));
}

#[test]
fn refused_base_stream_is_recorded_and_returned_to_its_sender() {
    let mut contract = bootstrapped();
    let fields = StreamDepositedFields {
        cancelable: true,
        ..base_fields()
    };
    let deposit = registration_deposit(&contract, &accounts(1));
    env(&accounts(5), deposit, ts(BASE_NOW));
    contract
        .register_base_deposit(base_location(), fields.clone())
        .detach();
    let hash = stream_hash(&contract, &base_location(), &fields);
    env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
    assert!(!contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        fields.clone(),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(
        transferred_to(&accounts(5)),
        deposit.as_yoctonear(),
        "deposit returned"
    );
    assert_eq!(contract.get_replay(base_key()), Some(ReplayState::Consumed));
    assert!(contract.get_position(U64(0)).is_none());
    let refused = contract.get_refused_deposit(base_key()).unwrap();
    assert_eq!(refused.reason, "stream is cancelable");
    assert_eq!(refused.return_to, fields.sender);
    assert_eq!(
        refused.asset,
        RefusedAsset::BaseStream {
            lockup: fields.lockup.clone(),
            stream_id: 82
        }
    );

    payout_env(&accounts(3), ts(BASE_NOW + 20));
    contract.return_refused_deposit(base_key(), None).detach();
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::BaseRelease {
            lockup: fields.lockup.clone(),
            stream_id: 82,
            to: fields.sender.clone(),
        }
    );
    let expected = ReleaseAuthorization {
        lockup: evm::parse_address(&fields.lockup).unwrap(),
        stream_id: 82,
        to: evm::parse_address(&fields.sender).unwrap(),
        id: 0,
    }
    .digest(&Eip712Domain {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        verifying_contract: evm::parse_address(&contract.get_config().rose_vault).unwrap(),
    });
    assert_eq!(payout.digest, Some(hex::encode(expected)));
    assert_eq!(payout.debit, PayoutDebit::None);
    payout_env(&accounts(3), ts(BASE_NOW + 21));
    panics_with("already signed or in flight", || {
        contract.return_refused_deposit(base_key(), None)
    });

    env_with_results(ts(BASE_NOW + 25), vec![json(&secp_signature())]);
    assert!(contract.on_base_signed(U64(0)));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    let signature = payout.base.unwrap();
    assert_eq!(signature.v, 28);
    assert_eq!(signature.r, hex::encode([0x11u8; 32]));
    assert_eq!(
        contract
            .get_refused_deposit(base_key())
            .unwrap()
            .return_payout,
        Some(U64(0))
    );
}

#[test]
fn base_cash_is_credited_for_any_token_and_only_accepted_ones_host_rounds() {
    let mut contract = bootstrapped();
    let accepted = "0x036cbd53842c5426634e7929541ec2318f3dcf7e".to_string();
    let other = "0x00000000000000000000000000000000000000bb".to_string();
    for (log_index, token, amount) in [
        (2u64, accepted.clone(), 5 * USDC),
        (3, other.clone(), 7 * USDC),
    ] {
        let fields = CashDepositedFields {
            sender: "0xfa76b8f304d2a87fcaee0c258a76118368d0d671".into(),
            token: token.clone(),
            round_id: 42,
            near_account: accounts(1).to_string(),
            amount: U128(amount),
            timestamp: 1793753725,
        };
        let location = BaseLogLocation {
            log_index,
            ..base_location()
        };
        env_at(&accounts(5), ts(BASE_NOW));
        contract
            .register_base_cash(location.clone(), fields.clone())
            .detach();
        let key = ReplayKey::BaseLog {
            tx_hash: "cddf41ac9ba8c7b1a9053bc52e62c0edb4bbd4ab55752d817042aae34a35eeb2".into(),
            log_index,
        };
        let event = evm::CashDeposited {
            sender: evm::parse_address(&fields.sender).unwrap(),
            token: evm::parse_address(&token).unwrap(),
            round_id: 42,
            near_account: accounts(1).to_string(),
            amount,
            timestamp: 1793753725,
        };
        let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: Bytes32(crate::foreign::mpc::parse_hex_array(&location.tx_hash).unwrap()),
            extractors: vec![EvmExtractor::Log { log_index }],
            finality: EvmFinality::Safe,
        });
        let log = event.evm_log(
            evm::parse_address(&contract.get_config().rose_vault).unwrap(),
            &LogLocation {
                transaction_hash: crate::foreign::mpc::parse_hex_array(&location.tx_hash).unwrap(),
                transaction_index: 2,
                block_hash: crate::foreign::mpc::parse_hex_array(&location.block_hash).unwrap(),
                block_number: location.block_number,
                log_index,
            },
        );
        let hash = payload_hash(request, vec![ExtractedValue::log(log)]);
        env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
        assert!(contract.on_base_cash_verified(key, hex::encode(hash), fields));
    }
    let accepted_venue = Venue::Base {
        token: accepted.clone(),
    };
    let other_venue = Venue::Base {
        token: other.clone(),
    };
    assert_eq!(contract.cash_of(&accounts(1), &accepted_venue), 5 * USDC);
    assert_eq!(contract.cash_of(&accounts(1), &other_venue), 7 * USDC);
    let registered: Vec<bool> = events("rose")
        .iter()
        .filter(|e| e["event"] == "base_cash_registered")
        .map(|e| e["data"]["accepted"].as_bool().unwrap())
        .collect();
    assert_eq!(registered, vec![true, false]);

    let class = stepped_class(&mut contract, 6);
    env(&accounts(1), ROUND_STORAGE_DEPOSIT, ts(1_000));
    panics_with("venue", || {
        contract.create_exit(crate::rounds::ExitParams {
            class_id: class.clone(),
            venue: other_venue.clone(),
            max_price: U128(USDC),
            window: window(ts(2_000)),
        })
    });

    payout_env(&accounts(1), ts(1_000));
    contract
        .withdraw_base_cash(other.clone(), U128(7 * USDC), RECIPIENT.into())
        .detach();
    assert_eq!(contract.cash_of(&accounts(1), &other_venue), 0);
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::BaseTransfer {
            token: other.clone(),
            to: RECIPIENT.into(),
            amount: U128(7 * USDC)
        }
    );
    env_with_results(ts(1_005), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(0)));
    assert_eq!(contract.cash_of(&accounts(1), &other_venue), 7 * USDC);
    assert!(matches!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
}

/// A Base class whose stream started at 1,000 s and ends at 11,000 s, deposited with half
/// already withdrawn at 6,000 s.
fn midstream_fields() -> StreamDepositedFields {
    StreamDepositedFields {
        start: 1_000,
        cliff: 0,
        end: 11_000,
        granularity: 1,
        start_unlock: U128(0),
        cliff_unlock: U128(0),
        deposited: U128(1_000_000 * 1_000_000),
        withdrawn: U128(500_000 * 1_000_000),
        decimals: 6,
        timestamp: 6_000,
        ..base_fields()
    }
}

#[test]
fn claim_base_tokens_debits_then_signs_and_refunds_only_without_signature() {
    let mut contract = bootstrapped();
    let fields = midstream_fields();
    let deposit = registration_deposit(&contract, &accounts(1));
    env(&accounts(5), deposit, ts(6_010));
    contract
        .register_base_deposit(base_location(), fields.clone())
        .detach();
    let hash = stream_hash(&contract, &base_location(), &fields);
    env_with_results(ts(6_015), vec![foreign_response(hash)]);
    assert!(contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        fields.clone(),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    let class = contract.get_position(U64(0)).unwrap().position.class_id;
    let holding = contract.holding(&Holder::Account(accounts(1)), &class);
    assert!(
        holding.checkpoint >= ONE / 2,
        "the checkpoint covers the withdrawn half: {}",
        holding.checkpoint
    );

    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
    assert!(claimable > 0 && claimable <= 200_000 * 1_000_000);
    payout_env(&accounts(1), ts(8_000));
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(claimable),
            RECIPIENT.into(),
        )
        .detach();
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 0);
    let payout = contract.get_payout(U64(0)).unwrap();
    let expected = TransferAuthorization {
        token: evm::parse_address(&fields.token).unwrap(),
        to: evm::parse_address(RECIPIENT).unwrap(),
        amount: claimable,
        id: 0,
    }
    .digest(&Eip712Domain {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        verifying_contract: evm::parse_address(&contract.get_config().rose_vault).unwrap(),
    });
    assert_eq!(payout.digest, Some(hex::encode(expected)));
    assert_eq!(payout.status, PayoutStatus::Requested);

    payout_env(&accounts(1), ts(8_001));
    panics_with("not enough claimable", || {
        contract.claim_base_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(claimable),
            RECIPIENT.into(),
        )
    });

    env_with_results(ts(8_005), vec![json(&secp_signature())]);
    assert!(contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Signed
    );

    env_at(&accounts(1), ts(9_000));
    let later = contract.get_claimable(accounts(1), class.clone()).0;
    assert!(later > 0);
    payout_env(&accounts(1), ts(9_000));
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(later),
            RECIPIENT.into(),
        )
        .detach();
    assert_eq!(
        contract.get_payout(U64(1)).unwrap().id,
        U64(1),
        "ids are a single counter"
    );
    env_with_results(ts(9_005), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(1)));
    assert_eq!(
        contract.get_claimable(accounts(1), class.clone()).0,
        later + 500_000_000,
        "refunded, plus five more seconds of accrual"
    );
    assert_eq!(contract.get_payouts(accounts(1), None, None).len(), 2);

    payout_env(&accounts(1), ts(9_010));
    panics_with("zero address", || {
        contract.claim_base_tokens(
            ClaimSourceArgs::Holding { class_id: class },
            U128(1),
            "0x0000000000000000000000000000000000000000".into(),
        )
    });
}

#[test]
fn redeem_burns_exactly_the_allocation_and_refuses_locked_units() {
    let mut contract = bootstrapped();
    let class = register_base(&mut contract, base_fields());
    let allocation = base_fields().deposited.0;
    register(&mut contract, &accounts(2), ts(BASE_NOW + 10));
    env(&accounts(1), one_yocto(), ts(BASE_NOW + 10));
    contract.mt_transfer(accounts(2), class.clone(), U128(1), None, None);
    payout_env(&accounts(1), ts(BASE_NOW + 11));
    panics_with("not enough units", || {
        contract.redeem(U64(0), RECIPIENT.into(), None, None)
    });
    env(&accounts(2), one_yocto(), ts(BASE_NOW + 12));
    contract.mt_transfer(accounts(1), class.clone(), U128(1), None, None);

    fund(&mut contract, &accounts(1), 10 * USDC, ts(BASE_NOW + 12));
    let round = create_exit(
        &mut contract,
        &accounts(3),
        &class,
        USDC,
        ts(BASE_NOW + 13),
        ts(BASE_NOW + 1_000),
    );
    place_ask(
        &mut contract,
        round,
        &accounts(1),
        1,
        1,
        1,
        ts(BASE_NOW + 14),
    );
    payout_env(&accounts(1), ts(BASE_NOW + 15));
    panics_with("not enough units", || {
        contract.redeem(U64(0), RECIPIENT.into(), None, None)
    });
    env_at(&accounts(3), ts(BASE_NOW + 1_000 + KEY_TIMEOUT / NS));
    contract.cancel_no_key(U64(round));
    settle(
        &mut contract,
        round,
        0,
        ts(BASE_NOW + 1_001 + KEY_TIMEOUT / NS),
    );
    assert_eq!(
        contract.mt_balance_of(accounts(1), class.clone()).0,
        allocation
    );

    payout_env(&accounts(1), ts(BASE_NOW + 20));
    contract
        .redeem(U64(0), RECIPIENT.into(), None, None)
        .detach();
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 0);
    assert_eq!(contract.mt_supply(class.clone()).unwrap().0, 0);
    assert_eq!(contract.get_pending_release(U64(0)), Some(U64(0)));
    payout_env(&accounts(1), ts(BASE_NOW + 21));
    panics_with("in flight", || {
        contract.redeem(U64(0), RECIPIENT.into(), None, None)
    });

    env_with_results(ts(BASE_NOW + 25), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.mt_balance_of(accounts(1), class.clone()).0,
        allocation
    );
    assert_eq!(contract.get_pending_release(U64(0)), None);
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Held
    );

    payout_env(&accounts(1), ts(BASE_NOW + 30));
    contract
        .redeem(U64(0), RECIPIENT.into(), None, None)
        .detach();
    let payout = contract.get_payout(U64(1)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::BaseRelease {
            lockup: base_fields().lockup,
            stream_id: 82,
            to: RECIPIENT.into()
        }
    );
    env_with_results(ts(BASE_NOW + 35), vec![json(&secp_signature())]);
    assert!(contract.on_base_signed(U64(1)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
    assert_eq!(contract.mt_balance_of(accounts(1), class), 0.into());
    payout_env(&accounts(1), ts(BASE_NOW + 40));
    panics_with("already released", || {
        contract.redeem(U64(0), RECIPIENT.into(), None, None)
    });
}

/// Streamflow metadata bytes with the given fields (every flag zero unless set).
struct StreamSpec {
    recipient: [u8; 32],
    mint: [u8; 32],
    start_time: u64,
    period: u64,
    amount_per_period: u64,
    net_amount_deposited: u64,
    end_time: u64,
    amount_withdrawn: u64,
    can_topup: bool,
}

fn stream_bytes(spec: &StreamSpec) -> Vec<u8> {
    let mut data = vec![0u8; 1104];
    let put = |data: &mut Vec<u8>, offset: usize, value: u64| {
        data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    };
    put(&mut data, 17, spec.amount_withdrawn);
    put(&mut data, 33, spec.end_time);
    data[49..81].copy_from_slice(&[5u8; 32]);
    data[113..145].copy_from_slice(&spec.recipient);
    data[145..177]
        .copy_from_slice(&sol::associated_token_address(&spec.recipient, &spec.mint).unwrap());
    data[177..209].copy_from_slice(&spec.mint);
    data[209..241].copy_from_slice(&[6u8; 32]);
    data[325..357].copy_from_slice(&[8u8; 32]);
    put(&mut data, 409, spec.start_time);
    put(&mut data, 417, spec.net_amount_deposited);
    put(&mut data, 425, spec.period);
    put(&mut data, 433, spec.amount_per_period);
    data[462] = u8::from(spec.can_topup);
    data
}

fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

const DEPOSIT_KEY: [u8; 32] = [7u8; 32];
const MINT: [u8; 32] = [9u8; 32];
const STREAM: [u8; 32] = [3u8; 32];
const RETURN_TO: [u8; 32] = [4u8; 32];

fn anchor() -> String {
    bs58::encode([5u8; 64]).into_string()
}

fn sol_spec(recipient: [u8; 32]) -> StreamSpec {
    StreamSpec {
        recipient,
        mint: MINT,
        start_time: 1_000,
        period: 1_000,
        amount_per_period: 100,
        net_amount_deposited: 1_000,
        end_time: 11_000,
        amount_withdrawn: 0,
        can_topup: false,
    }
}

fn sol_account(owner: [u8; 32], data: Vec<u8>) -> SvmAccount {
    SvmAccount {
        owner: Bytes32(owner),
        data,
    }
}

fn sol_hash(anchor: &str, accounts: Vec<([u8; 32], SvmAccount)>) -> [u8; 32] {
    let mut anchor_bytes = [0u8; 64];
    bs58::decode(anchor).onto(&mut anchor_bytes).unwrap();
    let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
        tx_id: Bytes64(anchor_bytes),
        finality: SvmFinality::Finalized,
        extractors: accounts
            .iter()
            .map(|(pubkey, _)| SvmExtractor::AccountState {
                pubkey: Bytes32(*pubkey),
            })
            .collect(),
    });
    payload_hash(
        request,
        accounts
            .into_iter()
            .map(|(_, account)| ExtractedValue::account(account))
            .collect(),
    )
}

fn streamflow_program() -> [u8; 32] {
    sol::parse_pubkey("HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ").unwrap()
}

/// Attributes the test stream at the deposit address of `accounts(1)`; returns the class id.
fn attribute(contract: &mut Contract, spec: &StreamSpec) -> (String, SolDepositArgs) {
    env_at(&engine(), ts(100));
    let class = contract.ensure_class(
        Chain::Solana,
        sol::format_pubkey(&MINT),
        6,
        stepped_schedule(),
    );
    assert_eq!(
        contract
            .compute_sol_class_id(
                sol::format_pubkey(&MINT),
                6,
                crate::custody::StreamflowScheduleArgs {
                    start_time: spec.start_time,
                    cliff: 0,
                    cliff_amount: 0,
                    period: spec.period,
                    amount_per_period: spec.amount_per_period,
                    net_amount_deposited: spec.net_amount_deposited,
                    end_time: spec.end_time,
                },
            )
            .unwrap(),
        class
    );
    let args = SolDepositArgs {
        metadata: sol::format_pubkey(&STREAM),
        class_id: class.clone(),
        return_to: sol::format_pubkey(&RETURN_TO),
        anchor_tx: anchor(),
        metadata_data: hex::encode(stream_bytes(spec)),
        mint_data: hex::encode(mint_bytes(6)),
    };
    env_at(&accounts(1), ts(2_000));
    contract.attribute_sol_deposit(args.clone()).detach();
    let path = contract.deposit_path_of(accounts(1), args.class_id.clone());
    env_with_results(
        ts(2_001),
        vec![json(&format!(
            "ed25519:{}",
            sol::format_pubkey(&DEPOSIT_KEY)
        ))],
    );
    drop(contract.on_sol_deposit_key(args.clone(), accounts(1), path.clone()));
    let hash = sol_hash(
        &anchor(),
        vec![
            (
                STREAM,
                sol_account(streamflow_program(), stream_bytes(spec)),
            ),
            (MINT, sol_account(TOKEN_PROGRAM, mint_bytes(6))),
        ],
    );
    env_with_results(ts(2_008), vec![foreign_response(hash)]);
    contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path,
        sol::format_pubkey(&DEPOSIT_KEY),
        hex::encode(hash),
    );
    (class, args)
}

fn stream_key() -> ReplayKey {
    ReplayKey::SolStream {
        metadata: sol::format_pubkey(&STREAM),
    }
}

#[test]
fn solana_deposit_is_attributed_moved_and_registered() {
    let mut contract = bootstrapped();
    let (class, args) = attribute(&mut contract, &sol_spec(DEPOSIT_KEY));
    let record = contract.get_sol_deposit(args.metadata.clone()).unwrap();
    assert_eq!(record.stage, SolDepositStage::Attributed);
    assert_eq!(record.account, accounts(1));
    assert_eq!(record.class_id, class);
    assert_eq!(record.deposit_address, sol::format_pubkey(&DEPOSIT_KEY));
    assert_eq!(
        record.path,
        format!("dep/{}/{}", accounts(1), args.class_id)
    );

    payout_env(&accounts(5), ts(2_010));
    contract
        .move_sol_deposit(args.metadata.clone(), sol::format_pubkey(&[1u8; 32]))
        .detach();
    let payout = contract.get_payout(U64(0)).unwrap();
    let solana = payout.solana.clone().unwrap();
    assert_eq!(solana.authority_path, record.path);
    assert!(solana.nonce_account.is_none());
    let message = hex::decode(&solana.message).unwrap();
    assert_eq!(message[0], 2, "fee payer and deposit key sign");
    assert_eq!(&message[4..36], &sol::parse_pubkey(GAS_SOL).unwrap());
    env_with_results(
        ts(2_015),
        vec![
            json(&ed25519_signature(0xaa)),
            json(&ed25519_signature(0xbb)),
        ],
    );
    assert!(contract.on_sol_signed(U64(0)));
    let solana = contract.get_payout(U64(0)).unwrap().solana.unwrap();
    let transaction = hex::decode(solana.transaction.unwrap()).unwrap();
    assert_eq!(transaction[0], 2);
    assert_eq!(&transaction[1..65], &[0xbbu8; 64], "gas/sol signs first");
    assert_eq!(&transaction[65..129], &[0xaau8; 64]);
    assert_eq!(&transaction[129..], &message[..]);
    assert!(matches!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::MoveSigned { .. }
    ));

    let vault = sol::parse_pubkey(VAULT_SOL).unwrap();
    let at_vault = StreamSpec {
        amount_withdrawn: 200,
        ..sol_spec(vault)
    };
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), class.clone())
            .0,
    );
    env(&accounts(5), deposit, ts(4_000));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(&at_vault)),
        )
        .detach();
    assert!(matches!(
        contract.get_replay(stream_key()),
        Some(ReplayState::Pending { .. })
    ));
    let hash = sol_hash(
        &anchor(),
        vec![(
            STREAM,
            sol_account(streamflow_program(), stream_bytes(&at_vault)),
        )],
    );
    env_with_results(ts(4_007), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(),
        hex::encode(hash),
        hex::encode(stream_bytes(&at_vault)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(
        contract.get_replay(stream_key()),
        Some(ReplayState::Consumed)
    );
    let position = contract.get_position(U64(0)).unwrap().position;
    assert_eq!(position.allocation.0, 1_000);
    assert_eq!(position.class_id, class);
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 1_000);
    let holding = contract.holding(&Holder::Account(accounts(1)), &class);
    assert_eq!(holding.checkpoint, 3 * ONE / 10, "accrued to f(4,000 s)");
    assert_eq!(
        holding.claimable, 100,
        "unlocked 300 at 4,000 s minus the 200 withdrawn"
    );
    let registered = events("rose")
        .into_iter()
        .find(|e| e["event"] == "deposit_registered")
        .unwrap();
    assert_eq!(
        registered["data"]["checkpoint"],
        (ONE / 5).to_string(),
        "200 of 1,000 withdrawn"
    );
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_eq!(stream.mint, sol::format_pubkey(&MINT));
    assert_eq!(stream.escrow_tokens, sol::format_pubkey(&[6u8; 32]));
    assert!(matches!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::Registered { .. }
    ));

    payout_env(&accounts(5), ts(4_010));
    panics_with("not awaiting registration", || {
        contract.register_sol_deposit(args.metadata.clone(), anchor(), String::new())
    });

    payout_env(&accounts(5), ts(4_020));
    contract
        .withdraw_sol_stream(U64(0), sol::format_pubkey(&[1u8; 32]))
        .detach();
    let payout = contract.get_payout(U64(1)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolWithdraw {
            metadata: args.metadata.clone()
        }
    );
    assert_eq!(payout.solana.unwrap().authority_path, PATH_VAULT_SOL);
}

#[test]
fn solana_stream_refused_at_the_deposit_address_is_returnable() {
    let mut contract = bootstrapped();
    let spec = StreamSpec {
        can_topup: true,
        ..sol_spec(DEPOSIT_KEY)
    };
    let (_, args) = attribute(&mut contract, &spec);
    assert_eq!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::Refused
    );
    let refused = contract.get_refused_deposit(stream_key()).unwrap();
    assert_eq!(refused.reason, "CanTopup");
    assert_eq!(refused.return_to, sol::format_pubkey(&RETURN_TO));
    let RefusedAsset::SolStream {
        held_by,
        held_by_path,
        ..
    } = &refused.asset
    else {
        panic!("a Solana stream");
    };
    assert_eq!(held_by, &sol::format_pubkey(&DEPOSIT_KEY));
    assert_eq!(
        held_by_path,
        &format!("dep/{}/{}", accounts(1), args.class_id)
    );

    payout_env(&accounts(5), ts(2_020));
    panics_with("recent blockhash is required", || {
        contract.return_refused_deposit(stream_key(), None)
    });
    payout_env(&accounts(5), ts(2_021));
    contract
        .return_refused_deposit(stream_key(), Some(sol::format_pubkey(&[1u8; 32])))
        .detach();
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolReturn {
            metadata: args.metadata.clone(),
            from: sol::format_pubkey(&DEPOSIT_KEY),
            to_owner: sol::format_pubkey(&RETURN_TO),
        }
    );
    assert_eq!(payout.solana.unwrap().authority_path, held_by_path.clone());
    payout_env(&accounts(5), ts(2_022));
    panics_with("not awaiting its move", || {
        contract.move_sol_deposit(args.metadata.clone(), sol::format_pubkey(&[1u8; 32]))
    });
}

fn nonce_bytes(authority: [u8; 32], value: [u8; 32]) -> Vec<u8> {
    let mut data = vec![0u8; 80];
    data[0] = 1;
    data[4] = 1;
    data[8..40].copy_from_slice(&authority);
    data[40..72].copy_from_slice(&value);
    data[72..80].copy_from_slice(&5_000u64.to_le_bytes());
    data
}

const NONCE_ACCOUNT: [u8; 32] = [12u8; 32];
const NONCE_VALUE: [u8; 32] = [13u8; 32];

fn nonce_proof(authority: [u8; 32]) -> SolNonceProof {
    SolNonceProof {
        account: sol::format_pubkey(&NONCE_ACCOUNT),
        anchor_tx: anchor(),
        data: hex::encode(nonce_bytes(authority, NONCE_VALUE)),
    }
}

fn nonce_key() -> ReplayKey {
    ReplayKey::SolNonce {
        account: sol::format_pubkey(&NONCE_ACCOUNT),
        value: sol::format_pubkey(&NONCE_VALUE),
    }
}

/// A Solana class with 1,000 units minted to `accounts(1)` at `f = 0`.
fn solana_holder() -> (Contract, String) {
    let mut contract = bootstrapped();
    let class = contract.ensure_class(
        Chain::Solana,
        sol::format_pubkey(&MINT),
        6,
        stepped_schedule(),
    );
    register(&mut contract, &accounts(1), ts(500));
    mint(&mut contract, &class, &accounts(1), 1_000, ts(500));
    (contract, class)
}

#[test]
fn claim_sol_tokens_proves_the_nonce_then_signs_and_completes_a_missing_gas_signature() {
    let (mut contract, class) = solana_holder();
    let vault = sol::parse_pubkey(VAULT_SOL).unwrap();
    env_at(&accounts(1), ts(4_000));
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 300);

    payout_env(&accounts(1), ts(4_000));
    panics_with("Invalid nonce account", || {
        contract.claim_sol_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(300),
            sol::format_pubkey(&RETURN_TO),
            nonce_proof([1u8; 32]),
        )
    });
    payout_env(&accounts(1), ts(4_000));
    contract
        .claim_sol_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(300),
            sol::format_pubkey(&RETURN_TO),
            nonce_proof(vault),
        )
        .detach();
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 0);
    assert!(matches!(
        contract.get_replay(nonce_key()),
        Some(ReplayState::Pending { .. })
    ));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolTransfer {
            mint: sol::format_pubkey(&MINT),
            to_owner: sol::format_pubkey(&RETURN_TO),
            amount: U128(300)
        }
    );
    let solana = payout.solana.unwrap();
    assert_eq!(
        solana.nonce_account,
        Some(sol::format_pubkey(&NONCE_ACCOUNT))
    );
    assert_eq!(solana.nonce_value, Some(sol::format_pubkey(&NONCE_VALUE)));
    let message = hex::decode(&solana.message).unwrap();
    let keys = usize::from(message[3]);
    assert_eq!(
        &message[4 + 32 * keys..4 + 32 * keys + 32],
        &NONCE_VALUE,
        "durable nonce as blockhash"
    );

    let hash = sol_hash(
        &anchor(),
        vec![(
            NONCE_ACCOUNT,
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault, NONCE_VALUE)),
        )],
    );
    env_with_results(ts(4_007), vec![foreign_response(hash)]);
    assert!(matches!(
        contract.on_sol_nonce_verified(U64(0), hex::encode(hash), nonce_key()),
        near_sdk::PromiseOrValue::Promise(_)
    ));
    assert_eq!(
        contract.get_replay(nonce_key()),
        Some(ReplayState::Consumed)
    );

    env_with_results(
        ts(4_012),
        vec![json(&ed25519_signature(0xaa)), PromiseResult::Failed],
    );
    assert!(!contract.on_sol_signed(U64(0)));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::AwaitingGasSignature);
    assert!(payout.solana.as_ref().unwrap().transaction.is_none());
    assert_eq!(
        contract.get_claimable(accounts(1), class.clone()).0,
        0,
        "never refunded"
    );

    env_at(&accounts(5), ts(4_020));
    contract.resign_sol_gas(U64(0)).detach();
    env_with_results(ts(4_025), vec![json(&ed25519_signature(0xbb))]);
    assert!(contract.on_sol_gas_resigned(U64(0)));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    let transaction = hex::decode(payout.solana.unwrap().transaction.unwrap()).unwrap();
    assert_eq!(&transaction[1..65], &[0xbbu8; 64]);
    assert_eq!(&transaction[65..129], &[0xaau8; 64]);

    env_at(&accounts(1), ts(6_000));
    let more = contract.get_claimable(accounts(1), class.clone()).0;
    assert_eq!(more, 200);
    payout_env(&accounts(1), ts(6_000));
    panics_with("Already registered", || {
        contract.claim_sol_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(more),
            sol::format_pubkey(&RETURN_TO),
            nonce_proof(vault),
        )
    });
}

#[test]
fn solana_payout_refunds_on_nonce_mismatch_and_on_a_missing_authority_signature() {
    let (mut contract, class) = solana_holder();
    let vault = sol::parse_pubkey(VAULT_SOL).unwrap();
    payout_env(&accounts(1), ts(4_000));
    contract
        .claim_sol_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(300),
            sol::format_pubkey(&RETURN_TO),
            nonce_proof(vault),
        )
        .detach();
    env_with_results(ts(4_007), vec![foreign_response([1u8; 32])]);
    assert!(matches!(
        contract.on_sol_nonce_verified(U64(0), hex::encode([2u8; 32]), nonce_key()),
        near_sdk::PromiseOrValue::Value(false)
    ));
    assert_eq!(contract.get_replay(nonce_key()), None);
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 300);
    assert!(matches!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));

    payout_env(&accounts(1), ts(4_100));
    contract
        .claim_sol_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(300),
            sol::format_pubkey(&RETURN_TO),
            nonce_proof(vault),
        )
        .detach();
    let hash = sol_hash(
        &anchor(),
        vec![(
            NONCE_ACCOUNT,
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault, NONCE_VALUE)),
        )],
    );
    env_with_results(ts(4_107), vec![foreign_response(hash)]);
    drop(contract.on_sol_nonce_verified(U64(1), hex::encode(hash), nonce_key()));
    env_with_results(
        ts(4_112),
        vec![PromiseResult::Failed, json(&ed25519_signature(0xbb))],
    );
    assert!(!contract.on_sol_signed(U64(1)));
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 300);
    assert_eq!(
        contract.get_replay(nonce_key()),
        None,
        "the nonce value is free again"
    );
}

#[test]
fn solana_redeem_requires_the_withdrawn_stream_and_burns_the_allocation() {
    let mut contract = bootstrapped();
    let (class, args) = attribute(&mut contract, &sol_spec(DEPOSIT_KEY));
    let vault = sol::parse_pubkey(VAULT_SOL).unwrap();
    let at_vault = sol_spec(vault);
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), class.clone())
            .0,
    );
    env(&accounts(5), deposit, ts(500));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(&at_vault)),
        )
        .detach();
    let hash = sol_hash(
        &anchor(),
        vec![(
            STREAM,
            sol_account(streamflow_program(), stream_bytes(&at_vault)),
        )],
    );
    env_with_results(ts(507), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(),
        hex::encode(hash),
        hex::encode(stream_bytes(&at_vault)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));

    payout_env(&accounts(1), ts(4_000));
    panics_with("Withdraw the stream", || {
        contract.redeem(
            U64(0),
            sol::format_pubkey(&RETURN_TO),
            Some(nonce_proof(vault)),
            Some(hex::encode(stream_bytes(&at_vault))),
        )
    });
    let withdrawn = StreamSpec {
        amount_withdrawn: 300,
        ..sol_spec(vault)
    };
    payout_env(&accounts(1), ts(4_000));
    contract
        .redeem(
            U64(0),
            sol::format_pubkey(&RETURN_TO),
            Some(nonce_proof(vault)),
            Some(hex::encode(stream_bytes(&withdrawn))),
        )
        .detach();
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 0);
    assert_eq!(contract.get_claimable(accounts(1), class.clone()).0, 300);
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolRelease {
            metadata: args.metadata.clone(),
            to_owner: sol::format_pubkey(&RETURN_TO)
        }
    );
    let hash = sol_hash(
        &anchor(),
        vec![
            (
                NONCE_ACCOUNT,
                sol_account(SYSTEM_PROGRAM, nonce_bytes(vault, NONCE_VALUE)),
            ),
            (
                STREAM,
                sol_account(streamflow_program(), stream_bytes(&withdrawn)),
            ),
        ],
    );
    env_with_results(ts(4_007), vec![foreign_response(hash)]);
    drop(contract.on_sol_nonce_verified(U64(0), hex::encode(hash), nonce_key()));
    env_with_results(
        ts(4_012),
        vec![
            json(&ed25519_signature(0xaa)),
            json(&ed25519_signature(0xbb)),
        ],
    );
    assert!(contract.on_sol_signed(U64(0)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
    assert_eq!(contract.mt_supply(class).unwrap().0, 0);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    /// Units minted for a deposit never claim more over their life than what the stream will
    /// still pay the vault: `allocation * (ONE - checkpoint) / ONE <= deposited - withdrawn`.
    #[test]
    fn deposit_checkpoint_bounds_the_lifetime_claim(
        decimals in 0u8..=18,
        whole_tokens in 1u128..1_000_000,
        dust in 0u128..1_000_000,
        start in 1_000u64..1_000_000,
        span in 1u64..100_000_000,
        cliff_offset in 0u64..1_000,
        granularity_pick in 1u64..1_000,
        start_unlock_pct in 0u64..30,
        cliff_unlock_pct in 0u64..30,
        deposit_offset in 0u64..100_000_000,
        delay in 0u64..100_000,
    ) {
        let unit = 10u128.pow(u32::from(decimals));
        let deposited = whole_tokens * unit + dust % unit;
        let cliff = if cliff_offset == 0 { 0 } else { start + cliff_offset };
        let base = if cliff == 0 { start } else { cliff };
        let end = base + span;
        let params = SablierLinearParams {
            start,
            cliff,
            end,
            granularity: (span / granularity_pick).max(1),
            start_unlock: deposited * u128::from(start_unlock_pct) / 100,
            cliff_unlock: if cliff == 0 { 0 } else { deposited * u128::from(cliff_unlock_pct) / 100 },
            deposited,
        };
        let stream = SablierLinearStream::new(params).unwrap();
        let schedule = ClassSchedule::from_sablier(&stream, decimals).unwrap();
        let deposit_time = start.saturating_sub(10) + deposit_offset;
        let withdrawn = stream.streamed_amount(deposit_time);
        prop_assume!(withdrawn < deposited);
        let now = deposit_time + delay;
        let f_now = schedule.fraction(now);
        let (units, checkpoint) = crate::custody::deposit_units_of(
            &schedule,
            f_now,
            Some(deposit_time),
            withdrawn,
            deposited,
        );
        let lifetime_claim = accrual(units, checkpoint, ONE);
        prop_assert!(lifetime_claim <= deposited - withdrawn,
            "claim {lifetime_claim} exceeds {} (units {units}, checkpoint {checkpoint})", deposited - withdrawn);
        prop_assert!(units <= deposited);
        prop_assert!(checkpoint >= schedule.fraction(deposit_time).min(f_now));
        prop_assert!(checkpoint <= f_now);
        let paid = crate::math::mul_div_ceil(ONE, withdrawn, deposited).unwrap();
        if paid <= f_now {
            prop_assert_eq!(units, deposited, "the full allocation when the class fraction covers the withdrawn part");
        } else if units < deposited {
            prop_assert!(accrual(units + 1, checkpoint, ONE) > deposited - withdrawn,
                "the largest unit count keeping the bound");
        }
    }
}
