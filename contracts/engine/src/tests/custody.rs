//! Foreign custody on Base and the helpers shared with the Solana tests: bootstrap, attested
//! deposits, refusals and returns, payouts with mocked MPC callbacks signed by deterministic test
//! keys (success, `PromiseError` refunds, unreadable responses, recovery submissions, retries),
//! replay protection, in-kind redeems, storage attachments and the deposit checkpoint property.

use k256::ecdsa::SigningKey as EcdsaKey;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};
use proptest::prelude::*;

use super::*;
use crate::custody::{
    BaseLogLocation, CashDepositedFields, ClaimSourceArgs, PayoutDebit, PayoutKind, PayoutStatus,
    RefusedAsset, ReplayKey, ReplayState, StreamDepositedFields, PAYOUT_STORAGE_DEPOSIT,
    RECORD_STORAGE_DEPOSIT,
};
use crate::foreign::evm::{
    self, Eip712Domain, LogLocation, ReleaseAuthorization, StreamDeposited, TransferAuthorization,
    BASE_SEPOLIA_CHAIN_ID, SECP256K1_N,
};
use crate::foreign::mpc::{
    payload_hash, AffinePoint, Bytes32, Ed25519Signature, EvmExtractor, EvmFinality, EvmRpcRequest,
    ExtractedValue, ForeignChainRpcRequest, Scalar, Secp256k1Signature, SignatureResponse,
    VerifyForeignTransactionResponse,
};
use crate::foreign::solana as sol;
use crate::math::ONE;
use crate::types::{Chain, Holder, PositionState, Venue};
use crate::unlock::{accrual, ClassSchedule, SablierLinearParams, SablierLinearStream};

pub(super) const RECIPIENT: &str = "0x00000000000000000000000000000000000000aa";
/// Block time of the Base fixtures (after the recorded deposit).
const BASE_NOW: u64 = 1_793_753_800;

/// The test key standing in for the MPC-derived `vault/base` key.
pub(super) fn vault_base_signer() -> EcdsaKey {
    EcdsaKey::from_bytes(&[0x42u8; 32].into()).unwrap()
}

/// `vault/base` as `derived_public_key` renders it.
fn vault_base_key() -> String {
    let point = vault_base_signer().verifying_key().to_encoded_point(false);
    format!(
        "secp256k1:{}",
        bs58::encode(&point.as_bytes()[1..]).into_string()
    )
}

/// The Base vault address of the test key.
pub(super) fn vault_base() -> String {
    evm::format_address(&evm::address_from_near_public_key(&vault_base_key()).unwrap())
}

/// An Ed25519 test key standing in for an MPC-derived Solana key.
pub(super) fn ed_key(seed: u8) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
}

pub(super) fn vault_sol_key() -> ed25519_dalek::SigningKey {
    ed_key(0x51)
}

pub(super) fn gas_sol_key() -> ed25519_dalek::SigningKey {
    ed_key(0x52)
}

pub(super) fn deposit_key() -> ed25519_dalek::SigningKey {
    ed_key(0x53)
}

pub(super) fn pubkey_of(key: &ed25519_dalek::SigningKey) -> [u8; 32] {
    key.verifying_key().to_bytes()
}

pub(super) fn vault_sol() -> String {
    sol::format_pubkey(&pubkey_of(&vault_sol_key()))
}

pub(super) fn gas_sol() -> String {
    sol::format_pubkey(&pubkey_of(&gas_sol_key()))
}

/// Sets the context of a callback with several promise results.
pub(super) fn env_with_results(timestamp: u64, results: Vec<PromiseResult>) {
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

pub(super) fn json(value: &impl near_sdk::serde::Serialize) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(value).unwrap())
}

