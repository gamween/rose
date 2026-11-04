//! Unit tests of the contract modules in the near-sdk unit-testing VM.
//!
//! Sealed bids are encrypted with `rose-ibe` against a deterministic test master key, so the
//! tests can produce the CKD output `(Y, C)` the callback expects, exactly as Sealwell's tests do.

mod accrual;
mod advance;
mod custody;
mod custody_solana;
mod exit;
mod guards;
mod liens;
mod sealing;
mod storage;
mod tender;
mod units;
mod views;

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};

use ark_ec::{AffineRepr, CurveGroup};
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};
use rand::rngs::StdRng;
use rand::SeedableRng;
use rose_ibe::{AssociatedData, Fr, G1Affine, G2Affine, Plaintext, SALT_LEN};

use crate::rounds::{AdvanceParams, ExitParams, TenderParams};
use crate::sealing::CkdResponse;
use crate::types::{Chain, RoundWindow, Side, Venue};
use crate::unlock::{ClassSchedule, StreamflowParams, StreamflowStream};
use crate::{Contract, InitArgs, BID_STORAGE_DEPOSIT, ROUND_STORAGE_DEPOSIT};

pub const ENGINE: &str = "engine.rose-app.testnet";
pub const CASH_TOKEN: &str = "tusdc.rose-app.testnet";
pub const TREASURY: &str = "treasury.rose-app.testnet";
pub const USDC: u128 = 1_000_000;
/// Solana payout address of the test Tenders (the stepped class lives on Solana).
pub const RETIRE_TO: &str = "11111111111111111111111111111111";
pub const NS: u64 = 1_000_000_000;
/// Ten minutes, the configured reveal window.
pub const REVEAL_WINDOW: u64 = 600 * NS;
/// One hour, the configured key timeout.
pub const KEY_TIMEOUT: u64 = 3_600 * NS;

/// An extra account beyond near-sdk's six test accounts.
pub fn account(name: &str) -> AccountId {
    format!("{name}.testnet").parse().unwrap()
}

pub fn engine() -> AccountId {
    ENGINE.parse().unwrap()
}

pub fn cash_token() -> AccountId {
    CASH_TOKEN.parse().unwrap()
}

pub fn treasury() -> AccountId {
    TREASURY.parse().unwrap()
}

pub fn ts(secs: u64) -> u64 {
    secs * NS
}

/// Deterministic test master secret key.
fn msk() -> Fr {
    Fr::from(0x5eed_c0de_1234_5678u64)
}

pub fn mpk() -> G2Affine {
    (G2Affine::generator() * msk()).into_affine()
}

pub fn round_key(round_id: u64) -> G1Affine {
    let app_id = rose_ibe::round_app_id(ENGINE, round_id);
    (rose_ibe::identity_point(&mpk(), &app_id) * msk()).into_affine()
}

/// A CKD output `(Y, C) = (y * G1, key + y * pk1)` for the round's public scalar.
pub fn ckd_response(round_id: u64) -> CkdResponse {
    let y = Fr::from(0x77u64 + round_id);
    let (pk1, _) = rose_ibe::app_public_key_pv(&rose_ibe::app_scalar(ENGINE, round_id));
    let big_y = (G1Affine::generator() * y).into_affine();
    let big_c = (G1Affine::from(round_key(round_id)) * Fr::from(1u64) + pk1 * y).into_affine();
    CkdResponse {
        big_y: rose_ibe::format_near_g1(&big_y),
        big_c: rose_ibe::format_near_g1(&big_c),
    }
}

/// A sealed order: `(ciphertext_hex, plaintext_hex, sigma_hex)`.
pub struct Sealed {
    pub ciphertext: String,
    pub plaintext: String,
    pub sigma: String,
}