/// A well-formed secp256k1 response, used where the engine ignores the signature (ForeignTx
/// attestations, which the MPC contract verifies itself).
pub(super) fn secp_signature() -> SignatureResponse {
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

/// The MPC response of `key` signing `message`.
pub(super) fn ed_signature(key: &ed25519_dalek::SigningKey, message: &[u8]) -> PromiseResult {
    use ed25519_dalek::Signer;
    json(&SignatureResponse::Ed25519 {
        signature: Ed25519Signature(key.sign(message).to_bytes()),
    })
}

/// The MPC response of `vault/base` signing the stored digest of payout `id`, as the live
/// contract returns it (low `s`, recovery id, `big_r` compressed).
pub(super) fn base_signature(contract: &Contract, id: u64) -> SignatureResponse {
    let digest = hex::decode(contract.get_payout(U64(id)).unwrap().digest.unwrap()).unwrap();
    let (signature, recovery) = vault_base_signer()
        .sign_prehash_recoverable(&digest)
        .unwrap();
    let bytes = signature.to_bytes();
    let mut big_r = [0u8; 33];
    big_r[0] = 0x02 | u8::from(recovery.is_y_odd());
    big_r[1..].copy_from_slice(&bytes[..32]);
    SignatureResponse::Secp256k1(Secp256k1Signature {
        big_r: AffinePoint {
            affine_point: big_r,
        },
        s: Scalar {
            scalar: bytes[32..].try_into().unwrap(),
        },
        recovery_id: recovery.to_byte(),
    })
}

pub(super) fn foreign_response(payload_hash: [u8; 32]) -> PromiseResult {
    json(&VerifyForeignTransactionResponse {
        payload_hash: Bytes32(payload_hash),
        signature: secp_signature(),
    })
}

pub(super) fn bootstrapped() -> Contract {
    let mut contract = init();
    env_at(&accounts(5), ts(100));
    contract.bootstrap().detach();
    env_with_results(
        ts(105),
        vec![
            json(&vault_base_key()),
            json(&format!("ed25519:{}", vault_sol())),
            json(&format!("ed25519:{}", gas_sol())),
        ],
    );
    assert!(contract.on_bootstrap());
    contract
}

/// Bytes of one trie record with a `key` and a `value` (NEAR charges 40 bytes per record).
pub(super) fn record_bytes(key: usize, value: usize) -> u64 {
    (key + value + 40) as u64
}

/// Bytes of a value as borsh stores it.
pub(super) fn borsh_len(value: &impl borsh::BorshSerialize) -> usize {
    borsh::to_vec(value).unwrap().len()
}

/// Bytes a payout record occupies: its entry in the payout map (one-byte prefix, `u64` id), its
/// entry in its requester's payout list, a new list for a first payout, and the requester's
/// hold while it is in flight.
pub(super) fn payout_bytes(contract: &Contract, id: u64) -> u64 {
    let payout = contract.get_payout(U64(id)).unwrap();
    let account = borsh_len(&payout.requester);
    record_bytes(1 + 8, borsh_len(&payout))
        + record_bytes(1 + account + 4, 8)
        + record_bytes(1 + account, 4 + 4 + 1 + account)
        + record_bytes(1 + account, 4)
}

/// Asserts that `bytes` of storage are paid by `deposit`.
pub(super) fn assert_fits(bytes: u64, deposit: NearToken, what: &str) {
    let paid = deposit.as_yoctonear() / near_sdk::env::storage_byte_cost().as_yoctonear();
    assert!(
        u128::from(bytes) <= paid,
        "{what} stores {bytes} bytes but its deposit pays {paid}"
    );
}

pub(super) fn payout_env(caller: &AccountId, at: u64) {
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
        requested_at(contract, &base_key())
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
        vec![json(&vault_base_key()), PromiseResult::Failed, json(&"x")],
    );
    assert!(!contract.on_bootstrap());
    assert!(contract.get_config().derived_addresses.is_none());

    let contract = bootstrapped();
    let derived = contract.get_config().derived_addresses.unwrap();
    assert_eq!(derived.vault_base, vault_base());
    assert_eq!(derived.vault_sol, vault_sol());
    assert_eq!(derived.gas_sol, gas_sol());

    let mut contract = contract;
    env_at(&accounts(5), ts(200));
    panics_with("Already bootstrapped", || contract.bootstrap());
    env_with_results(ts(205), vec![json(&"secp256k1:x"), json(&"x"), json(&"x")]);
    assert!(contract.on_bootstrap(), "a late callback never rewrites");
    assert_eq!(
        contract.get_config().derived_addresses.unwrap().vault_base,
        vault_base()
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
    let history = contract.get_events(None, Some(64)).events;
    let recorded: Vec<String> = history
        .iter()
        .map(|e| {
            near_sdk::serde_json::to_value(e).unwrap()["event"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    for event in [
        "bootstrap_requested",
        "bootstrapped",
        "deposit_verification_requested",
        "deposit_registered",
    ] {
        assert!(
            recorded.contains(&event.to_string()),
            "{event} is in the on-chain history"
        );
    }
    assert_eq!(class_view.token_risk, crate::views::TOKEN_RISK_NOTE);

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
        requested_at(&contract, &base_key())
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
        requested_at(&contract, &base_key())
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
        requested_at(&contract, &base_key())
    ));
    assert_eq!(
        transferred_to(&accounts(5)),
        deposit.as_yoctonear() - RECORD_STORAGE_DEPOSIT.as_yoctonear(),
        "the holder storage is returned, the refusal record keeps its storage"
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
            vested_to_recipient: true,
        }
    );
    let expected = ReleaseAuthorization {
        lockup: evm::parse_address(&fields.lockup).unwrap(),
        stream_id: 82,
        to: evm::parse_address(&fields.sender).unwrap(),
        vested_to_recipient: true,
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

    let response = base_signature(&contract, 0);
    env_with_results(ts(BASE_NOW + 25), vec![json(&response)]);
    assert!(contract.on_base_signed(U64(0)));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    let signature = payout.base.unwrap();
    let SignatureResponse::Secp256k1(mpc) = response else {
        unreachable!()
    };
    assert_eq!(signature.v, 27 + mpc.recovery_id);
    assert_eq!(signature.r, hex::encode(&mpc.big_r.affine_point[1..]));
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
        env(&accounts(5), NearToken::from_yoctonear(1), ts(BASE_NOW));
        panics_with("record storage deposit", || {
            contract.register_base_cash(location.clone(), fields.clone())
        });
        env(&accounts(5), RECORD_STORAGE_DEPOSIT, ts(BASE_NOW));
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
        assert!(contract.on_base_cash_verified(
            key.clone(),
            hex::encode(hash),
            fields,
            accounts(5),
            requested_at(&contract, &key.clone())
        ));
        assert_fits(
            record_bytes(1 + borsh_len(&key), borsh_len(&ReplayState::Consumed))
                + crate::STORAGE_ACCOUNT_BYTES
                + crate::CASH_ROW_BYTES,
            RECORD_STORAGE_DEPOSIT,
            "a cash registration (replay key, the credited account's registration and cash row)",
        );
        // The record deposit paid the credited account's registration and its new cash row.
        assert!(contract.is_registered(&accounts(1)));
        assert_eq!(contract.storage_shortfall(&accounts(1), 0), 0);
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
    assert_eq!(
        contract.cash_of(&accounts(1), &other_venue),
        0,
        "never refunded"
    );
    env_at(&accounts(4), ts(1_006));
    contract.retry_base_signature(U64(0)).detach();
    env_with_results(ts(1_010), vec![json(&base_signature(&contract, 0))]);
    assert!(contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Signed
    );
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
fn claim_base_tokens_debits_then_signs_and_never_refunds() {
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
        requested_at(&contract, &base_key())
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

    env_with_results(ts(8_005), vec![json(&base_signature(&contract, 0))]);
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
    env_at(&accounts(1), ts(9_005));
    assert_eq!(
        contract.get_claimable(accounts(1), class.clone()).0,
        500_000_000,
        "never refunded (a late signature would stay executable): only five seconds of accrual"
    );
    assert_eq!(
        contract.get_payout(U64(1)).unwrap().status,
        PayoutStatus::Requested
    );
    env_at(&accounts(4), ts(9_006));
    contract.retry_base_signature(U64(1)).detach();
    env_with_results(ts(9_010), vec![json(&base_signature(&contract, 1))]);
    assert!(contract.on_base_signed(U64(1)));
    assert_eq!(
        contract.get_payout(U64(1)).unwrap().status,
        PayoutStatus::Signed,
        "a failed request is retried at once"
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

/// The midstream Base deposit of `claim_base_tokens_debits_then_signs_and_refunds_only_without_signature`.
fn midstream_holder() -> (Contract, String) {
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
        fields,
        accounts(5),
        U128(deposit.as_yoctonear()),
        requested_at(&contract, &base_key())
    ));
    let class = contract.get_position(U64(0)).unwrap().position.class_id;
    (contract, class)
}

#[test]
fn retried_base_signature_completes_once_and_a_late_callback_changes_nothing() {
    let (mut contract, class) = midstream_holder();
    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
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
    let first = contract.get_payout(U64(0)).unwrap();

    // The account owed a refund cannot take its storage deposit away meanwhile.
    env(&accounts(1), one_yocto(), ts(8_001));
    panics_with("custody actions in flight", || {
        contract.storage_unregister(None)
    });
    env(&accounts(1), one_yocto(), ts(8_001));
    panics_with("custody actions in flight", || {
        contract.storage_withdraw(None)
    });

    env_at(&accounts(4), ts(8_000 + crate::PENDING_EXPIRY_BLOCKS - 1));
    panics_with("still in flight", || contract.retry_base_signature(U64(0)));
    env_at(&accounts(4), ts(8_000 + crate::PENDING_EXPIRY_BLOCKS));
    contract.retry_base_signature(U64(0)).detach();
    let retried = contract.get_payout(U64(0)).unwrap();
    assert_eq!(retried.digest, first.digest, "the same digest and id");
    assert_eq!(
        retried.requested_block,
        U64(8_000 + crate::PENDING_EXPIRY_BLOCKS)
    );
    assert_eq!(
        contract.get_claimable(accounts(1), class.clone()).0,
        crate::PENDING_EXPIRY_BLOCKS as u128 * 100_000_000,
        "nothing debited twice: only the accrual since the claim"
    );

    assert_eq!(retried.sign_requests, 2);
    env_with_results(ts(8_650), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Requested,
        "after a retry a failure proves nothing: the first request may have signed"
    );
    let signature = base_signature(&contract, 0);
    env_with_results(ts(8_700), vec![json(&signature)]);
    assert!(contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Signed
    );
    env_with_results(ts(8_701), vec![PromiseResult::Failed]);
    assert!(
        !contract.on_base_signed(U64(0)),
        "a late failure is ignored"
    );
    env_with_results(ts(8_702), vec![json(&signature)]);
    assert!(
        !contract.on_base_signed(U64(0)),
        "and so is a second signature"
    );
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    env_at(&accounts(1), ts(8_702));
    assert_eq!(
        contract.get_claimable(accounts(1), class.clone()).0,
        contract.claimable_of(&crate::types::ClaimSource::Holding {
            account: accounts(1),
            class_id: class.clone(),
        }),
    );
    assert!(
        contract.get_claimable(accounts(1), class.clone()).0 < claimable,
        "no refund of the signed claim: only the accrual since"
    );
    env_at(&accounts(4), ts(9_400));
    panics_with("not awaiting its signature", || {
        contract.retry_base_signature(U64(0))
    });

    // The hold lasts until the payout is signed: a failed request keeps it (the payout is
    // retried, never refunded), the signature releases it.
    payout_env(&accounts(1), ts(9_500));
    let later = contract.get_claimable(accounts(1), class.clone()).0;
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding {
                class_id: class.clone(),
            },
            U128(later),
            RECIPIENT.into(),
        )
        .detach();
    env(&accounts(1), one_yocto(), ts(9_501));
    panics_with("custody actions in flight", || {
        contract.storage_unregister(None)
    });
    env_with_results(ts(9_505), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(1)));
    env(&accounts(1), one_yocto(), ts(9_505));
    panics_with("custody actions in flight", || {
        contract.storage_withdraw(None)
    });
    env_at(&accounts(4), ts(9_506));
    contract.retry_base_signature(U64(1)).detach();
    env_with_results(ts(9_510), vec![json(&base_signature(&contract, 1))]);
    assert!(contract.on_base_signed(U64(1)));
    env(&accounts(1), one_yocto(), ts(9_511));
    contract.storage_withdraw(None);
    env(&accounts(1), one_yocto(), ts(9_511));
    panics_with("still holds units", || contract.storage_unregister(None));
}

#[test]
fn deposit_callback_credits_a_holder_that_tried_to_withdraw_its_storage_meanwhile() {
    let mut contract = bootstrapped();
    let holder = accounts(1);
    register(&mut contract, &holder, ts(BASE_NOW - 10));
    let needed = registration_deposit(&contract, &holder);
    assert_eq!(
        needed.as_yoctonear(),
        RECORD_STORAGE_DEPOSIT.as_yoctonear(),
        "the registration covers the first row: only the records' storage"
    );
    env(&accounts(5), needed, ts(BASE_NOW));
    contract
        .register_base_deposit(base_location(), base_fields())
        .detach();
    env(&holder, one_yocto(), ts(BASE_NOW + 1));
    panics_with("custody actions in flight", || {
        contract.storage_withdraw(None)
    });
    env(&holder, one_yocto(), ts(BASE_NOW + 1));
    panics_with("custody actions in flight", || {
        contract.storage_unregister(None)
    });

    // A failed verification releases the hold: nothing was credited.
    env_with_results(ts(BASE_NOW + 7), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_deposit_verified(
        base_key(),
        hex::encode([0u8; 32]),
        base_fields(),
        accounts(5),
        U128(0),
        requested_at(&contract, &base_key())
    ));
    env(&holder, one_yocto(), ts(BASE_NOW + 8));
    contract.storage_withdraw(None);

    // The retried registration lands while the holder is again refused its withdrawal.
    env(&accounts(5), needed, ts(BASE_NOW + 9));
    contract
        .register_base_deposit(base_location(), base_fields())
        .detach();
    env(&holder, one_yocto(), ts(BASE_NOW + 10));
    panics_with("custody actions in flight", || {
        contract.storage_withdraw(None)
    });
    let hash = stream_hash(&contract, &base_location(), &base_fields());
    env_with_results(ts(BASE_NOW + 16), vec![foreign_response(hash)]);
    assert!(contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        base_fields(),
        accounts(5),
        U128(0),
        requested_at(&contract, &base_key())
    ));
    let class = contract.get_position(U64(0)).unwrap().position.class_id;
    assert_eq!(
        contract.mt_balance_of(holder.clone(), class).0,
        base_fields().deposited.0
    );
    let min = contract.storage_balance_bounds().min;
    assert_eq!(
        contract.storage_balance_of(holder.clone()).unwrap(),
        crate::StorageBalance {
            total: min,
            available: U128(0),
        }
    );
    env(&holder, one_yocto(), ts(BASE_NOW + 20));
    panics_with("still holds units", || contract.storage_unregister(None));
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
        contract.redeem(U64(0), RECIPIENT.into(), None)
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
        contract.redeem(U64(0), RECIPIENT.into(), None)
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
    contract.redeem(U64(0), RECIPIENT.into(), None).detach();
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 0);
    assert_eq!(contract.mt_supply(class.clone()).unwrap().0, 0);
    assert_eq!(contract.get_pending_release(U64(0)), Some(U64(0)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Releasing
    );
    payout_env(&accounts(1), ts(BASE_NOW + 21));
    panics_with("in flight", || {
        contract.redeem(U64(0), RECIPIENT.into(), None)
    });

    // A failed request never gives the units back (a late Release signature would stay
    // executable): the release is retried and completes.
    env_with_results(ts(BASE_NOW + 25), vec![PromiseResult::Failed]);
    assert!(!contract.on_base_signed(U64(0)));
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 0);
    assert_eq!(contract.get_pending_release(U64(0)), Some(U64(0)));
    env_at(&accounts(4), ts(BASE_NOW + 26));
    contract.retry_base_signature(U64(0)).detach();
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::BaseRelease {
            lockup: base_fields().lockup,
            stream_id: 82,
            to: RECIPIENT.into(),
            vested_to_recipient: false,
        }
    );
    assert_eq!(payout.sign_requests, 2);
    env_with_results(ts(BASE_NOW + 35), vec![json(&base_signature(&contract, 0))]);
    assert!(contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
    assert_eq!(contract.mt_balance_of(accounts(1), class), 0.into());
    payout_env(&accounts(1), ts(BASE_NOW + 40));
    panics_with("not held", || {
        contract.redeem(U64(0), RECIPIENT.into(), None)
    });
}

#[test]
fn unreadable_base_signatures_are_never_refunded_and_recovered_by_submission() {
    let (mut contract, class) = midstream_holder();
    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
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

    env_with_results(
        ts(8_005),
        vec![PromiseResult::Successful(b"not a signature".to_vec())],
    );
    assert!(!contract.on_base_signed(U64(0)));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.status,
        PayoutStatus::Requested,
        "an unreadable response may hide a valid signature: never refunded"
    );
    env_at(&accounts(1), ts(8_005));
    assert!(
        contract.get_claimable(accounts(1), class.clone()).0 < claimable,
        "the claim stays debited"
    );

    let SignatureResponse::Secp256k1(good) = base_signature(&contract, 0) else {
        unreachable!()
    };
    let r = hex::encode(&good.big_r.affine_point[1..]);
    let s = hex::encode(good.s.scalar);
    env_at(&accounts(4), ts(8_010));
    panics_with("does not recover", || {
        contract.submit_base_signature(U64(0), r.clone(), s.clone(), 27 + (good.recovery_id ^ 1))
    });
    let (stranger, _) = EcdsaKey::from_bytes(&[0x43u8; 32].into())
        .unwrap()
        .sign_prehash_recoverable(&hex::decode(payout.digest.clone().unwrap()).unwrap())
        .unwrap();
    panics_with("does not recover", || {
        contract.submit_base_signature(
            U64(0),
            hex::encode(&stranger.to_bytes()[..32]),
            hex::encode(&stranger.to_bytes()[32..]),
            27,
        )
    });
    panics_with("v must be 27 or 28", || {
        contract.submit_base_signature(U64(0), r.clone(), s.clone(), 1)
    });

    // The high-s twin of the signature is normalized to the same low-s form.
    let high_s = hex::encode(n_minus(&good.s.scalar));
    contract.submit_base_signature(U64(0), r.clone(), high_s, 27 + (good.recovery_id ^ 1));
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    let stored = payout.base.unwrap();
    assert_eq!(stored.s, s);
    assert_eq!(stored.v, 27 + good.recovery_id);
    panics_with("not awaiting its signature", || {
        contract.submit_base_signature(U64(0), r, s, 27 + good.recovery_id)
    });
}