pub fn seal(round_id: u64, bidder: &AccountId, side: Side, quantity: u128, price: u128) -> Sealed {
    let mut seed = (quantity ^ price) as u64 ^ round_id ^ u64::from(side.ad_byte());
    for byte in bidder.as_bytes() {
        seed = seed.rotate_left(8) ^ u64::from(*byte);
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let plaintext = Plaintext {
        quantity,
        limit_price: price,
        salt: [side.ad_byte() + 1; SALT_LEN],
    };
    let ad = AssociatedData {
        round_id,
        bidder: bidder.as_str(),
        side: side.ad_byte(),
    };
    let app_id = rose_ibe::round_app_id(ENGINE, round_id);
    let (ciphertext, sigma) = rose_ibe::encrypt(&mut rng, &mpk(), &app_id, &ad, &plaintext);
    Sealed {
        ciphertext: hex::encode(ciphertext.to_bytes()),
        plaintext: hex::encode(plaintext.to_bytes()),
        sigma: hex::encode(sigma),
    }
}

thread_local! {
    /// Logs and receipts of the previous contexts: the mock drops them on every context change.
    static HISTORY: RefCell<(Vec<String>, Vec<near_sdk::mock::Receipt>)> = RefCell::new(Default::default());
}

/// Saves the current context's logs and receipts before the context changes.
fn keep_history() {
    let logs = get_logs();
    let receipts = get_created_receipts();
    HISTORY.with(|h| {
        let mut h = h.borrow_mut();
        h.0.extend(logs);
        h.1.extend(receipts);
    });
}

fn all_logs() -> Vec<String> {
    let mut logs = HISTORY.with(|h| h.borrow().0.clone());
    logs.extend(get_logs());
    logs
}

fn all_receipts() -> Vec<near_sdk::mock::Receipt> {
    let mut receipts = HISTORY.with(|h| h.borrow().1.clone());
    receipts.extend(get_created_receipts());
    receipts
}

/// Sets the blockchain context: caller, attached deposit and block time.
pub fn env(predecessor: &AccountId, deposit: NearToken, timestamp: u64) {
    keep_history();
    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(deposit)
        .block_timestamp(timestamp)
        .block_height(timestamp / NS)
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build();
    testing_env!(context);
}

pub fn env_at(predecessor: &AccountId, timestamp: u64) {
    env(predecessor, NearToken::from_yoctonear(0), timestamp);
}

/// Sets the context of a callback with one promise result.
pub fn env_with_result(timestamp: u64, result: near_sdk::PromiseResult) {
    keep_history();
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
        vec![result]
    );
}

pub fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

/// A fresh mocked blockchain with empty storage (proptest cases share one thread).
fn fresh_env() {
    HISTORY.with(|h| *h.borrow_mut() = Default::default());
    let context = VMContextBuilder::new()
        .current_account_id(engine())
        .predecessor_account_id(engine())
        .block_timestamp(ts(100))
        .build();
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        context,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
}

pub fn init() -> Contract {
    fresh_env();
    Contract::new(InitArgs {
        mpc_account: "v1.signer-prod.testnet".parse().unwrap(),
        sign_secp256k1_domain: 0,
        sign_ed25519_domain: 1,
        ckd_domain: 2,
        foreign_tx_domain: 3,
        ckd_public_key: rose_ibe::format_near_g2(&mpk()),
        fee_recipient: treasury(),
        near_cash_token: cash_token(),
        base_cash_tokens: vec!["0x036cbd53842c5426634e7929541ec2318f3dcf7e".to_string()],
        rose_vault: "0x1111111111111111111111111111111111111111".to_string(),
        base_chain_id: crate::foreign::evm::BASE_SEPOLIA_CHAIN_ID,
        sablier_lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e".to_string(),
        streamflow_program: "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ".to_string(),
        default_key_timeout: None,
        default_reveal_window: None,
    })
}