#[test]
fn a_high_s_mpc_signature_is_normalized_instead_of_refunded() {
    let (mut contract, class) = midstream_holder();
    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
    payout_env(&accounts(1), ts(8_000));
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding { class_id: class },
            U128(claimable),
            RECIPIENT.into(),
        )
        .detach();
    let SignatureResponse::Secp256k1(good) = base_signature(&contract, 0) else {
        unreachable!()
    };
    let mut high = good.clone();
    high.s.scalar = n_minus(&good.s.scalar);
    high.recovery_id ^= 1;
    env_with_results(ts(8_005), vec![json(&SignatureResponse::Secp256k1(high))]);
    assert!(contract.on_base_signed(U64(0)));
    let stored = contract.get_payout(U64(0)).unwrap().base.unwrap();
    assert_eq!(stored.s, hex::encode(good.s.scalar));
    assert_eq!(stored.v, 27 + good.recovery_id);
}

#[test]
fn a_starved_base_callback_leaves_a_retryable_payout() {
    let (mut contract, class) = midstream_holder();
    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
    payout_env(&accounts(1), ts(8_000));
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding { class_id: class },
            U128(claimable),
            RECIPIENT.into(),
        )
        .detach();
    // The callback never runs (out of gas): the payout stays requested until the retry.
    env_at(&accounts(4), ts(8_000 + crate::PENDING_EXPIRY_BLOCKS));
    contract.retry_base_signature(U64(0)).detach();
    env_with_results(ts(8_700), vec![json(&base_signature(&contract, 0))]);
    assert!(contract.on_base_signed(U64(0)));
    assert_eq!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Signed
    );
}

#[test]
fn records_and_payouts_fit_their_storage_deposits() {
    let (mut contract, class) = midstream_holder();
    let position = contract.positions.get(&0).unwrap().clone();
    let stored_class = contract.classes.get(&class).unwrap().clone();
    let registration = record_bytes(
        1 + borsh_len(&base_key()),
        borsh_len(&ReplayState::Consumed),
    ) + record_bytes(1 + 8, borsh_len(&position))
        + record_bytes(1 + borsh_len(&class), borsh_len(&stored_class));
    assert_fits(registration, RECORD_STORAGE_DEPOSIT, "a Base registration");

    env_at(&accounts(1), ts(8_000));
    let claimable = contract.get_claimable(accounts(1), class.clone()).0;
    payout_env(&accounts(1), ts(8_000));
    contract
        .claim_base_tokens(
            ClaimSourceArgs::Holding { class_id: class },
            U128(claimable),
            RECIPIENT.into(),
        )
        .detach();
    env_with_results(ts(8_005), vec![json(&base_signature(&contract, 0))]);
    assert!(contract.on_base_signed(U64(0)));
    assert_fits(
        payout_bytes(&contract, 0),
        PAYOUT_STORAGE_DEPOSIT,
        "a Base payout",
    );

    env(&accounts(1), NearToken::from_millinear(20), ts(8_010));
    panics_with("0.025 NEAR", || {
        contract.claim_base_tokens(
            ClaimSourceArgs::Holding {
                class_id: String::new(),
            },
            U128(1),
            RECIPIENT.into(),
        )
    });
}