/// A stepped (Streamflow-like) schedule: `f(t)` rises by exactly `0.1` every 1,000 s from
/// `t = 1,000 s` to `t = 11,000 s`.
pub fn stepped_schedule() -> ClassSchedule {
    let stream = StreamflowStream::new(StreamflowParams {
        start_time: 1_000,
        cliff: 0,
        cliff_amount: 0,
        period: 1_000,
        amount_per_period: 100,
        net_amount_deposited: 1_000,
        end_time: 11_000,
        ..StreamflowParams::default()
    })
    .unwrap();
    ClassSchedule::from_streamflow(&stream)
}

/// Registers the stepped class with `decimals` decimals.
pub fn stepped_class(contract: &mut Contract, decimals: u8) -> String {
    env_at(&engine(), ts(100));
    contract.ensure_class(
        Chain::Solana,
        format!("Mint{decimals}111111111111111111111111111111111111"),
        decimals,
        stepped_schedule(),
    )
}

/// Registers `account` for storage with the minimum deposit when it is not registered yet.
pub fn register(contract: &mut Contract, account: &AccountId, at: u64) {
    if contract.is_registered(account) {
        return;
    }
    let min = contract.storage_balance_bounds().min.0;
    env(account, NearToken::from_yoctonear(min), at);
    contract.storage_deposit(None, None);
}

/// Storage deposit refunded to a settled bid: the deposit net of the bytes kept for its outcome.
pub fn bid_refund(contract: &Contract, round_id: u64, bid_id: u32) -> u128 {
    let outcome = contract.get_round_result(U64(round_id)).unwrap().fills[bid_id as usize].clone();
    let kept = borsh::to_vec(&outcome).unwrap().len() as u128;
    BID_STORAGE_DEPOSIT.as_yoctonear() - kept * near_sdk::env::storage_byte_cost().as_yoctonear()
}

pub fn mint(contract: &mut Contract, class_id: &str, account: &AccountId, units: u128, at: u64) {
    register(contract, account, at);
    env_at(&engine(), at);
    let f_from = contract
        .class(&class_id.to_string())
        .schedule
        .fraction(at / NS);
    contract.mint_units(&class_id.to_string(), account, units, f_from);
}

pub fn fund(contract: &mut Contract, account: &AccountId, amount: u128, at: u64) {
    env_at(&cash_token(), at);
    contract
        .ft_on_transfer(account.clone(), U128(amount), String::new())
        .detach();
}

pub fn cash(contract: &Contract, account: &AccountId) -> u128 {
    contract.cash_of(account, &Venue::Near)
}

pub fn window(closes_at: u64) -> RoundWindow {
    RoundWindow {
        opens_at: None,
        closes_at: U64(closes_at),
        key_timeout: None,
        reveal_window: None,
    }
}

pub fn create_exit(
    contract: &mut Contract,
    creator: &AccountId,
    class_id: &str,
    max_price: u128,
    at: u64,
    closes_at: u64,
) -> u64 {
    env(creator, ROUND_STORAGE_DEPOSIT, at);
    contract
        .create_exit(ExitParams {
            class_id: class_id.to_string(),
            venue: Venue::Near,
            max_price: U128(max_price),
            window: window(closes_at),
        })
        .0
}

pub fn create_tender(
    contract: &mut Contract,
    issuer: &AccountId,
    class_id: &str,
    budget: u128,
    max_price: u128,
    at: u64,
    closes_at: u64,
) -> u64 {
    env(issuer, ROUND_STORAGE_DEPOSIT, at);
    contract
        .create_tender(TenderParams {
            class_id: class_id.to_string(),
            venue: Venue::Near,
            budget: U128(budget),
            max_price: U128(max_price),
            reference_price: Some(U128(max_price)),
            retire_to: RETIRE_TO.to_string(),
            window: window(closes_at),
        })
        .0
}

/// Public terms of a test Advance.
pub struct AdvanceSpec {
    pub units: u128,
    pub claim: u128,
    pub min_fill: u128,
    pub max_price: u128,
}