/// `n - s` for a big-endian scalar.
fn n_minus(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut digit = i16::from(SECP256K1_N[i]) - i16::from(s[i]) - borrow;
        borrow = i16::from(digit < 0);
        if digit < 0 {
            digit += 256;
        }
        out[i] = digit as u8;
    }
    out
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

/// The three spellings of one address: canonical, bare lowercase hex, and mixed case with `0x`.
fn spellings(canonical: &str) -> [String; 3] {
    let bare = canonical.trim_start_matches("0x").to_string();
    let mixed: String = bare
        .chars()
        .enumerate()
        .map(|(i, c)| {
            if i % 2 == 0 {
                c.to_ascii_uppercase()
            } else {
                c
            }
        })
        .collect();
    [canonical.to_string(), bare, format!("0x{mixed}")]
}

/// Respells the addresses of `fields` as `spelling` (0: canonical, 1: bare, 2: mixed case).
fn respelled(fields: &StreamDepositedFields, spelling: usize) -> StreamDepositedFields {
    StreamDepositedFields {
        sender: spellings(&fields.sender)[spelling].clone(),
        lockup: spellings(&fields.lockup)[spelling].clone(),
        token: spellings(&fields.token)[spelling].clone(),
        ..fields.clone()
    }
}

#[test]
fn every_spelling_of_a_stream_deposit_registers_the_canonical_position_once() {
    let canonical_class = {
        let mut contract = bootstrapped();
        register_base(&mut contract, base_fields())
    };
    for spelling in [1, 2] {
        let mut contract = bootstrapped();
        let fields = respelled(&base_fields(), spelling);
        let class = contract
            .compute_base_class_id(
                fields.token.clone(),
                18,
                crate::custody::SablierScheduleArgs {
                    start: fields.start,
                    cliff: fields.cliff,
                    end: fields.end,
                    granularity: 1,
                    start_unlock: fields.start_unlock,
                    cliff_unlock: fields.cliff_unlock,
                    deposited: fields.deposited,
                },
            )
            .unwrap();
        assert_eq!(
            class, canonical_class,
            "the class id view ignores the spelling"
        );
        let deposit = registration_deposit(&contract, &accounts(1));
        env(&accounts(5), deposit, ts(BASE_NOW));
        contract
            .register_base_deposit(base_location(), fields.clone())
            .detach();
        let forwarded: StreamDepositedFields =
            serde_json::from_value(last_call_args("on_base_deposit_verified")["fields"].clone())
                .unwrap();
        assert_eq!(forwarded.sender, base_fields().sender);
        assert_eq!(forwarded.lockup, base_fields().lockup);
        assert_eq!(forwarded.token, base_fields().token);
        let hash = stream_hash(&contract, &base_location(), &base_fields());
        env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
        assert!(contract.on_base_deposit_verified(
            base_key(),
            hex::encode(hash),
            forwarded,
            accounts(5),
            U128(deposit.as_yoctonear()),
            requested_at(&contract, &base_key())
        ));
        let position = contract.get_position(U64(0)).unwrap().position;
        assert_eq!(position.class_id, canonical_class);
        assert_eq!(position.depositor, accounts(1));
        assert_eq!(
            contract.mt_balance_of(accounts(1), canonical_class.clone()),
            base_fields().deposited
        );
        for other in 0..3 {
            env(&accounts(3), deposit, ts(BASE_NOW + 100));
            panics_with("Already registered", || {
                contract.register_base_deposit(base_location(), respelled(&base_fields(), other))
            });
        }
    }
}

#[test]
fn every_spelling_of_a_refused_stream_records_the_canonical_return() {
    for spelling in [1, 2] {
        let mut contract = bootstrapped();
        let fields = StreamDepositedFields {
            cancelable: true,
            ..respelled(&base_fields(), spelling)
        };
        let deposit = registration_deposit(&contract, &accounts(1));
        env(&accounts(5), deposit, ts(BASE_NOW));
        contract
            .register_base_deposit(base_location(), fields)
            .detach();
        let forwarded: StreamDepositedFields =
            serde_json::from_value(last_call_args("on_base_deposit_verified")["fields"].clone())
                .unwrap();
        let canonical = StreamDepositedFields {
            cancelable: true,
            ..base_fields()
        };
        let hash = stream_hash(&contract, &base_location(), &canonical);
        env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
        assert!(!contract.on_base_deposit_verified(
            base_key(),
            hex::encode(hash),
            forwarded,
            accounts(5),
            U128(deposit.as_yoctonear()),
            requested_at(&contract, &base_key())
        ));
        let refused = contract.get_refused_deposit(base_key()).unwrap();
        assert_eq!(refused.reason, "stream is cancelable");
        assert_eq!(refused.return_to, base_fields().sender);
        assert_eq!(
            refused.asset,
            RefusedAsset::BaseStream {
                lockup: base_fields().lockup,
                stream_id: 82
            }
        );
        // The replay views find the record under any spelling of the transaction hash.
        let ReplayKey::BaseLog { tx_hash, log_index } = base_key() else {
            unreachable!()
        };
        let upper = ReplayKey::BaseLog {
            tx_hash: format!("0x{}", tx_hash.to_ascii_uppercase()),
            log_index,
        };
        assert_eq!(
            contract.get_replay(upper.clone()),
            Some(ReplayState::Consumed)
        );
        assert!(contract.get_refused_deposit(upper.clone()).is_some());
        payout_env(&accounts(3), ts(BASE_NOW + 20));
        contract.return_refused_deposit(upper, None).detach();
        assert_eq!(
            contract.get_payout(U64(0)).unwrap().kind,
            PayoutKind::BaseRelease {
                lockup: base_fields().lockup,
                stream_id: 82,
                to: base_fields().sender,
                vested_to_recipient: true,
            }
        );
    }
}

#[test]
fn every_spelling_of_a_cash_deposit_credits_the_canonical_venue() {
    let accepted = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    for spelling in [1, 2] {
        let mut contract = bootstrapped();
        let fields = CashDepositedFields {
            sender: spellings("0xfa76b8f304d2a87fcaee0c258a76118368d0d671")[spelling].clone(),
            token: spellings(accepted)[spelling].clone(),
            round_id: 7,
            near_account: accounts(1).to_string(),
            amount: U128(5 * USDC),
            timestamp: 1793753725,
        };
        env(&accounts(5), RECORD_STORAGE_DEPOSIT, ts(BASE_NOW));
        contract
            .register_base_cash(base_location(), fields.clone())
            .detach();
        let forwarded: CashDepositedFields =
            serde_json::from_value(last_call_args("on_base_cash_verified")["fields"].clone())
                .unwrap();
        assert_eq!(forwarded.token, accepted);
        assert_eq!(
            forwarded.sender,
            "0xfa76b8f304d2a87fcaee0c258a76118368d0d671"
        );
        let event = evm::CashDeposited {
            sender: evm::parse_address(&forwarded.sender).unwrap(),
            token: evm::parse_address(accepted).unwrap(),
            round_id: 7,
            near_account: accounts(1).to_string(),
            amount: 5 * USDC,
            timestamp: 1793753725,
        };
        let tx_hash = crate::foreign::mpc::parse_hex_array(&base_location().tx_hash).unwrap();
        let log = event.evm_log(
            evm::parse_address(&contract.get_config().rose_vault).unwrap(),
            &LogLocation {
                transaction_hash: tx_hash,
                transaction_index: 2,
                block_hash: crate::foreign::mpc::parse_hex_array(&base_location().block_hash)
                    .unwrap(),
                block_number: base_location().block_number,
                log_index: 2,
            },
        );
        let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: Bytes32(tx_hash),
            extractors: vec![EvmExtractor::Log { log_index: 2 }],
            finality: EvmFinality::Safe,
        });
        let hash = payload_hash(request, vec![ExtractedValue::log(log)]);
        env_with_results(ts(BASE_NOW + 7), vec![foreign_response(hash)]);
        assert!(contract.on_base_cash_verified(
            base_key(),
            hex::encode(hash),
            forwarded,
            accounts(5),
            requested_at(&contract, &base_key())
        ));
        let venue = Venue::Base {
            token: accepted.to_string(),
        };
        assert_eq!(contract.cash_of(&accounts(1), &venue), 5 * USDC);
        assert!(contract
            .get_cash(accounts(1))
            .iter()
            .any(|cash| cash.venue == venue && cash.amount == U128(5 * USDC)));
        // The cash leaves under any spelling of its token too.
        payout_env(&accounts(1), ts(BASE_NOW + 10));
        contract
            .withdraw_base_cash(
                spellings(accepted)[3 - spelling].clone(),
                U128(USDC),
                RECIPIENT.into(),
            )
            .detach();
        assert_eq!(contract.cash_of(&accounts(1), &venue), 4 * USDC);
        for other in 0..3 {
            env(&accounts(3), RECORD_STORAGE_DEPOSIT, ts(BASE_NOW + 100));
            panics_with("Already registered", || {
                contract.register_base_cash(
                    base_location(),
                    CashDepositedFields {
                        token: spellings(accepted)[other].clone(),
                        ..fields.clone()
                    },
                )
            });
        }
    }
}