pub fn create_advance(
    contract: &mut Contract,
    holder: &AccountId,
    class_id: &str,
    spec: AdvanceSpec,
    at: u64,
    closes_at: u64,
) -> u64 {
    env(holder, ROUND_STORAGE_DEPOSIT, at);
    contract
        .create_advance(AdvanceParams {
            class_id: class_id.to_string(),
            venue: Venue::Near,
            units: U128(spec.units),
            claim: U128(spec.claim),
            min_fill: U128(spec.min_fill),
            max_price: U128(spec.max_price),
            window: window(closes_at),
        })
        .0
}

pub fn place_bid(
    contract: &mut Contract,
    round_id: u64,
    bidder: &AccountId,
    quantity: u128,
    price: u128,
    escrow: u128,
    at: u64,
) -> (u32, Sealed) {
    let sealed = seal(round_id, bidder, Side::Buy, quantity, price);
    if contract.round(round_id).kind == crate::types::RoundKind::Exit {
        register(contract, bidder, at);
    }
    env(bidder, BID_STORAGE_DEPOSIT, at);
    let bid_id = contract.place_bid(U64(round_id), sealed.ciphertext.clone(), U128(escrow));
    (bid_id, sealed)
}

pub fn place_ask(
    contract: &mut Contract,
    round_id: u64,
    seller: &AccountId,
    quantity: u128,
    price: u128,
    units: u128,
    at: u64,
) -> (u32, Sealed) {
    let sealed = seal(round_id, seller, Side::Sell, quantity, price);
    env(seller, BID_STORAGE_DEPOSIT, at);
    let bid_id = contract.place_ask(U64(round_id), sealed.ciphertext.clone(), U128(units));
    (bid_id, sealed)
}

/// `close` then the CKD callback, at `at` and `at + 5 s`. Returns the key reception time.
pub fn close_and_release(contract: &mut Contract, round_id: u64, at: u64) -> u64 {
    env(&accounts(5), one_yocto(), at);
    assert!(contract.close(U64(round_id)).is_some());
    let received = at + 5 * NS;
    env_at(&engine(), received);
    assert!(contract.on_round_key(U64(round_id), Ok(ckd_response(round_id))));
    received
}

pub fn open(contract: &mut Contract, round_id: u64, bid_id: u32, sealed: &Sealed, at: u64) {
    env_at(&accounts(5), at);
    contract.open_bid(
        U64(round_id),
        bid_id,
        sealed.plaintext.clone(),
        sealed.sigma.clone(),
    );
}

pub fn clear(contract: &mut Contract, round_id: u64, at: u64) {
    env_at(&accounts(5), at);
    contract.clear(U64(round_id));
}

pub fn settle(contract: &mut Contract, round_id: u64, bid_id: u32, at: u64) {
    env_at(&accounts(5), at);
    contract.settle_bid(U64(round_id), bid_id);
}

/// Asserts that `f` panics with a message containing `expected`.
pub fn panics_with<R>(expected: &str, f: impl FnOnce() -> R) {
    let result = catch_unwind(AssertUnwindSafe(f));
    let payload = match result {
        Ok(_) => panic!("expected a panic containing {expected:?}, but the call succeeded"),
        Err(payload) => payload,
    };
    let message = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(
        message.contains(expected),
        "expected a panic containing {expected:?}, got {message:?}"
    );
}

/// Yocto transferred to `receiver` by the receipts created so far.
pub fn transferred_to(receiver: &AccountId) -> u128 {
    all_receipts()
        .iter()
        .filter(|receipt| receipt.receiver_id == *receiver)
        .flat_map(|receipt| receipt.actions.iter())
        .filter_map(|action| match action {
            near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
            _ => None,
        })
        .sum()
}

/// Parsed `EVENT_JSON:` logs with the given standard.
pub fn events(standard: &str) -> Vec<serde_json::Value> {
    all_logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str::<serde_json::Value>(json).unwrap())
        .filter(|value| value["standard"] == standard)
        .collect()
}