#[test]
fn base_payouts_store_the_canonical_recipient_and_refuse_custody_addresses() {
    let (mut contract, class) = midstream_holder();
    let source = || ClaimSourceArgs::Holding {
        class_id: class.clone(),
    };
    let vault = contract.get_config().rose_vault;
    for refused in spellings(&vault)
        .into_iter()
        .chain(spellings(&vault_base()))
    {
        payout_env(&accounts(1), ts(8_000));
        panics_with(
            "to must not be RoseVault or the engine's vault/base address",
            || contract.claim_base_tokens(source(), U128(1), refused.clone()),
        );
        payout_env(&accounts(1), ts(8_000));
        panics_with(
            "to must not be RoseVault or the engine's vault/base address",
            || contract.redeem(U64(0), refused.clone(), None),
        );
    }
    payout_env(&accounts(1), ts(8_000));
    contract
        .claim_base_tokens(source(), U128(1), spellings(RECIPIENT)[2].clone())
        .detach();
    let PayoutKind::BaseTransfer { to, .. } = contract.get_payout(U64(0)).unwrap().kind else {
        panic!("a Base transfer")
    };
    assert_eq!(to, RECIPIENT);
    payout_env(&accounts(1), ts(8_001));
    contract
        .redeem(U64(0), spellings(RECIPIENT)[1].clone(), None)
        .detach();
    assert_eq!(
        contract.get_payout(U64(1)).unwrap().kind,
        PayoutKind::BaseRelease {
            lockup: base_fields().lockup,
            stream_id: 82,
            to: RECIPIENT.into(),
            vested_to_recipient: false,
        }
    );
}

/// The late callback of a Base registration abandoned and requested again acts on nothing:
/// the replacing request keeps its mark and its hold, and its own callback registers the log.
#[test]
fn a_late_callback_of_a_replaced_base_registration_keeps_the_new_hold() {
    let mut contract = bootstrapped();
    let deposit = registration_deposit(&contract, &accounts(1));
    let request = |contract: &mut Contract, at: u64| {
        env(&accounts(5), deposit, at);
        contract
            .register_base_deposit(base_location(), base_fields())
            .detach();
        requested_at(contract, &base_key())
    };
    let abandoned = request(&mut contract, ts(BASE_NOW));
    let replacing = request(&mut contract, ts(BASE_NOW + crate::PENDING_EXPIRY_BLOCKS));
    assert_ne!(abandoned, replacing);
    let hash = stream_hash(&contract, &base_location(), &base_fields());
    env_with_results(
        ts(BASE_NOW + crate::PENDING_EXPIRY_BLOCKS + 7),
        vec![foreign_response(hash)],
    );
    assert!(!contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        base_fields(),
        accounts(5),
        U128(deposit.as_yoctonear()),
        abandoned,
    ));
    assert_eq!(requested_at(&contract, &base_key()), replacing);
    assert!(contract.has_pending_custody(&accounts(1)));
    assert!(contract.get_position(U64(0)).is_none());
    env_with_results(
        ts(BASE_NOW + crate::PENDING_EXPIRY_BLOCKS + 8),
        vec![foreign_response(hash)],
    );
    assert!(contract.on_base_deposit_verified(
        base_key(),
        hex::encode(hash),
        base_fields(),
        accounts(5),
        U128(deposit.as_yoctonear()),
        replacing,
    ));
    assert!(!contract.has_pending_custody(&accounts(1)));
    assert!(contract.get_position(U64(0)).is_some());
}
