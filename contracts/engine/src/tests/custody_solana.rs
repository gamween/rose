//! Foreign custody on Solana: proof-backed attribution, the move and the registration (a
//! premature registration records nothing, callbacks re-check the stage), two-phase payouts
//! drawing on streams the claimant names, confirmation of landing or failure, two-phase redeems,
//! retries after starved callbacks, recovery submissions, returns of refused streams and
//! storage attachments. Every MPC signature is produced by a deterministic test key and checked
//! by the engine.

use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::{accounts, get_created_receipts};
use near_sdk::{NearToken, PromiseOrValue, PromiseResult};
use proptest::prelude::*;

use super::custody::{
    assert_fits, bootstrapped, borsh_len, deposit_key, ed_signature, env_with_results,
    foreign_response, gas_sol_key, json, payout_bytes, payout_env, pubkey_of, record_bytes,
    vault_sol, vault_sol_key,
};
use super::*;
use crate::custody::{
    ClaimSourceArgs, PayoutDebit, PayoutKind, PayoutStatus, RefusedAsset, ReplayKey, ReplayState,
    SolDepositArgs, SolDepositStage, SolDrawArgs, SolNonceProof, SolSwept, PAYOUT_STORAGE_DEPOSIT,
    RECORD_STORAGE_DEPOSIT,
};
use crate::foreign::mpc::{
    payload_hash, Bytes32, Bytes64, ExtractedValue, ForeignChainRpcRequest, SvmAccount,
    SvmExtractor, SvmFinality, SvmRpcRequest,
};
use crate::foreign::solana::{self as sol, SYSTEM_PROGRAM, TOKEN_PROGRAM};
use crate::math::ONE;
use crate::types::{Chain, Holder, PositionState};

/// Decimals of the test mint: one whole token is 100 base units.
const DECIMALS: u8 = 2;
const MINT: [u8; 32] = [9u8; 32];
const STREAM: [u8; 32] = [3u8; 32];
const STREAM_2: [u8; 32] = [33u8; 32];
const RETURN_TO: [u8; 32] = [4u8; 32];
/// The Solana wallet the claimant's nonce accounts are created from (with a seed).
const NONCE_BASE: [u8; 32] = [12u8; 32];
const NONCE_VALUE: [u8; 32] = [13u8; 32];
const NONCE_NEXT: [u8; 32] = [14u8; 32];
/// The value the claimant's receipt nonce account holds until a transaction advances it.
const RECEIPT_VALUE: [u8; 32] = [0xeeu8; 32];
const PARTNER: [u8; 32] = [8u8; 32];
/// Seconds (and blocks) between a confirmation call and its MPC answer in these tests.
const ANSWER_DELAY: u64 = 7;
const PARTNER_TOKENS: [u8; 32] = [10u8; 32];
const TREASURY_TOKENS: [u8; 32] = [11u8; 32];

/// Streamflow metadata fields of a test stream (every flag zero unless set, except
/// `transferable_by_recipient`, which the engine requires).
#[derive(Clone)]
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
    transferable_by_recipient: bool,
    automatic_withdrawal: bool,
    partner_fee_percent: u32,
    closed: bool,
}

/// The escrow token account of a test stream.
fn escrow_of(stream: [u8; 32]) -> [u8; 32] {
    let mut escrow = stream;
    escrow[0] ^= 0x80;
    escrow
}

fn stream_bytes(stream: [u8; 32], spec: &StreamSpec) -> Vec<u8> {
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
    data[209..241].copy_from_slice(&escrow_of(stream));
    data[241..273].copy_from_slice(&sol::STREAMFLOW_TREASURY);
    data[273..305].copy_from_slice(&TREASURY_TOKENS);
    data[325..357].copy_from_slice(&PARTNER);
    data[357..389].copy_from_slice(&PARTNER_TOKENS);
    data[405..409].copy_from_slice(&spec.partner_fee_percent.to_le_bytes());
    put(&mut data, 409, spec.start_time);
    put(&mut data, 417, spec.net_amount_deposited);
    put(&mut data, 425, spec.period);
    put(&mut data, 433, spec.amount_per_period);
    data[459] = u8::from(spec.automatic_withdrawal);
    data[461] = u8::from(spec.transferable_by_recipient);
    data[462] = u8::from(spec.can_topup);
    data[671] = u8::from(spec.closed);
    data
}

fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

/// A classic SPL token account of `mint` owned by `owner` in `state` (1 initialized, 2 frozen).
fn token_bytes(mint: [u8; 32], owner: [u8; 32], state: u8) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(&mint);
    data[32..64].copy_from_slice(&owner);
    data[108] = state;
    data
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

fn fmt(key: &[u8; 32]) -> String {
    sol::format_pubkey(key)
}

fn anchor() -> String {
    bs58::encode([5u8; 64]).into_string()
}

fn vault() -> [u8; 32] {
    pubkey_of(&vault_sol_key())
}

fn deposit_address() -> [u8; 32] {
    pubkey_of(&deposit_key())
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
        transferable_by_recipient: true,
        automatic_withdrawal: false,
        partner_fee_percent: 0,
        closed: false,
    }
}

/// The stream at the vault with `withdrawn` already withdrawn.
fn at_vault(withdrawn: u64) -> StreamSpec {
    StreamSpec {
        amount_withdrawn: withdrawn,
        ..sol_spec(vault())
    }
}

fn sol_account(owner: [u8; 32], data: Vec<u8>) -> SvmAccount {
    SvmAccount {
        owner: Bytes32(owner),
        data,
    }
}

fn sol_hash(accounts: Vec<([u8; 32], SvmAccount)>) -> [u8; 32] {
    let mut anchor_bytes = [0u8; 64];
    bs58::decode(anchor()).onto(&mut anchor_bytes).unwrap();
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

fn metadata_account(stream: [u8; 32], spec: &StreamSpec) -> ([u8; 32], SvmAccount) {
    (
        stream,
        sol_account(streamflow_program(), stream_bytes(stream, spec)),
    )
}

/// The class id of a test schedule, as the app computes it before any deposit exists.
fn sol_class_id(contract: &Contract, spec: &StreamSpec) -> String {
    contract
        .compute_sol_class_id(
            fmt(&spec.mint),
            DECIMALS,
            crate::custody::StreamflowScheduleArgs {
                start_time: spec.start_time,
                cliff: 0,
                cliff_amount: U64(0),
                period: spec.period,
                amount_per_period: U64(spec.amount_per_period),
                net_amount_deposited: U64(spec.net_amount_deposited),
                end_time: spec.end_time,
            },
        )
        .unwrap()
}

/// The class of the stepped schedule of `sol_spec`.
fn stepped_class_id() -> String {
    crate::class_id_of(Chain::Solana, &fmt(&MINT), DECIMALS, &stepped_schedule())
}

/// Attributes `stream` (at the deposit address of `accounts(1)`) through the public methods.
fn attribute_stream(
    contract: &mut Contract,
    stream: [u8; 32],
    spec: &StreamSpec,
) -> SolDepositArgs {
    attribute_with_mint(contract, stream, spec, mint_bytes(DECIMALS))
}

/// Attributes `stream` with the attested mint account `mint`.
fn attribute_with_mint(
    contract: &mut Contract,
    stream: [u8; 32],
    spec: &StreamSpec,
    mint: Vec<u8>,
) -> SolDepositArgs {
    let args = SolDepositArgs {
        metadata: fmt(&stream),
        class_id: sol_class_id(contract, spec),
        return_to: fmt(&RETURN_TO),
        anchor_tx: anchor(),
        metadata_data: hex::encode(stream_bytes(stream, spec)),
        mint_data: hex::encode(&mint),
    };
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(2_000));
    contract.attribute_sol_deposit(args.clone()).detach();
    let path = contract.deposit_path_of(accounts(1), args.class_id.clone());
    env_with_results(
        ts(2_001),
        vec![json(&format!("ed25519:{}", fmt(&deposit_address())))],
    );
    assert!(matches!(
        contract.on_sol_deposit_key(args.clone(), accounts(1), path.clone()),
        PromiseOrValue::Promise(_)
    ));
    let hash = sol_hash(vec![
        metadata_account(stream, spec),
        (MINT, sol_account(TOKEN_PROGRAM, mint)),
    ]);
    env_with_results(ts(2_008), vec![foreign_response(hash)]);
    contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path,
        fmt(&deposit_address()),
        hex::encode(hash),
    );
    args
}

/// The stored message of payout `id`.
fn message_of(contract: &Contract, id: u64) -> Vec<u8> {
    contract
        .get_payout(U64(id))
        .unwrap()
        .solana
        .unwrap()
        .message
        .0
}

/// Signs the move of `metadata` with the deposit key and `gas/sol`; returns the payout id.
fn move_stream(contract: &mut Contract, metadata: &str, at: u64) -> u64 {
    payout_env(&accounts(5), at);
    contract
        .move_sol_deposit(metadata.to_string(), fmt(&[1u8; 32]))
        .detach();
    let id = contract.payouts_total().0 - 1;
    let message = message_of(contract, id);
    env_with_results(
        at + NS,
        vec![
            ed_signature(&deposit_key(), &message),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    assert!(contract.on_sol_signed(U64(id)));
    id
}

/// Registers an attributed stream now at the vault with `withdrawn` already withdrawn at `at`;
/// returns the position id.
fn register_stream(contract: &mut Contract, stream: [u8; 32], withdrawn: u64, at: u64) -> u64 {
    let spec = at_vault(withdrawn);
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), stepped_class_id())
            .0,
    );
    env(&accounts(5), deposit, at);
    contract
        .register_sol_deposit(
            fmt(&stream),
            anchor(),
            hex::encode(stream_bytes(stream, &spec)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(stream, &spec)]);
    env_with_results(at + 7 * NS, vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(stream),
        hex::encode(hash),
        hex::encode(stream_bytes(stream, &spec)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    contract.next_position_id - 1
}

/// Attributes, moves and registers `stream` with `withdrawn` already withdrawn at `at`.
fn deposit_stream(contract: &mut Contract, stream: [u8; 32], withdrawn: u64, at: u64) -> u64 {
    let args = attribute_stream(contract, stream, &sol_spec(deposit_address()));
    move_stream(contract, &args.metadata, ts(2_100));
    register_stream(contract, stream, withdrawn, at)
}

fn stream_key(stream: [u8; 32]) -> ReplayKey {
    ReplayKey::SolStream {
        metadata: fmt(&stream),
    }
}

/// A Solana class with one registered stream of 1,000 units minted to `accounts(1)` at
/// `f = 0` (nothing withdrawn).
fn solana_holder() -> (Contract, String) {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    (contract, stepped_class_id())
}

fn recipient_tokens() -> [u8; 32] {
    sol::associated_token_address(&RETURN_TO, &MINT).unwrap()
}

/// The seed of the claimant's (`accounts(1)`) nonce account: its prefix and a suffix.
fn nonce_seed() -> String {
    format!("{}a", crate::custody::nonce_seed_prefix(&accounts(1)))
}

/// The claimant's nonce account: created from `NONCE_BASE` with its seed.
fn nonce_account() -> [u8; 32] {
    sol::create_with_seed(&NONCE_BASE, &nonce_seed(), &SYSTEM_PROGRAM).unwrap()
}

/// The seed of the claimant's receipt nonce account.
fn receipt_seed() -> String {
    format!("{}r", crate::custody::nonce_seed_prefix(&accounts(1)))
}

/// The claimant's receipt nonce account: created from `NONCE_BASE` with its seed.
fn receipt_account() -> [u8; 32] {
    sol::create_with_seed(&NONCE_BASE, &receipt_seed(), &SYSTEM_PROGRAM).unwrap()
}

/// The caller's account bytes of a payout or redeem to `RETURN_TO` with nonce `value`.
fn proof(value: [u8; 32]) -> SolNonceProof {
    SolNonceProof {
        account: fmt(&nonce_account()),
        base: fmt(&NONCE_BASE),
        seed: nonce_seed(),
        receipt_seed: receipt_seed(),
        anchor_tx: anchor(),
        data: hex::encode(nonce_bytes(vault(), value)),
        receipt_data: hex::encode(nonce_bytes(vault(), RECEIPT_VALUE)),
        recipient_tokens_data: hex::encode(token_bytes(MINT, RETURN_TO, 1)),
    }
}

fn proof_hash(value: [u8; 32]) -> [u8; 32] {
    sol_hash(vec![
        (
            nonce_account(),
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault(), value)),
        ),
        (
            receipt_account(),
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault(), RECEIPT_VALUE)),
        ),
        (
            recipient_tokens(),
            sol_account(TOKEN_PROGRAM, token_bytes(MINT, RETURN_TO, 1)),
        ),
    ])
}

fn nonce_key(value: [u8; 32]) -> ReplayKey {
    ReplayKey::SolNonce {
        account: fmt(&nonce_account()),
        value: fmt(&value),
    }
}

fn holding(class: &str) -> ClaimSourceArgs {
    ClaimSourceArgs::Holding {
        class_id: class.to_string(),
    }
}

fn draw(position_id: u64, amount: u128) -> SolDrawArgs {
    SolDrawArgs {
        position_id: U64(position_id),
        amount: U128(amount),
    }
}

/// Requests a claim of `draws` by `accounts(1)` with nonce `value`; returns the payout id.
fn request_claim(
    contract: &mut Contract,
    class: &str,
    draws: Vec<SolDrawArgs>,
    value: [u8; 32],
    at: u64,
) -> u64 {
    request_claim_with(contract, class, draws, 0, value, at)
}

/// Requests a claim of `draws` plus `swept` from the class's swept balance.
fn request_claim_with(
    contract: &mut Contract,
    class: &str,
    draws: Vec<SolDrawArgs>,
    swept: u128,
    value: [u8; 32],
    at: u64,
) -> u64 {
    payout_env(&accounts(1), at);
    contract
        .claim_sol_tokens(
            holding(class),
            draws,
            (swept > 0).then_some(U128(swept)),
            fmt(&RETURN_TO),
            proof(value),
        )
        .detach();
    contract.payouts_total().0 - 1
}

/// Delivers the matching proof of payout `id`.
fn prove(contract: &mut Contract, id: u64, value: [u8; 32], at: u64) {
    let hash = proof_hash(value);
    env_with_results(at, vec![foreign_response(hash)]);
    assert!(matches!(
        contract.on_sol_nonce_verified(U64(id), hex::encode(hash), nonce_key(value)),
        PromiseOrValue::Promise(_)
    ));
}

/// Delivers valid vault and fee payer signatures of payout `id`.
fn sign(contract: &mut Contract, id: u64, at: u64) -> bool {
    let message = message_of(contract, id);
    env_with_results(
        at,
        vec![
            ed_signature(&vault_sol_key(), &message),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    contract.on_sol_signed(U64(id))
}

/// A claim through proof and signatures: the payout is `Signed`.
fn claim(
    contract: &mut Contract,
    class: &str,
    draws: Vec<SolDrawArgs>,
    value: [u8; 32],
    at: u64,
) -> u64 {
    claim_with(contract, class, draws, 0, value, at)
}

/// A claim of `draws` plus `swept` through proof and signatures.
fn claim_with(
    contract: &mut Contract,
    class: &str,
    draws: Vec<SolDrawArgs>,
    swept: u128,
    value: [u8; 32],
    at: u64,
) -> u64 {
    let id = request_claim_with(contract, class, draws, swept, value, at);
    prove(contract, id, value, at + 5 * NS);
    assert!(sign(contract, id, at + 10 * NS));
    id
}

/// The `executed` and `requested_at` arguments a confirmation passed to its callback, and the
/// proof hash.
fn confirmation() -> (bool, String, U64) {
    let args = get_created_receipts()
        .iter()
        .flat_map(|receipt| receipt.actions.iter())
        .find_map(|action| match action {
            near_sdk::mock::MockAction::FunctionCallWeight {
                method_name, args, ..
            } if method_name == b"on_sol_confirmed" => {
                Some(serde_json::from_slice::<serde_json::Value>(args).unwrap())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no on_sol_confirmed callback scheduled"));
    (
        args["executed"].as_bool().unwrap(),
        args["expected_hash"].as_str().unwrap().to_string(),
        serde_json::from_value(args["requested_at"].clone()).unwrap(),
    )
}

/// The receipt nonce account's value once the nonce moved to `nonce_after`: equal to it when
/// the transaction executed, untouched otherwise.
fn receipt_after(nonce_after: [u8; 32], executed: bool) -> [u8; 32] {
    if executed {
        nonce_after
    } else {
        RECEIPT_VALUE
    }
}

/// Confirms payout `id` with the nonce at `nonce_after` and the receipt as an executed (or a
/// failed) transaction leaves it; returns what the engine concluded. A "did not execute"
/// verdict takes two proofs, the second requested `CONFIRM_FAILURE_DELAY_BLOCKS` after the
/// first one's answer: the first one leaves the payout `Signed`.
fn confirm_payout(
    contract: &mut Contract,
    id: u64,
    nonce_after: [u8; 32],
    executed: bool,
    at: u64,
) -> bool {
    let receipt = receipt_after(nonce_after, executed);
    let landed = prove_payout_state(contract, id, nonce_after, receipt, at);
    if !landed {
        assert_eq!(
            contract.get_payout(U64(id)).unwrap().status,
            PayoutStatus::Signed,
            "one proof of a transaction that did not execute is not enough"
        );
        let later = at + ts(ANSWER_DELAY + crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS);
        assert!(!prove_payout_state(
            contract,
            id,
            nonce_after,
            receipt,
            later
        ));
    }
    landed
}

/// One confirmation proof of payout `id` with the nonce at `nonce_after` and the receipt at
/// `receipt`, answered `ANSWER_DELAY` later.
fn prove_payout_state(
    contract: &mut Contract,
    id: u64,
    nonce_after: [u8; 32],
    receipt: [u8; 32],
    at: u64,
) -> bool {
    let request = request_payout_proof(contract, id, nonce_after, receipt, at);
    answer_proof(contract, id, &request, at + ts(ANSWER_DELAY))
}

/// A confirmation request in flight: what its callback will receive.
struct ProofRequest {
    executed: bool,
    hash: String,
    requested_at: U64,
}

/// The proof hash of a confirmation reading the nonce at `nonce_after` and the receipt at
/// `receipt`.
fn confirmation_hash(nonce_after: [u8; 32], receipt: [u8; 32]) -> String {
    hex::encode(sol_hash(vec![
        (
            nonce_account(),
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault(), nonce_after)),
        ),
        (
            receipt_account(),
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault(), receipt)),
        ),
    ]))
}

/// Requests a confirmation proof of payout `id` at `at`.
fn request_payout_proof(
    contract: &mut Contract,
    id: u64,
    nonce_after: [u8; 32],
    receipt: [u8; 32],
    at: u64,
) -> ProofRequest {
    env_at(&accounts(4), at);
    contract
        .confirm_sol_payout(
            U64(id),
            anchor(),
            hex::encode(nonce_bytes(vault(), nonce_after)),
            hex::encode(nonce_bytes(vault(), receipt)),
        )
        .detach();
    let (executed, hash, requested_at) = confirmation();
    assert_eq!(requested_at, U64(at / NS));
    assert_eq!(hash, confirmation_hash(nonce_after, receipt));
    assert_eq!(executed, receipt == nonce_after);
    ProofRequest {
        executed,
        hash,
        requested_at,
    }
}

/// Delivers the MPC answer of a confirmation request of action `id` at `at`.
fn answer_proof(contract: &mut Contract, id: u64, request: &ProofRequest, at: u64) -> bool {
    let expected: [u8; 32] = hex::decode(&request.hash).unwrap().try_into().unwrap();
    env_with_results(at, vec![foreign_response(expected)]);
    assert_eq!(
        contract.on_sol_confirmed(
            U64(id),
            request.hash.clone(),
            request.executed,
            request.requested_at
        ),
        request.executed
    );
    request.executed
}

/// Confirms the release of `position_id` as executed (or not); returns what the engine
/// concluded.
fn confirm_redeem(contract: &mut Contract, position_id: u64, executed: bool, at: u64) -> bool {
    let receipt = receipt_after(NONCE_NEXT, executed);
    let landed = prove_release_state(contract, position_id, receipt, at);
    if !landed {
        assert!(contract.get_pending_release(U64(position_id)).is_some());
        let later = at + ts(ANSWER_DELAY + crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS);
        assert!(!prove_release_state(contract, position_id, receipt, later));
    }
    landed
}

/// One confirmation proof of the release of `position_id` with the receipt at `receipt`.
fn prove_release_state(
    contract: &mut Contract,
    position_id: u64,
    receipt: [u8; 32],
    at: u64,
) -> bool {
    let id = contract.get_pending_release(U64(position_id)).unwrap().0;
    env_at(&accounts(4), at);
    contract
        .confirm_sol_redeem(
            U64(position_id),
            anchor(),
            hex::encode(nonce_bytes(vault(), NONCE_NEXT)),
            hex::encode(nonce_bytes(vault(), receipt)),
        )
        .detach();
    let (executed, hash, requested_at) = confirmation();
    assert_eq!(hash, confirmation_hash(NONCE_NEXT, receipt));
    answer_proof(
        contract,
        id,
        &ProofRequest {
            executed,
            hash,
            requested_at,
        },
        at + ts(ANSWER_DELAY),
    )
}

/// Proves `stream` (position `position_id`) at `spec` with `sync_sol_stream` at `at`; returns
/// what the callback booked.
fn sync_stream(
    contract: &mut Contract,
    position_id: u64,
    stream: [u8; 32],
    spec: &StreamSpec,
    at: u64,
) -> bool {
    env_at(&accounts(4), at);
    contract
        .sync_sol_stream(
            U64(position_id),
            anchor(),
            hex::encode(stream_bytes(stream, spec)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(stream, spec)]);
    env_with_results(at + ts(ANSWER_DELAY), vec![foreign_response(hash)]);
    contract.on_sol_stream_synced(
        U64(position_id),
        hex::encode(hash),
        hex::encode(stream_bytes(stream, spec)),
    )
}

/// The stream at the vault after Streamflow's auto-claim: everything withdrawn, closed.
fn swept_spec() -> StreamSpec {
    StreamSpec {
        closed: true,
        ..at_vault(1_000)
    }
}

/// The Streamflow `withdraw` amounts inside a compiled message, in instruction order.
fn withdraw_amounts(message: &[u8]) -> Vec<u64> {
    let keys = usize::from(message[3]);
    let mut cursor = 4 + 32 * keys + 32;
    let count = usize::from(message[cursor]);
    cursor += 1;
    let mut amounts = Vec::new();
    for _ in 0..count {
        cursor += 1;
        let account_count = usize::from(message[cursor]);
        cursor += 1 + account_count;
        let data_len = usize::from(message[cursor]);
        cursor += 1;
        let data = &message[cursor..cursor + data_len];
        if data.len() == 26 && data[..8] == sol::STREAMFLOW_WITHDRAW_DISCRIMINATOR {
            amounts.push(u64::from_le_bytes(data[8..16].try_into().unwrap()));
        }
        cursor += data_len;
    }
    amounts
}

fn claimable(contract: &Contract, at: u64) -> u128 {
    env_at(&accounts(1), at);
    contract.get_claimable(accounts(1), stepped_class_id()).0
}

#[test]
fn solana_deposit_is_attributed_moved_and_registered() {
    let mut contract = bootstrapped();
    assert!(
        contract.get_class(stepped_class_id()).is_none(),
        "the first deposit of a class is attributed before the class exists"
    );
    env(&accounts(1), NearToken::from_yoctonear(0), ts(1_990));
    panics_with("record storage deposit", || {
        contract.attribute_sol_deposit(SolDepositArgs {
            metadata: fmt(&STREAM),
            class_id: stepped_class_id(),
            return_to: fmt(&RETURN_TO),
            anchor_tx: anchor(),
            metadata_data: hex::encode(stream_bytes(STREAM, &sol_spec(deposit_address()))),
            mint_data: hex::encode(mint_bytes(DECIMALS)),
        })
    });
    let args = attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    let record = contract.get_sol_deposit(args.metadata.clone()).unwrap();
    assert_eq!(record.stage, SolDepositStage::Attributed);
    assert_eq!(record.account, accounts(1));
    assert_eq!(record.class_id, stepped_class_id());
    assert_eq!(record.deposit_address, fmt(&deposit_address()));
    assert_eq!(
        record.path,
        format!("dep/{}/{}", accounts(1), args.class_id)
    );
    assert_eq!(
        contract.get_replay(stream_key(STREAM)),
        None,
        "attribution never touches the stream's replay key"
    );

    let id = move_stream(&mut contract, &args.metadata, ts(2_010));
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolMove {
            metadata: args.metadata.clone(),
            from: fmt(&deposit_address()),
            to_owner: vault_sol(),
        }
    );
    assert_eq!(payout.status, PayoutStatus::Signed);
    let solana = payout.solana.unwrap();
    assert_eq!(solana.authority_path, record.path);
    assert!(solana.nonce_account.is_none());
    let message = solana.message.0.clone();
    assert_eq!(message[0], 2, "fee payer and deposit key sign");
    assert_eq!(&message[4..36], &pubkey_of(&gas_sol_key()));
    let transaction = solana.transaction.unwrap().0;
    assert_eq!(transaction[0], 2);
    assert_eq!(
        &transaction[1..65],
        solana.gas_signature.unwrap().0.as_slice(),
        "gas/sol signs first"
    );
    assert_eq!(
        &transaction[65..129],
        solana.authority_signature.unwrap().0.as_slice()
    );
    assert_eq!(&transaction[129..], &message[..]);

    let position_id = register_stream(&mut contract, STREAM, 200, ts(4_000));
    assert_eq!(position_id, 0);
    assert_eq!(
        contract.get_replay(stream_key(STREAM)),
        Some(ReplayState::Consumed)
    );
    let position = contract.get_position(U64(0)).unwrap().position;
    assert_eq!(position.allocation.0, 1_000);
    assert_eq!(position.class_id, stepped_class_id());
    let holding = contract.holding(&Holder::Account(accounts(1)), &stepped_class_id());
    assert_eq!(holding.checkpoint, 3 * ONE / 10, "accrued to f(4,000 s)");
    assert_eq!(
        holding.claimable, 100,
        "unlocked 300 at 4,000 s minus the 200 withdrawn"
    );
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_eq!(stream.escrow_tokens, fmt(&escrow_of(STREAM)));
    assert_eq!(stream.partner_tokens, fmt(&PARTNER_TOKENS));
    assert_eq!(stream.streamflow_treasury_tokens, fmt(&TREASURY_TOKENS));
    assert_eq!(stream.engine_withdrawn.0, 200);
    assert_eq!(stream.drawing, None);
    assert!(matches!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::Registered { .. }
    ));

    env(&accounts(5), RECORD_STORAGE_DEPOSIT, ts(4_010));
    panics_with("not awaiting registration", || {
        contract.register_sol_deposit(args.metadata.clone(), anchor(), String::new())
    });
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(4_010));
    panics_with("already moved, registered", || {
        contract.attribute_sol_deposit(args.clone())
    });
}

#[test]
fn ineligible_streams_are_refused_at_the_deposit_address_and_returnable() {
    for (spec, reason) in [
        (
            StreamSpec {
                can_topup: true,
                ..sol_spec(deposit_address())
            },
            "CanTopup",
        ),
        (
            StreamSpec {
                transferable_by_recipient: false,
                ..sol_spec(deposit_address())
            },
            "NotTransferableByRecipient",
        ),
        (
            StreamSpec {
                automatic_withdrawal: true,
                ..sol_spec(deposit_address())
            },
            "AutomaticWithdrawal",
        ),
        (
            StreamSpec {
                partner_fee_percent: 0.25f32.to_bits(),
                ..sol_spec(deposit_address())
            },
            "Fees",
        ),
        (
            StreamSpec {
                net_amount_deposited: 99,
                amount_per_period: 9,
                end_time: 12_000,
                ..sol_spec(deposit_address())
            },
            "less than one whole token",
        ),
    ] {
        let mut contract = bootstrapped();
        let args = attribute_stream(&mut contract, STREAM, &spec);
        assert_eq!(
            contract.get_sol_deposit(args.metadata).unwrap().stage,
            SolDepositStage::Refused
        );
        let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
        assert!(
            refused.reason.contains(reason),
            "{} is refused for {reason}",
            refused.reason
        );
    }

    let mut contract = bootstrapped();
    let spec = StreamSpec {
        can_topup: true,
        ..sol_spec(deposit_address())
    };
    let args = attribute_stream(&mut contract, STREAM, &spec);
    let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
    let RefusedAsset::SolStream {
        held_by,
        held_by_path,
        ..
    } = &refused.asset
    else {
        panic!("a Solana stream");
    };
    assert_eq!(held_by, &fmt(&deposit_address()));
    payout_env(&accounts(5), ts(2_020));
    panics_with("recent blockhash is required", || {
        contract.return_refused_deposit(stream_key(STREAM), None)
    });
    payout_env(&accounts(5), ts(2_021));
    contract
        .return_refused_deposit(stream_key(STREAM), Some(fmt(&[1u8; 32])))
        .detach();
    let payout = contract.get_payout(U64(0)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolReturn {
            metadata: args.metadata.clone(),
            from: fmt(&deposit_address()),
            to_owner: fmt(&RETURN_TO),
        }
    );
    assert_eq!(&payout.solana.unwrap().authority_path, held_by_path);
    payout_env(&accounts(5), ts(2_022));
    panics_with("already signed or in flight", || {
        contract.return_refused_deposit(stream_key(STREAM), Some(fmt(&[2u8; 32])))
    });
    let message = message_of(&contract, 0);
    env_with_results(
        ts(2_025),
        vec![
            ed_signature(&deposit_key(), &message),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    assert!(contract.on_sol_signed(U64(0)));
    payout_env(&accounts(5), ts(2_200));
    contract
        .return_refused_deposit(stream_key(STREAM), Some(fmt(&[2u8; 32])))
        .detach();
    assert_eq!(
        contract
            .get_refused_deposit(stream_key(STREAM))
            .unwrap()
            .return_payout,
        Some(U64(1)),
        "a Solana return may be signed again once the last one is signed (its blockhash may have expired)"
    );
    payout_env(&accounts(5), ts(2_201));
    panics_with("not awaiting its move", || {
        contract.move_sol_deposit(args.metadata.clone(), fmt(&[1u8; 32]))
    });

    // The sender later gives up its top-up permission: the stream becomes eligible and its
    // re-attribution drops the stale refusal (a deposit-key return cannot move a stream that
    // reached the vault).
    attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    assert!(contract.get_refused_deposit(stream_key(STREAM)).is_none());
    assert_eq!(
        contract.get_sol_deposit(fmt(&STREAM)).unwrap().stage,
        SolDepositStage::Attributed
    );
}

#[test]
fn a_premature_registration_records_nothing_and_no_one_keeps_both_units_and_stream() {
    let mut contract = bootstrapped();
    let args = attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    // Registration requested while the stream still sits at the deposit address.
    let still_at_deposit = sol_spec(deposit_address());
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), stepped_class_id())
            .0,
    );
    env(&accounts(3), deposit, ts(2_050));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(STREAM, &still_at_deposit)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(STREAM, &still_at_deposit)]);
    env_with_results(ts(2_057), vec![foreign_response(hash)]);
    assert!(!contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &still_at_deposit)),
        accounts(3),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(contract.get_replay(stream_key(STREAM)), None, "key cleared");
    assert!(
        contract.get_refused_deposit(stream_key(STREAM)).is_none(),
        "no vault-held refusal for a stream that is not at the vault"
    );
    assert_eq!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::Attributed
    );
    assert_eq!(transferred_to(&accounts(3)), deposit.as_yoctonear());
    payout_env(&accounts(3), ts(2_060));
    panics_with("No refused deposit", || {
        contract.return_refused_deposit(stream_key(STREAM), Some(fmt(&[1u8; 32])))
    });

    // The normal path still works: move, registration at the vault, units minted once.
    move_stream(&mut contract, &args.metadata, ts(2_100));
    let position_id = register_stream(&mut contract, STREAM, 0, ts(2_200));
    assert_eq!(
        contract.mt_balance_of(accounts(1), stepped_class_id()).0,
        1_000
    );
    assert!(contract.get_refused_deposit(stream_key(STREAM)).is_none());
    payout_env(&accounts(3), ts(2_300));
    panics_with("No refused deposit", || {
        contract.return_refused_deposit(stream_key(STREAM), Some(fmt(&[1u8; 32])))
    });
    assert_eq!(
        contract
            .get_position(U64(position_id))
            .unwrap()
            .position
            .state,
        PositionState::Held
    );
}

#[test]
fn a_stream_refused_at_the_vault_is_never_attributed_again() {
    let mut contract = bootstrapped();
    let args = attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args.metadata, ts(2_100));
    // At the vault, but its mint is not the attributed one: refused, held by the vault.
    let other_mint = StreamSpec {
        mint: [19u8; 32],
        ..at_vault(0)
    };
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), stepped_class_id())
            .0,
    );
    env(&accounts(5), deposit, ts(2_200));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(STREAM, &other_mint)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(STREAM, &other_mint)]);
    env_with_results(ts(2_207), vec![foreign_response(hash)]);
    assert!(!contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &other_mint)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
    assert!(matches!(
        &refused.asset,
        RefusedAsset::SolStream { held_by, .. } if held_by == &vault_sol()
    ));
    assert_eq!(
        contract.get_replay(stream_key(STREAM)),
        Some(ReplayState::Consumed)
    );
    assert_eq!(
        transferred_to(&accounts(5)),
        deposit.as_yoctonear() - RECORD_STORAGE_DEPOSIT.as_yoctonear()
    );

    // Returned to its owner, then sent to a deposit address again: never attributed again, so
    // a vault-signed return can never meet a registered position.
    payout_env(&accounts(5), ts(2_300));
    contract
        .return_refused_deposit(stream_key(STREAM), Some(fmt(&[1u8; 32])))
        .detach();
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(2_400));
    panics_with("refused at the vault", || {
        contract.attribute_sol_deposit(args.clone())
    });
}

#[test]
fn attribution_callbacks_recheck_the_stage_and_never_touch_replay_keys() {
    let mut contract = bootstrapped();
    let args = attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    let path = contract.deposit_path_of(accounts(1), args.class_id.clone());
    let late_hash = sol_hash(vec![
        metadata_account(STREAM, &sol_spec(deposit_address())),
        (MINT, sol_account(TOKEN_PROGRAM, mint_bytes(DECIMALS))),
    ]);

    // Still `Attributed`, a registration in flight: a late attribution callback leaves both the
    // record and the pending key alone.
    let at_deposit = sol_spec(deposit_address());
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), stepped_class_id())
            .0,
    );
    env(&accounts(5), deposit, ts(2_050));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(STREAM, &at_deposit)),
        )
        .detach();
    env_with_results(ts(2_051), vec![foreign_response(late_hash)]);
    assert!(!contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path.clone(),
        fmt(&deposit_address()),
        hex::encode(late_hash),
    ));
    assert!(matches!(
        contract.get_replay(stream_key(STREAM)),
        Some(ReplayState::Pending { .. })
    ));
    let premature = sol_hash(vec![metadata_account(STREAM, &at_deposit)]);
    env_with_results(ts(2_057), vec![foreign_response(premature)]);
    assert!(!contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(premature),
        hex::encode(stream_bytes(STREAM, &at_deposit)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    assert_eq!(contract.get_replay(stream_key(STREAM)), None);
    move_stream(&mut contract, &args.metadata, ts(2_100));

    // A registration is in flight when a late attribution callback arrives.
    let spec = at_vault(0);
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), stepped_class_id())
            .0,
    );
    env(&accounts(5), deposit, ts(2_200));
    contract
        .register_sol_deposit(
            args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(STREAM, &spec)),
        )
        .detach();
    env_with_results(ts(2_201), vec![foreign_response(late_hash)]);
    assert!(!contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path.clone(),
        fmt(&deposit_address()),
        hex::encode(late_hash),
    ));
    assert!(matches!(
        contract.get_replay(stream_key(STREAM)),
        Some(ReplayState::Pending { .. })
    ));
    assert!(matches!(
        contract
            .get_sol_deposit(args.metadata.clone())
            .unwrap()
            .stage,
        SolDepositStage::MoveSigned { .. }
    ));

    let hash = sol_hash(vec![metadata_account(STREAM, &spec)]);
    env_with_results(ts(2_207), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &spec)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));

    // Another late attribution callback after the registration changes nothing.
    env_with_results(ts(2_300), vec![foreign_response(late_hash)]);
    assert!(!contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path,
        fmt(&deposit_address()),
        hex::encode(late_hash),
    ));
    assert_eq!(
        contract.get_replay(stream_key(STREAM)),
        Some(ReplayState::Consumed)
    );
    assert!(matches!(
        contract.get_sol_deposit(args.metadata).unwrap().stage,
        SolDepositStage::Registered { .. }
    ));

    // A duplicate registration callback is refunded and mints nothing.
    env_with_results(ts(2_310), vec![foreign_response(hash)]);
    assert!(!contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &spec)),
        accounts(2),
        U128(7),
    ));
    assert_eq!(transferred_to(&accounts(2)), 7);
    assert_eq!(
        contract.mt_balance_of(accounts(1), stepped_class_id()).0,
        1_000
    );
}

#[test]
fn a_payout_draws_on_named_streams_and_lands_once_confirmed() {
    let (mut contract, class) = solana_holder();
    assert_eq!(claimable(&contract, ts(4_000)), 300);
    let streams = contract.get_sol_streams(class.clone());
    assert_eq!(streams.len(), 1);
    assert_eq!(streams[0].withdrawable, U128(300));

    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert_eq!(claimable(&contract, ts(4_000)), 0);
    assert!(matches!(
        contract.get_replay(nonce_key(NONCE_VALUE)),
        Some(ReplayState::Pending { .. })
    ));
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(
        payout.kind,
        PayoutKind::SolTransfer {
            mint: fmt(&MINT),
            to_owner: fmt(&RETURN_TO),
            amount: U128(300)
        }
    );
    let solana = payout.solana.unwrap();
    assert_eq!(solana.draws.len(), 1);
    assert_eq!(solana.draws[0].amount, U128(300));
    assert_eq!(solana.draws[0].expected_withdrawn, U128(300));
    let message = solana.message.0.clone();
    assert_eq!(withdraw_amounts(&message), vec![300]);
    let keys = usize::from(message[3]);
    let account_keys: Vec<&[u8]> = (0..keys)
        .map(|i| &message[4 + 32 * i..36 + 32 * i])
        .collect();
    assert_eq!(
        &message[4 + 32 * keys..4 + 32 * keys + 32],
        &NONCE_VALUE,
        "durable nonce as blockhash"
    );
    for (key, what) in [
        (recipient_tokens(), "the recipient's existing token account"),
        (
            PARTNER_TOKENS,
            "the partner token account the metadata names",
        ),
        (
            TREASURY_TOKENS,
            "the treasury token account the metadata names",
        ),
        (escrow_of(STREAM), "the stream's escrow"),
    ] {
        assert!(account_keys.contains(&&key[..]), "the message uses {what}");
    }
    assert!(
        !message
            .windows(32)
            .any(|window| window == sol::ASSOCIATED_TOKEN_PROGRAM),
        "no account creation: the fee payer only pays fees"
    );
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_eq!(
        stream.engine_withdrawn.0, 0,
        "nothing counts before landing"
    );
    assert_eq!(stream.drawing, Some(U64(id)));
    assert_eq!(stream.pending_withdraw.0, 300);
    assert_eq!(
        contract.get_sol_streams(class.clone())[0].withdrawable,
        U128(0)
    );

    prove(&mut contract, id, NONCE_VALUE, ts(4_005));
    assert_eq!(
        contract.get_replay(nonce_key(NONCE_VALUE)),
        Some(ReplayState::Consumed)
    );
    assert!(sign(&mut contract, id, ts(4_010)));
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(payout.status, PayoutStatus::Signed);
    assert!(payout.solana.unwrap().transaction.is_some());
    env(&accounts(1), one_yocto(), ts(4_011));
    panics_with("custody actions in flight", || {
        contract.storage_withdraw(None)
    });

    // Not broadcast yet: the nonce still holds the signed value.
    env_at(&accounts(4), ts(4_020));
    panics_with("nonce has not advanced", || {
        contract.confirm_sol_payout(
            U64(id),
            anchor(),
            hex::encode(nonce_bytes(vault(), NONCE_VALUE)),
            hex::encode(nonce_bytes(vault(), NONCE_VALUE)),
        )
    });
    env_at(&accounts(4), ts(4_020));
    panics_with("Invalid receipt nonce account", || {
        contract.confirm_sol_payout(
            U64(id),
            anchor(),
            hex::encode(nonce_bytes(vault(), NONCE_NEXT)),
            hex::encode(nonce_bytes(RETURN_TO, NONCE_NEXT)),
        )
    });
    // A mismatched attestation changes nothing.
    env_with_results(ts(4_030), vec![foreign_response([7u8; 32])]);
    assert!(!contract.on_sol_confirmed(U64(id), hex::encode([8u8; 32]), true, U64(4_100)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );

    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_040)
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Landed
    );
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_eq!(stream.engine_withdrawn.0, 300);
    assert_eq!(stream.drawing, None);
    assert_eq!(stream.pending_withdraw.0, 0);
    env(&accounts(1), one_yocto(), ts(4_100));
    contract.storage_withdraw(None);
    assert!(events("rose").iter().any(|e| e["event"] == "payout_landed"));

    // A landed payout cannot be confirmed again, and the next claim can draw on the stream.
    env_at(&accounts(4), ts(4_200));
    panics_with("not awaiting confirmation", || {
        contract.confirm_sol_payout(
            U64(id),
            anchor(),
            hex::encode(nonce_bytes(vault(), NONCE_NEXT)),
            hex::encode(nonce_bytes(vault(), NONCE_NEXT)),
        )
    });
    assert_eq!(claimable(&contract, ts(6_000)), 200);
    let next = claim(
        &mut contract,
        &class,
        vec![draw(0, 200)],
        NONCE_NEXT,
        ts(6_000),
    );
    assert_eq!(
        contract
            .get_payout(U64(next))
            .unwrap()
            .solana
            .unwrap()
            .draws[0]
            .expected_withdrawn,
        U128(500)
    );
}

#[test]
fn a_payout_whose_transaction_failed_on_chain_is_refunded() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    // The nonce advanced (the failed transaction still consumed it) but the receipt did not.
    assert!(!confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        false,
        ts(4_100)
    ));
    assert!(matches!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(
        claimable(&contract, ts(4_100)),
        300,
        "the claim is refunded"
    );
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_eq!(stream.engine_withdrawn.0, 0);
    assert_eq!(stream.drawing, None);
    assert_eq!(
        contract.get_sol_streams(class.clone())[0].withdrawable,
        U128(300)
    );
    env(&accounts(1), one_yocto(), ts(4_200));
    contract.storage_withdraw(None);
    let again = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_NEXT,
        ts(4_300),
    );
    assert_eq!(
        contract.get_payout(U64(again)).unwrap().status,
        PayoutStatus::Signed
    );
}

#[test]
fn draws_are_checked_against_the_class_the_stream_and_its_unconfirmed_payout() {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    let args2 = attribute_stream(&mut contract, STREAM_2, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args2.metadata, ts(2_150));
    register_stream(&mut contract, STREAM_2, 200, ts(3_000));
    let class = stepped_class_id();
    // A second class of the same mint: another schedule.
    let other_spec = StreamSpec {
        amount_per_period: 50,
        end_time: 21_000,
        ..sol_spec(deposit_address())
    };
    let other_stream = [44u8; 32];
    let other_args = attribute_stream(&mut contract, other_stream, &other_spec);
    move_stream(&mut contract, &other_args.metadata, ts(2_160));
    let other_vault = StreamSpec {
        amount_per_period: 50,
        end_time: 21_000,
        ..at_vault(0)
    };
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), other_args.class_id.clone())
            .0,
    );
    env(&accounts(5), deposit, ts(3_100));
    contract
        .register_sol_deposit(
            other_args.metadata.clone(),
            anchor(),
            hex::encode(stream_bytes(other_stream, &other_vault)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(other_stream, &other_vault)]);
    env_with_results(ts(3_107), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(other_stream),
        hex::encode(hash),
        hex::encode(stream_bytes(other_stream, &other_vault)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    let other_class = contract.get_position(U64(2)).unwrap().position.class_id;
    assert_ne!(other_class, class);

    // At 6,000 s stream 0 can pay 500 and stream 1 (200 withdrawn before its deposit) 300.
    let at = ts(6_000);
    let checks: Vec<(Vec<SolDrawArgs>, &str)> = vec![
        (vec![], "at least one stream"),
        (vec![draw(2, 100)], "not a stream of the claimed class"),
        (vec![draw(0, 100), draw(0, 100)], "named twice"),
        (vec![draw(0, 501)], "between 1 and 500"),
        (vec![draw(0, 0)], "between 1 and 500"),
        (vec![draw(9, 100)], "Unknown position"),
        (vec![draw(0, 50)], "at least one whole token"),
    ];
    for (draws, expected) in checks {
        payout_env(&accounts(1), at);
        panics_with(expected, || {
            contract.claim_sol_tokens(
                holding(&class),
                draws,
                None,
                fmt(&RETURN_TO),
                proof(NONCE_VALUE),
            )
        });
    }
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 450), draw(1, 300)],
        NONCE_VALUE,
        at,
    );
    assert_eq!(withdraw_amounts(&message_of(&contract, id)), vec![450, 300]);
    payout_env(&accounts(1), at);
    panics_with("unconfirmed payout", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(0, 50)],
            None,
            fmt(&RETURN_TO),
            proof(NONCE_NEXT),
        )
    });
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(6_010)
    ));
    // Less than a whole token only when the draw empties the stream.
    payout_env(&accounts(1), ts(6_020));
    panics_with("unless it empties", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(0, 50)],
            None,
            fmt(&RETURN_TO),
            proof(NONCE_NEXT),
        )
    });
    let most = claim(
        &mut contract,
        &class,
        vec![draw(0, 450)],
        NONCE_NEXT,
        ts(10_600),
    );
    assert!(confirm_payout(
        &mut contract,
        most,
        [15u8; 32],
        true,
        ts(10_610)
    ));
    // From five minutes before its end a stream takes no draw: Streamflow's auto-claim empties
    // it one second after the end, and its last tranche is paid from the swept balance.
    payout_env(&accounts(1), ts(10_700));
    panics_with("ends within five minutes", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(0, 100)],
            None,
            fmt(&RETURN_TO),
            proof([15u8; 32]),
        )
    });
    env_at(&accounts(1), ts(10_700));
    assert_eq!(
        contract
            .get_sol_streams(class.clone())
            .iter()
            .find(|s| s.position_id == U64(0))
            .unwrap()
            .withdrawable,
        U128(0)
    );
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_010)
    ));
    assert!(
        contract
            .get_sol_streams(class.clone())
            .iter()
            .all(|s| s.position_id != U64(0)),
        "a fully withdrawn stream is pruned"
    );

    // The other class's stream never served this class.
    assert_eq!(
        contract.get_sol_stream(U64(2)).unwrap().engine_withdrawn.0,
        0
    );
    assert_eq!(contract.get_sol_streams(other_class).len(), 1);
}

#[test]
fn the_recipient_token_account_must_exist_for_the_mint_and_owner() {
    let (mut contract, class) = solana_holder();
    for (data, expected) in [
        (token_bytes([1u8; 32], RETURN_TO, 1), "TokenMint"),
        (token_bytes(MINT, [2u8; 32], 1), "TokenOwner"),
        (token_bytes(MINT, RETURN_TO, 2), "TokenState"),
        (token_bytes(MINT, RETURN_TO, 0), "TokenState"),
        (vec![0u8; 80], "TokenLength"),
    ] {
        payout_env(&accounts(1), ts(4_000));
        panics_with(expected, || {
            contract.claim_sol_tokens(
                holding(&class),
                vec![draw(0, 300)],
                None,
                fmt(&RETURN_TO),
                SolNonceProof {
                    recipient_tokens_data: hex::encode(&data),
                    ..proof(NONCE_VALUE)
                },
            )
        });
    }
    payout_env(&accounts(1), ts(4_000));
    panics_with("Invalid nonce account", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(0, 300)],
            None,
            fmt(&RETURN_TO),
            SolNonceProof {
                data: hex::encode(nonce_bytes([1u8; 32], NONCE_VALUE)),
                ..proof(NONCE_VALUE)
            },
        )
    });
    // The account is attested together with the nonce: another owner program fails the proof.
    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    let wrong = sol_hash(vec![
        (
            nonce_account(),
            sol_account(SYSTEM_PROGRAM, nonce_bytes(vault(), NONCE_VALUE)),
        ),
        (
            recipient_tokens(),
            sol_account(SYSTEM_PROGRAM, token_bytes(MINT, RETURN_TO, 1)),
        ),
    ]);
    env_with_results(ts(4_005), vec![foreign_response(wrong)]);
    assert!(matches!(
        contract.on_sol_nonce_verified(
            U64(id),
            hex::encode(proof_hash(NONCE_VALUE)),
            nonce_key(NONCE_VALUE)
        ),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(
        claimable(&contract, ts(4_005)),
        300,
        "refunded: nothing was signed"
    );
    assert_eq!(contract.get_replay(nonce_key(NONCE_VALUE)), None);
    assert_eq!(contract.get_sol_stream(U64(0)).unwrap().drawing, None);
}

#[test]
fn a_redeem_waits_for_unconfirmed_payouts_and_pays_the_unwithdrawn_tokens() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    // Signed, not broadcast: the stream cannot leave the vault until the payout is settled.
    payout_env(&accounts(1), ts(4_100));
    panics_with("not confirmed yet", || {
        contract.redeem(U64(0), fmt(&RETURN_TO), Some(proof(NONCE_NEXT)))
    });
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_200),
    ));

    // At 6,000 s the stream holds 200 unlocked tokens not withdrawn; the holder has 200
    // claimable: it pays them, since they leave with the stream.
    let nonce_3 = [15u8; 32];
    assert_eq!(claimable(&contract, ts(6_000)), 200);
    payout_env(&accounts(1), ts(6_000));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof(nonce_3)))
        .detach();
    let release = contract.payouts_total().0 - 1;
    assert_eq!(
        claimable(&contract, ts(6_000)),
        0,
        "paid the 200 unwithdrawn tokens"
    );
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 0);
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Releasing
    );
    let payout = contract.get_payout(U64(release)).unwrap();
    assert_eq!(
        payout.debit,
        PayoutDebit::Units {
            position_id: U64(0),
            class_id: class.clone(),
            account: accounts(1),
            units: U128(1_000),
            f_burned: U128(5 * ONE / 10),
            claimable: U128(200),
        }
    );
    let message = payout.solana.unwrap().message.0;
    assert_eq!(withdraw_amounts(&message), Vec::<u64>::new(), "no withdraw");
    let keys = usize::from(message[3]);
    assert_eq!(
        message[4 + 32 * keys + 32],
        3,
        "AdvanceNonceAccount, transfer_recipient and the receipt's AdvanceNonceAccount only"
    );

    // Payouts never draw on a releasing stream.
    payout_env(&accounts(1), ts(6_000));
    panics_with("not held", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(0, 100)],
            None,
            fmt(&RETURN_TO),
            proof([16u8; 32]),
        )
    });
    prove_value(&mut contract, release, nonce_3, ts(6_005));
    assert!(sign(&mut contract, release, ts(6_010)));
    assert_eq!(
        contract.get_payout(U64(release)).unwrap().status,
        PayoutStatus::Signed
    );
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Releasing,
        "signed is not final on Solana"
    );

    // The release executed: its receipt moved with the nonce.
    assert!(confirm_redeem(&mut contract, 0, true, ts(6_100)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
    assert_eq!(
        contract.get_payout(U64(release)).unwrap().status,
        PayoutStatus::Landed
    );
    assert!(contract.get_sol_streams(class.clone()).is_empty());
    assert_eq!(contract.mt_balance_of(accounts(1), class).0, 0);
}

#[test]
fn a_redeem_needs_the_streams_unwithdrawn_tokens_in_claimable() {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    let args2 = attribute_stream(&mut contract, STREAM_2, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args2.metadata, ts(2_150));
    register_stream(&mut contract, STREAM_2, 0, ts(2_200));
    let class = stepped_class_id();
    register(&mut contract, &accounts(2), ts(2_300));
    env(&accounts(1), one_yocto(), ts(2_300));
    contract.mt_transfer(accounts(2), class.clone(), U128(1_000), None, None);
    // The holder of position 0's units claims through the other stream: stream 0 still holds
    // its 300 unlocked tokens, which the holder no longer has as claimable.
    assert_eq!(claimable(&contract, ts(4_000)), 400);
    let id = claim(
        &mut contract,
        &class,
        vec![draw(1, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_050),
    ));
    payout_env(&accounts(1), ts(4_100));
    panics_with("takes 300 claimable tokens", || {
        contract.redeem(U64(0), fmt(&RETURN_TO), Some(proof([15u8; 32])))
    });
    assert_eq!(
        contract.mt_balance_of(accounts(1), class).0,
        1_000,
        "nothing burned"
    );
}

#[test]
fn a_redeem_is_never_blocked_by_the_class_fractions_rounding_dust() {
    // One whole token is one base unit; a third of the stream unlocks per period, which the
    // class fraction can only approach from below: the token unlocked in the first period is
    // dust no unit can claim, and must not have to be paid to redeem.
    let mut contract = bootstrapped();
    let spec = StreamSpec {
        start_time: 1_000,
        period: 1_000,
        amount_per_period: 1,
        net_amount_deposited: 3,
        end_time: 4_000,
        ..sol_spec(deposit_address())
    };
    let class_id = contract
        .compute_sol_class_id(
            fmt(&MINT),
            0,
            crate::custody::StreamflowScheduleArgs {
                start_time: 1_000,
                cliff: 0,
                cliff_amount: U64(0),
                period: 1_000,
                amount_per_period: U64(1),
                net_amount_deposited: U64(3),
                end_time: 4_000,
            },
        )
        .unwrap();
    let args = SolDepositArgs {
        metadata: fmt(&STREAM),
        class_id: class_id.clone(),
        return_to: fmt(&RETURN_TO),
        anchor_tx: anchor(),
        metadata_data: hex::encode(stream_bytes(STREAM, &spec)),
        mint_data: hex::encode(mint_bytes(0)),
    };
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(300));
    contract.attribute_sol_deposit(args.clone()).detach();
    let path = contract.deposit_path_of(accounts(1), class_id.clone());
    env_with_results(
        ts(301),
        vec![json(&format!("ed25519:{}", fmt(&deposit_address())))],
    );
    drop(contract.on_sol_deposit_key(args.clone(), accounts(1), path.clone()));
    let hash = sol_hash(vec![
        metadata_account(STREAM, &spec),
        (MINT, sol_account(TOKEN_PROGRAM, mint_bytes(0))),
    ]);
    env_with_results(ts(308), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_attested(
        args.clone(),
        accounts(1),
        path,
        fmt(&deposit_address()),
        hex::encode(hash),
    ));
    move_stream(&mut contract, &args.metadata, ts(600));
    let vault_spec = StreamSpec {
        recipient: vault(),
        ..spec
    };
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), class_id.clone())
            .0,
    );
    env(&accounts(5), deposit, ts(700));
    contract
        .register_sol_deposit(
            fmt(&STREAM),
            anchor(),
            hex::encode(stream_bytes(STREAM, &vault_spec)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(STREAM, &vault_spec)]);
    env_with_results(ts(707), vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(STREAM),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &vault_spec)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));

    env_at(&accounts(1), ts(2_500));
    let claimable = contract.get_claimable(accounts(1), class_id.clone()).0;
    let state = contract.get_sol_streams(class_id.clone())[0].clone();
    assert_eq!(state.withdrawable, U128(1), "one token unlocked");
    assert!(claimable < 1, "the class fraction rounds the third down");
    assert_eq!(state.redeem_claimable, U128(claimable));
    payout_env(&accounts(1), ts(2_500));
    contract
        .redeem(
            U64(0),
            fmt(&RETURN_TO),
            Some(SolNonceProof {
                recipient_tokens_data: hex::encode(token_bytes(MINT, RETURN_TO, 1)),
                ..proof(NONCE_VALUE)
            }),
        )
        .detach();
    let release = contract.payouts_total().0 - 1;
    assert!(matches!(
        contract.get_payout(U64(release)).unwrap().debit,
        PayoutDebit::Units {
            claimable: U128(0),
            ..
        }
    ));
}

/// Delivers the matching proof of a redeem with nonce `value`.
fn prove_value(contract: &mut Contract, id: u64, value: [u8; 32], at: u64) {
    prove(contract, id, value, at);
}

#[test]
fn a_release_that_did_not_execute_gives_back_the_units_and_the_claimable_tokens() {
    let (mut contract, class) = solana_holder();
    assert_eq!(claimable(&contract, ts(4_000)), 300);
    payout_env(&accounts(1), ts(4_000));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof(NONCE_VALUE)))
        .detach();
    let release = contract.payouts_total().0 - 1;
    prove(&mut contract, release, NONCE_VALUE, ts(4_005));
    assert!(sign(&mut contract, release, ts(4_010)));
    assert_eq!(claimable(&contract, ts(4_010)), 0);

    // The nonce advanced but the receipt did not: not executed.
    assert!(!confirm_redeem(&mut contract, 0, false, ts(5_000)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Held
    );
    assert_eq!(contract.get_pending_release(U64(0)), None);
    assert!(matches!(
        contract.get_payout(U64(release)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 1_000);
    assert_eq!(
        claimable(&contract, ts(5_000)),
        400,
        "the 300 paid back, plus the accrual since the burn (the stream kept unlocking at the vault)"
    );
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 400)],
        NONCE_NEXT,
        ts(5_000),
    );
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
}

#[test]
fn a_release_that_executed_and_came_back_after_withdrawals_stays_final() {
    let (mut contract, _) = solana_holder();
    payout_env(&accounts(1), ts(4_000));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof(NONCE_VALUE)))
        .detach();
    let release = contract.payouts_total().0 - 1;
    prove(&mut contract, release, NONCE_VALUE, ts(4_005));
    assert!(sign(&mut contract, release, ts(4_010)));
    // The new owner withdrew the unlocked tokens and transferred the stream back to the vault:
    // the stream reads as registered again, but the receipt moved, so the release executed.
    assert!(confirm_redeem(&mut contract, 0, true, ts(5_000)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
}

#[test]
fn starved_and_retried_solana_payouts_resolve_and_are_never_refunded_after_a_retry() {
    let (mut contract, class) = solana_holder();
    // The proof callback never runs: after the expiry the request is abandoned and refunded.
    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    env_at(&accounts(4), ts(4_000 + crate::PENDING_EXPIRY_BLOCKS - 1));
    panics_with("still in flight", || contract.retry_sol_payout(U64(id)));
    env_at(&accounts(4), ts(4_000 + crate::PENDING_EXPIRY_BLOCKS));
    assert!(contract.retry_sol_payout(U64(id)).is_none());
    assert!(matches!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(contract.get_replay(nonce_key(NONCE_VALUE)), None);
    assert_eq!(contract.get_sol_stream(U64(0)).unwrap().drawing, None);
    // Its late callback changes nothing.
    let hash = proof_hash(NONCE_VALUE);
    env_with_results(ts(4_700), vec![foreign_response(hash)]);
    assert!(matches!(
        contract.on_sol_nonce_verified(U64(id), hex::encode(hash), nonce_key(NONCE_VALUE)),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(contract.get_replay(nonce_key(NONCE_VALUE)), None);

    // The signature callback never runs: the same message is signed again, and from then on a
    // failure no longer refunds.
    let at = ts(5_000);
    let id = request_claim(&mut contract, &class, vec![draw(0, 400)], NONCE_VALUE, at);
    prove(&mut contract, id, NONCE_VALUE, at + 5 * NS);
    let first_message = message_of(&contract, id);
    env_at(&accounts(4), at + 5 * NS + ts(crate::PENDING_EXPIRY_BLOCKS));
    assert!(contract.retry_sol_payout(U64(id)).is_some());
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(payout.sign_requests, 2);
    assert_eq!(payout.solana.unwrap().message.0, first_message);
    env_with_results(
        ts(5_700),
        vec![PromiseResult::Failed, PromiseResult::Failed],
    );
    assert!(!contract.on_sol_signed(U64(id)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Requested
    );
    assert_eq!(
        claimable(&contract, ts(5_700)),
        0,
        "not refunded after a retry"
    );
    assert!(sign(&mut contract, id, ts(5_710)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );

    // A move whose signature callback starved is marked failed; the move can be signed again.
    let mut contract = bootstrapped();
    let args = attribute_stream(&mut contract, STREAM, &sol_spec(deposit_address()));
    payout_env(&accounts(5), ts(2_100));
    contract
        .move_sol_deposit(args.metadata.clone(), fmt(&[1u8; 32]))
        .detach();
    env_at(&accounts(4), ts(2_100 + crate::PENDING_EXPIRY_BLOCKS));
    assert!(contract.retry_sol_payout(U64(0)).is_none());
    assert!(matches!(
        contract.get_payout(U64(0)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    move_stream(&mut contract, &args.metadata, ts(2_800));
}

#[test]
fn unreadable_solana_signatures_are_recovered_by_verified_submissions() {
    let (mut contract, class) = solana_holder();
    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    env_at(&accounts(4), ts(4_001));
    panics_with("not awaiting a signature", || {
        contract.submit_sol_signature(U64(id), "vault/sol".into(), hex::encode([0u8; 64]))
    });
    prove(&mut contract, id, NONCE_VALUE, ts(4_005));
    let message = message_of(&contract, id);
    env_with_results(
        ts(4_010),
        vec![
            PromiseResult::Successful(br#"{"scheme":"Ed25519"}"#.to_vec()),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    assert!(!contract.on_sol_signed(U64(id)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Requested,
        "never refunded on a response it cannot read"
    );
    assert_eq!(claimable(&contract, ts(4_010)), 0);

    use ed25519_dalek::Signer;
    let forged = super::custody::ed_key(0x77).sign(&message).to_bytes();
    env_at(&accounts(4), ts(4_020));
    panics_with("does not verify", || {
        contract.submit_sol_signature(U64(id), "vault/sol".into(), hex::encode(forged))
    });
    panics_with("neither the authority path", || {
        contract.submit_sol_signature(U64(id), "dep/x".into(), hex::encode(forged))
    });
    let genuine = vault_sol_key().sign(&message).to_bytes();
    contract.submit_sol_signature(U64(id), "vault/sol".into(), hex::encode(genuine));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );

    // A payout signed by the vault only awaits its fee payer, also completed by submission.
    let mut contract = solana_holder().0;
    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    prove(&mut contract, id, NONCE_VALUE, ts(4_005));
    let message = message_of(&contract, id);
    env_with_results(
        ts(4_010),
        vec![
            ed_signature(&vault_sol_key(), &message),
            PromiseResult::Failed,
        ],
    );
    assert!(!contract.on_sol_signed(U64(id)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::AwaitingGasSignature
    );
    env_at(&accounts(4), ts(4_020));
    contract.submit_sol_signature(
        U64(id),
        "gas/sol".into(),
        hex::encode(gas_sol_key().sign(&message).to_bytes()),
    );
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
}

/// A claim whose authority signature request failed: returns its id, cancelled.
fn failed_claim(contract: &mut Contract, class: &str) -> u64 {
    let id = request_claim(contract, class, vec![draw(0, 300)], NONCE_VALUE, ts(4_000));
    prove(contract, id, NONCE_VALUE, ts(4_005));
    let original = message_of(contract, id);
    env_with_results(
        ts(4_010),
        vec![
            PromiseResult::Failed,
            ed_signature(&gas_sol_key(), &original),
        ],
    );
    assert!(!contract.on_sol_signed(U64(id)));
    id
}

#[test]
fn a_failed_authority_signature_cancels_the_payout_by_burning_its_nonce() {
    let (mut contract, class) = solana_holder();
    let id = failed_claim(&mut contract, &class);
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(
        payout.status,
        PayoutStatus::Requested,
        "never refunded on a failure: a late signature of the original could still surface"
    );
    let solana = payout.solana.unwrap();
    assert!(solana.cancel);
    assert!(solana.authority_signature.is_none() && solana.gas_signature.is_none());
    let burn = solana.message.0;
    let keys = usize::from(burn[3]);
    assert_eq!(
        burn[4 + 32 * keys + 32],
        1,
        "one instruction: AdvanceNonceAccount"
    );
    assert_eq!(&burn[4 + 32 * keys..4 + 32 * keys + 32], &NONCE_VALUE);
    assert_eq!(
        claimable(&contract, ts(4_010)),
        0,
        "the claim stays debited"
    );
    assert_eq!(
        contract.get_replay(nonce_key(NONCE_VALUE)),
        Some(ReplayState::Consumed)
    );
    assert_eq!(
        contract.get_sol_stream(U64(0)).unwrap().drawing,
        Some(U64(id))
    );
    assert!(events("rose")
        .iter()
        .any(|e| e["event"] == "payout_cancelling"));

    // The cancellation is signed at once (no expiry to wait for), then confirmed: the nonce
    // advanced and the stream is untouched, so the claim is refunded.
    env_at(&accounts(4), ts(4_020));
    assert!(contract.retry_sol_payout(U64(id)).is_some());
    let message = message_of(&contract, id);
    assert_eq!(message, burn);
    env_with_results(
        ts(4_025),
        vec![
            ed_signature(&vault_sol_key(), &message),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    assert!(contract.on_sol_signed(U64(id)));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
    assert!(!confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        false,
        ts(4_100),
    ));
    assert!(matches!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(claimable(&contract, ts(4_500)), 300, "refunded once proven");
    assert_eq!(contract.get_sol_stream(U64(0)).unwrap().drawing, None);
}

#[test]
fn a_late_signature_of_a_cancelled_payout_that_executed_is_counted_not_refunded() {
    let (mut contract, class) = solana_holder();
    let id = failed_claim(&mut contract, &class);
    env_at(&accounts(4), ts(4_020));
    assert!(contract.retry_sol_payout(U64(id)).is_some());
    let message = message_of(&contract, id);
    env_with_results(
        ts(4_025),
        vec![
            ed_signature(&vault_sol_key(), &message),
            ed_signature(&gas_sol_key(), &message),
        ],
    );
    assert!(contract.on_sol_signed(U64(id)));
    // A late vault signature of the original surfaced and the original executed first: the
    // stream paid the claim, so the payout lands and nothing is refunded.
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_100),
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Landed
    );
    assert_eq!(
        contract.get_sol_stream(U64(0)).unwrap().engine_withdrawn.0,
        300
    );
    assert_eq!(claimable(&contract, ts(4_100)), 0);
}

#[test]
fn a_not_executed_verdict_needs_two_proofs_apart_and_a_landing_overrides_the_first() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    // A first proof reads the receipt behind the nonce (a lagging read of it could): nothing
    // happens.
    assert!(!prove_payout_state(
        &mut contract,
        id,
        NONCE_NEXT,
        RECEIPT_VALUE,
        ts(4_050),
    ));
    let delay = crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS;
    assert!(!prove_payout_state(
        &mut contract,
        id,
        NONCE_NEXT,
        RECEIPT_VALUE,
        ts(4_050 + delay - 10),
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed,
        "a second proof within the delay changes nothing"
    );
    // The next read shows the receipt on the nonce's value: the payout lands.
    assert!(prove_payout_state(
        &mut contract,
        id,
        NONCE_NEXT,
        NONCE_NEXT,
        ts(4_050 + delay),
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Landed
    );
    assert_eq!(claimable(&contract, ts(4_300)), 0);
}

#[test]
fn payouts_and_redeems_refuse_the_engines_own_keys_as_recipients() {
    let (mut contract, class) = solana_holder();
    for owner in [vault(), pubkey_of(&gas_sol_key())] {
        payout_env(&accounts(1), ts(4_000));
        panics_with("vault or fee payer", || {
            contract.claim_sol_tokens(
                holding(&class),
                vec![draw(0, 300)],
                None,
                fmt(&owner),
                proof(NONCE_VALUE),
            )
        });
        payout_env(&accounts(1), ts(4_000));
        panics_with("vault or fee payer", || {
            contract.redeem(U64(0), fmt(&owner), Some(proof(NONCE_VALUE)))
        });
    }
    // The stream's own deposit address is an engine key too: a stream released there could
    // never move again.
    payout_env(&accounts(1), ts(4_000));
    panics_with("must not be the stream's deposit address", || {
        contract.redeem(U64(0), fmt(&deposit_address()), Some(proof(NONCE_VALUE)))
    });
    let mut contract = bootstrapped();
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(2_000));
    panics_with("must not be the engine's vault", || {
        contract.attribute_sol_deposit(SolDepositArgs {
            metadata: fmt(&STREAM),
            class_id: stepped_class_id(),
            return_to: vault_sol(),
            anchor_tx: anchor(),
            metadata_data: hex::encode(stream_bytes(STREAM, &sol_spec(deposit_address()))),
            mint_data: hex::encode(mint_bytes(DECIMALS)),
        })
    });
}

#[test]
fn solana_records_fit_their_storage_deposits() {
    // An attribution refused at the deposit address stores both of its records.
    let mut contract = bootstrapped();
    let spec = StreamSpec {
        can_topup: true,
        ..sol_spec(deposit_address())
    };
    let args = attribute_stream(&mut contract, STREAM, &spec);
    let deposit = contract.get_sol_deposit(args.metadata.clone()).unwrap();
    let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
    assert_fits(
        record_bytes(1 + borsh_len(&args.metadata), borsh_len(&deposit))
            + record_bytes(1 + borsh_len(&stream_key(STREAM)), borsh_len(&refused)),
        RECORD_STORAGE_DEPOSIT,
        "an attribution",
    );

    // A registration creates the replay key, the position, the stream accounts, the class, its
    // stream list and its swept balance (the holding row is the holder's own storage).
    let (contract, class) = solana_holder();
    let position = contract.positions.get(&0).unwrap().clone();
    let stored_class = contract.classes.get(&class).unwrap().clone();
    let stream = contract.get_sol_stream(U64(0)).unwrap();
    assert_fits(
        record_bytes(
            1 + borsh_len(&stream_key(STREAM)),
            borsh_len(&ReplayState::Consumed),
        ) + record_bytes(1 + 8, borsh_len(&position))
            + record_bytes(1 + 8, borsh_len(&stream))
            + record_bytes(1 + borsh_len(&class), borsh_len(&stored_class))
            + record_bytes(1 + borsh_len(&class), 4 + 8)
            + record_bytes(1 + borsh_len(&class), borsh_len(&SolSwept::default())),
        RECORD_STORAGE_DEPOSIT,
        "a Solana registration",
    );

    // The largest payout: as many draws as one transaction carries, both signatures stored.
    let mut contract = bootstrapped();
    let mut streams = Vec::new();
    for i in 0..8u8 {
        streams.push(deposit_stream(&mut contract, [60 + i; 32], 0, ts(2_400)));
    }
    let class = stepped_class_id();
    let mut count = streams.len();
    while count > 0 {
        payout_env(&accounts(1), ts(8_000));
        let draws: Vec<SolDrawArgs> = streams[..count].iter().map(|id| draw(*id, 100)).collect();
        let fits = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.claim_sol_tokens(
                holding(&class),
                draws,
                None,
                fmt(&RETURN_TO),
                proof(NONCE_VALUE),
            )
        }));
        if let Ok(promise) = fits {
            promise.detach();
            break;
        }
        count -= 1;
    }
    assert!(
        count >= 3,
        "a payout carries at least three draws, here {count}"
    );
    let id = contract.payouts_total().0 - 1;
    prove(&mut contract, id, NONCE_VALUE, ts(8_005));
    assert!(sign(&mut contract, id, ts(8_010)));
    let transaction = contract
        .get_payout(U64(id))
        .unwrap()
        .solana
        .unwrap()
        .transaction
        .unwrap();
    assert!(transaction.0.len() <= sol::MAX_TRANSACTION_LEN);
    assert!(
        transaction.0.len() + 200 > sol::MAX_TRANSACTION_LEN,
        "one more draw would not fit"
    );
    assert_fits(
        payout_bytes(&contract, id) + 2 * record_bytes(1 + borsh_len(&fmt(&nonce_account())), 8),
        PAYOUT_STORAGE_DEPOSIT,
        "the largest Solana payout",
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]
    /// Whatever sequence of claims lands or fails, a stream's proven withdrawals plus its
    /// unconfirmed draw never exceed what it has unlocked, and the tokens the class pays out
    /// never exceed what its streams withdrew.
    #[test]
    fn solana_withdraw_accounting_never_exceeds_the_unlocked_amount(
        steps in proptest::collection::vec((1u64..1_500, any::<bool>(), 1u128..400), 1..8),
    ) {
        let (mut contract, class) = solana_holder();
        let mut now = 2_000u64;
        let mut nonce = 100u8;
        let mut landed_total = 0u128;
        for (advance, lands, wanted) in steps {
            now += advance;
            let held = claimable(&contract, ts(now));
            let Some(stream) = contract.get_sol_streams(class.clone()).first().cloned() else {
                break;
            };
            let available = stream.withdrawable.0;
            let amount = wanted.min(available).min(held);
            if amount == 0 || (amount < 100 && stream.stream.engine_withdrawn.0 + amount as u64 != 1_000) {
                continue;
            }
            let value = [nonce; 32];
            let next = [nonce + 1; 32];
            nonce += 2;
            let id = claim(&mut contract, &class, vec![draw(0, amount)], value, ts(now));
            let pending = contract.get_sol_stream(U64(0)).unwrap();
            let unlocked = crate::unlock::StreamflowStream::new(pending.params())
                .unwrap()
                .unlocked_amount(now);
            prop_assert!(u128::from(pending.engine_withdrawn.0 + pending.pending_withdraw.0) <= unlocked);
            prop_assert_eq!(
                confirm_payout(&mut contract, id, next, lands, ts(now + 20)),
                lands
            );
            if lands {
                landed_total += amount;
            }
            let after = contract.get_sol_stream(U64(0)).unwrap();
            prop_assert_eq!(u128::from(after.engine_withdrawn.0), landed_total);
            prop_assert_eq!(after.pending_withdraw.0, 0);
            now += 20 + crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS;
        }
    }
}

/// A redeem of position 0 to `RETURN_TO`, signed with nonce `value`, after a payout of 300 that
/// landed (the engine has proven 300 withdrawn from the stream).
fn redeemed_after_a_landed_payout() -> (Contract, String, u64) {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_100),
    ));
    let nonce_3 = [15u8; 32];
    payout_env(&accounts(1), ts(4_200));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof(nonce_3)))
        .detach();
    let release = contract.payouts_total().0 - 1;
    prove(&mut contract, release, nonce_3, ts(4_205));
    assert!(sign(&mut contract, release, ts(4_210)));
    (contract, class, release)
}

#[test]
fn a_release_is_settled_by_its_receipt_whatever_the_stream_shows() {
    // Executed: the receipt moved with the nonce, the burn is final.
    let (mut contract, _, release) = redeemed_after_a_landed_payout();
    assert!(confirm_redeem(&mut contract, 0, true, ts(5_000)));
    assert_eq!(
        contract.get_payout(U64(release)).unwrap().status,
        PayoutStatus::Landed
    );
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Released
    );
    // Not executed: a first proof with the receipt behind changes nothing, the second one
    // after the delay gives the units back and the position is held again.
    let (mut contract, class, release) = redeemed_after_a_landed_payout();
    assert!(!confirm_redeem(&mut contract, 0, false, ts(5_000)));
    assert!(matches!(
        contract.get_payout(U64(release)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Held
    );
    assert_eq!(contract.mt_balance_of(accounts(1), class).0, 1_000);
    // A receipt that is not a nonce account of the vault is refused.
    let (mut contract, _, _) = redeemed_after_a_landed_payout();
    env_at(&accounts(4), ts(5_000));
    panics_with("Invalid receipt nonce account", || {
        contract.confirm_sol_redeem(
            U64(0),
            anchor(),
            hex::encode(nonce_bytes(vault(), NONCE_NEXT)),
            hex::encode(stream_bytes(STREAM, &at_vault(300))),
        )
    });
}

#[test]
fn the_failure_delay_runs_from_the_first_answer_to_the_next_request() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    let delay = crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS;
    // Two proofs requested in the same block read the chain at about the same moment.
    let first = request_payout_proof(&mut contract, id, NONCE_NEXT, RECEIPT_VALUE, ts(4_050));
    let second = request_payout_proof(&mut contract, id, NONCE_NEXT, RECEIPT_VALUE, ts(4_050));
    assert!(!answer_proof(&mut contract, id, &first, ts(4_057)));
    // The second answer arrives past the delay, but its reads are not: nothing changes.
    assert!(!answer_proof(
        &mut contract,
        id,
        &second,
        ts(4_057 + delay + 20)
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
    // A proof requested one delay after the first answer settles it.
    assert!(!prove_payout_state(
        &mut contract,
        id,
        NONCE_NEXT,
        RECEIPT_VALUE,
        ts(4_057 + delay - 1)
    ));
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
    assert!(!prove_payout_state(
        &mut contract,
        id,
        NONCE_NEXT,
        RECEIPT_VALUE,
        ts(4_057 + delay)
    ));
    assert!(matches!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    assert_eq!(claimable(&contract, ts(4_300)), 300);
}

#[test]
fn a_multi_stream_payout_lands_on_its_receipt_and_counts_every_draw() {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    let args2 = attribute_stream(&mut contract, STREAM_2, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args2.metadata, ts(2_150));
    register_stream(&mut contract, STREAM_2, 200, ts(3_000));
    let class = stepped_class_id();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300), draw(1, 100)],
        NONCE_VALUE,
        ts(4_000),
    );
    let message = message_of(&contract, id);
    let keys = usize::from(message[3]);
    let account_keys: Vec<&[u8]> = (0..keys)
        .map(|i| &message[4 + 32 * i..36 + 32 * i])
        .collect();
    assert!(account_keys.contains(&&receipt_account()[..]));
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_100)
    ));
    assert_eq!(
        contract.get_sol_stream(U64(0)).unwrap().engine_withdrawn,
        U64(300)
    );
    assert_eq!(
        contract.get_sol_stream(U64(1)).unwrap().engine_withdrawn,
        U64(300)
    );
}

#[test]
fn nonce_accounts_stay_reserved_until_their_action_is_settled() {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    let args2 = attribute_stream(&mut contract, STREAM_2, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args2.metadata, ts(2_150));
    register_stream(&mut contract, STREAM_2, 0, ts(2_200));
    let class = stepped_class_id();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    // Another payout on another stream cannot reuse either account while the first is
    // unsettled: the claimant could otherwise move its nonce after a landing and make the
    // receipt look behind (a refund of a paid claim).
    let swapped = SolNonceProof {
        account: fmt(&receipt_account()),
        seed: receipt_seed(),
        receipt_seed: format!("{}b", crate::custody::nonce_seed_prefix(&accounts(1))),
        ..proof(NONCE_NEXT)
    };
    for nonce in [proof(NONCE_NEXT), swapped] {
        payout_env(&accounts(1), ts(4_100));
        panics_with("is reserved by action", || {
            contract.claim_sol_tokens(
                holding(&class),
                vec![draw(1, 300)],
                None,
                fmt(&RETURN_TO),
                nonce.clone(),
            )
        });
    }
    // The receipt must be another account than the nonce.
    payout_env(&accounts(1), ts(4_100));
    panics_with("another account than the nonce", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![draw(1, 300)],
            None,
            fmt(&RETURN_TO),
            SolNonceProof {
                receipt_seed: nonce_seed(),
                ..proof(NONCE_NEXT)
            },
        )
    });
    // Settled: both are free again.
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_200)
    ));
    let next = claim(
        &mut contract,
        &class,
        vec![draw(1, 300)],
        NONCE_NEXT,
        ts(4_300),
    );
    assert_eq!(
        contract.get_payout(U64(next)).unwrap().status,
        PayoutStatus::Signed
    );
}

/// The holder of `solana_holder` once the stream ended and Streamflow's auto-claim emptied it
/// into the vault's token account, after a landed payout of 300.
fn swept_after_a_payout() -> (Contract, String) {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_100)
    ));
    (contract, class)
}

#[test]
fn streamflow_auto_claim_is_booked_by_sync_and_paid_from_the_swept_balance() {
    let (mut contract, class) = swept_after_a_payout();
    env_at(&accounts(4), ts(11_010));
    assert_eq!(contract.get_sol_swept(class.clone()), SolSwept::default());
    // A read of the stream still open shows nothing beyond the engine's accounting.
    panics_with("Nothing to sync", || {
        contract.sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &at_vault(300))),
        )
    });
    // A lagging read books what it shows, a later one the rest: never more than withdrawn.
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &at_vault(700),
        ts(11_010)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(400));
    assert_eq!(
        contract.get_sol_stream(U64(0)).unwrap().engine_withdrawn,
        U64(700)
    );
    env_at(&accounts(4), ts(11_020));
    panics_with("Nothing to sync", || {
        contract.sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &at_vault(600))),
        )
    });
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_030)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(700));
    assert!(contract.get_sol_streams(class.clone()).is_empty(), "pruned");
    assert!(events("rose")
        .iter()
        .any(|e| e["event"] == "sol_stream_swept"));
    // The holder's last 700 claimable tokens are paid from the swept balance alone.
    assert_eq!(claimable(&contract, ts(11_040)), 700);
    payout_env(&accounts(1), ts(11_040));
    panics_with("swept balance can pay at most 700", || {
        contract.claim_sol_tokens(
            holding(&class),
            vec![],
            Some(U128(701)),
            fmt(&RETURN_TO),
            proof(NONCE_NEXT),
        )
    });
    let id = claim_with(&mut contract, &class, vec![], 700, NONCE_NEXT, ts(11_040));
    let payout = contract.get_payout(U64(id)).unwrap();
    assert_eq!(payout.solana.as_ref().unwrap().swept, U64(700));
    let message = payout.solana.unwrap().message.0;
    assert!(
        withdraw_amounts(&message).is_empty(),
        "no Streamflow withdraw"
    );
    assert_eq!(
        contract.get_sol_swept(class.clone()),
        SolSwept {
            balance: U64(700),
            pending: U64(700)
        }
    );
    assert!(confirm_payout(
        &mut contract,
        id,
        [15u8; 32],
        true,
        ts(11_100)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()), SolSwept::default());
    assert_eq!(claimable(&contract, ts(11_200)), 0);
}

#[test]
fn a_swept_payout_that_did_not_execute_gives_the_balance_back() {
    let (mut contract, class) = swept_after_a_payout();
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_010)
    ));
    let id = claim_with(&mut contract, &class, vec![], 500, NONCE_NEXT, ts(11_040));
    // A donation to the vault's token account or a move out of the recipient's own account
    // changes neither nonce account: the verdict follows the receipt only.
    assert!(!confirm_payout(
        &mut contract,
        id,
        [15u8; 32],
        false,
        ts(11_100)
    ));
    assert_eq!(
        contract.get_sol_swept(class.clone()),
        SolSwept {
            balance: U64(700),
            pending: U64(0)
        }
    );
    assert_eq!(claimable(&contract, ts(11_500)), 700);
}

#[test]
fn a_payout_signed_before_the_end_and_broadcast_after_the_sweep_is_refunded_and_swept() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 900)],
        NONCE_VALUE,
        ts(10_600),
    );
    // Streamflow emptied the stream at 11,001; the payout broadcast later failed on chain (the
    // escrow is closed), which advanced its nonce but not its receipt. Until the payout is
    // settled nobody knows whether its withdrawal happened, so the stream is not synced.
    env_at(&accounts(4), ts(11_010));
    panics_with("not confirmed yet", || {
        contract.sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &swept_spec())),
        )
    });
    assert!(!confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        false,
        ts(11_100)
    ));
    assert!(matches!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Failed { .. }
    ));
    // The auto-claim took the whole stream, the failed draw's 900 included.
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_300)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(1_000));
    assert_eq!(claimable(&contract, ts(11_300)), 1_000);
    let paid = claim_with(&mut contract, &class, vec![], 1_000, NONCE_NEXT, ts(11_300));
    assert!(confirm_payout(
        &mut contract,
        paid,
        [15u8; 32],
        true,
        ts(11_400)
    ));
    assert_eq!(contract.get_sol_swept(class), SolSwept::default());
}

#[test]
fn a_payout_that_landed_before_the_sweep_counts_once() {
    let (mut contract, class) = solana_holder();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 900)],
        NONCE_VALUE,
        ts(10_600),
    );
    // It executed before the end, then the auto-claim took the rest; confirmed afterwards, the
    // stream reads fully withdrawn either way, and only the receipt tells.
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(11_100)
    ));
    assert_eq!(
        contract.get_sol_stream(U64(0)).unwrap().engine_withdrawn,
        U64(900)
    );
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_200)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(100));
    assert_eq!(claimable(&contract, ts(11_200)), 100);
}

#[test]
fn a_cancellation_racing_the_sweep_is_settled_by_the_receipt() {
    let (mut contract, class) = solana_holder();
    let id = request_claim(
        &mut contract,
        &class,
        vec![draw(0, 900)],
        NONCE_VALUE,
        ts(10_600),
    );
    prove(&mut contract, id, NONCE_VALUE, ts(10_605));
    let original = message_of(&contract, id);
    env_with_results(
        ts(10_610),
        vec![
            PromiseResult::Failed,
            ed_signature(&gas_sol_key(), &original),
        ],
    );
    assert!(!contract.on_sol_signed(U64(id)));
    env_at(&accounts(4), ts(10_620));
    assert!(contract.retry_sol_payout(U64(id)).is_some());
    let cancel = message_of(&contract, id);
    env_with_results(
        ts(10_625),
        vec![
            ed_signature(&vault_sol_key(), &cancel),
            ed_signature(&gas_sol_key(), &cancel),
        ],
    );
    assert!(contract.on_sol_signed(U64(id)));
    // The cancellation executed after the sweep (or the original failed on the closed escrow):
    // the receipt never moved, so the claim is refunded and the stream's tokens are swept.
    assert!(!confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        false,
        ts(11_100)
    ));
    assert_eq!(claimable(&contract, ts(11_400)), 1_000);
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_400)
    ));
    assert_eq!(contract.get_sol_swept(class).balance, U64(1_000));
}

#[test]
fn a_redeem_near_the_end_is_refused_and_one_signed_before_settles_by_its_receipt() {
    let (mut contract, class) = solana_holder();
    payout_env(&accounts(1), ts(10_700));
    panics_with("ends within five minutes", || {
        contract.redeem(U64(0), fmt(&RETURN_TO), Some(proof(NONCE_VALUE)))
    });
    env_at(&accounts(1), ts(10_700));
    assert_eq!(
        contract.get_sol_streams(class.clone())[0].redeem_claimable,
        U128(0)
    );
    // Signed before the cutoff, broadcast after the sweep: Streamflow refuses to transfer a
    // closed stream (error 104), the receipt stays behind and the redeem is reverted.
    payout_env(&accounts(1), ts(10_600));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof(NONCE_VALUE)))
        .detach();
    let release = contract.payouts_total().0 - 1;
    prove(&mut contract, release, NONCE_VALUE, ts(10_605));
    assert!(sign(&mut contract, release, ts(10_610)));
    env_at(&accounts(4), ts(11_010));
    panics_with("not held", || {
        contract.sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &swept_spec())),
        )
    });
    assert!(!confirm_redeem(&mut contract, 0, false, ts(11_100)));
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Held
    );
    assert_eq!(contract.mt_balance_of(accounts(1), class.clone()).0, 1_000);
    assert!(sync_stream(
        &mut contract,
        0,
        STREAM,
        &swept_spec(),
        ts(11_400)
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(1_000));
    assert_eq!(claimable(&contract, ts(11_400)), 1_000);
}

#[test]
fn a_sync_rechecks_the_stream_in_its_callback() {
    let (mut contract, class) = solana_holder();
    // A read of a stream paying another token account, or a stream released meanwhile, books
    // nothing.
    let elsewhere = StreamSpec {
        amount_withdrawn: 1_000,
        closed: true,
        ..sol_spec(RETURN_TO)
    };
    env_at(&accounts(4), ts(11_010));
    panics_with("does not pay the vault's token account", || {
        contract.sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &elsewhere)),
        )
    });
    // A sync requested while the stream was free, answered once a payout draws on it, books
    // nothing: its read may or may not include that payout's withdrawal.
    env_at(&accounts(4), ts(5_000));
    contract
        .sync_sol_stream(
            U64(0),
            anchor(),
            hex::encode(stream_bytes(STREAM, &at_vault(400))),
        )
        .detach();
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(5_001),
    );
    let hash = sol_hash(vec![metadata_account(STREAM, &at_vault(400))]);
    env_with_results(ts(5_007), vec![foreign_response(hash)]);
    assert!(!contract.on_sol_stream_synced(
        U64(0),
        hex::encode(hash),
        hex::encode(stream_bytes(STREAM, &at_vault(400)))
    ));
    assert_eq!(contract.get_sol_swept(class.clone()).balance, U64(0));
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(5_100)
    ));
    // A mismatched attestation books nothing either.
    env_with_results(ts(11_020), vec![foreign_response([7u8; 32])]);
    assert!(!contract.on_sol_stream_synced(
        U64(0),
        hex::encode([8u8; 32]),
        hex::encode(stream_bytes(STREAM, &swept_spec()))
    ));
    assert_eq!(contract.get_sol_swept(class).balance, U64(0));
}

#[test]
fn a_nonce_account_serves_only_the_near_account_its_seed_names() {
    // The prefix is the first 24 hex characters of sha256(account id) (the SDK's vector too).
    let (mut contract, class) = solana_holder();
    assert_eq!(
        contract.nonce_seed_prefix_of("alice.testnet".parse().unwrap()),
        "9a7068ee6434852cdaff3acb"
    );
    let other_seed = format!("{}a", crate::custody::nonce_seed_prefix(&accounts(2)));
    let others = SolNonceProof {
        account: fmt(&sol::create_with_seed(&NONCE_BASE, &other_seed, &SYSTEM_PROGRAM).unwrap()),
        seed: other_seed,
        ..proof(NONCE_VALUE)
    };
    let long_seed = format!(
        "{}123456789",
        crate::custody::nonce_seed_prefix(&accounts(1))
    );
    let cases = [
        // Another NEAR account's nonce account, even from the same wallet.
        ("must start with", others.clone()),
        // The caller's seed, but an account not derived from it.
        (
            "must be created with the seed",
            SolNonceProof {
                account: fmt(&[12u8; 32]),
                ..proof(NONCE_VALUE)
            },
        ),
        (
            "must be created with the seed",
            SolNonceProof {
                base: fmt(&RETURN_TO),
                ..proof(NONCE_VALUE)
            },
        ),
        (
            "at most 32 characters",
            SolNonceProof {
                account: fmt(&sol::create_with_seed(
                    &NONCE_BASE,
                    &long_seed[..32],
                    &SYSTEM_PROGRAM,
                )
                .unwrap()),
                seed: long_seed,
                ..proof(NONCE_VALUE)
            },
        ),
    ];
    for (expected, nonce) in cases {
        payout_env(&accounts(1), ts(4_000));
        panics_with(expected, || {
            contract.claim_sol_tokens(
                holding(&class),
                vec![draw(0, 300)],
                None,
                fmt(&RETURN_TO),
                nonce.clone(),
            )
        });
        payout_env(&accounts(1), ts(4_000));
        panics_with(expected, || {
            contract.redeem(U64(0), fmt(&RETURN_TO), Some(nonce.clone()))
        });
    }
    // Nothing was marked: the claimant's own nonce account still serves.
    assert_eq!(contract.get_replay(nonce_key(NONCE_VALUE)), None);
    let id = claim(
        &mut contract,
        &class,
        vec![draw(0, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert_eq!(
        contract.get_payout(U64(id)).unwrap().status,
        PayoutStatus::Signed
    );
}

#[test]
fn streams_of_a_mint_with_a_freeze_authority_are_refused_and_returnable() {
    let mut contract = bootstrapped();
    let mut mint = mint_bytes(DECIMALS);
    mint[46] = 1;
    mint[50..82].copy_from_slice(&[7u8; 32]);
    attribute_with_mint(&mut contract, STREAM, &sol_spec(deposit_address()), mint);
    let deposit = contract.get_sol_deposit(fmt(&STREAM)).unwrap();
    assert_eq!(deposit.stage, SolDepositStage::Refused);
    let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
    assert!(
        refused.reason.contains("freeze authority"),
        "{}",
        refused.reason
    );
    assert!(matches!(
        refused.asset,
        RefusedAsset::SolStream { ref held_by, .. } if *held_by == fmt(&deposit_address())
    ));
    // A malformed mint account is refused before anything is requested.
    let mut malformed = mint_bytes(DECIMALS);
    malformed[46] = 2;
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(2_000));
    panics_with("initialized 82-byte SPL Token mint", || {
        contract.attribute_sol_deposit(SolDepositArgs {
            metadata: fmt(&STREAM_2),
            class_id: stepped_class_id(),
            return_to: fmt(&RETURN_TO),
            anchor_tx: anchor(),
            metadata_data: hex::encode(stream_bytes(STREAM_2, &sol_spec(deposit_address()))),
            mint_data: hex::encode(&malformed),
        })
    });
}

#[test]
fn a_redeem_counts_the_pending_lien_excess_as_claimable() {
    let mut contract = bootstrapped();
    deposit_stream(&mut contract, STREAM, 0, ts(500));
    let args2 = attribute_stream(&mut contract, STREAM_2, &sol_spec(deposit_address()));
    move_stream(&mut contract, &args2.metadata, ts(2_150));
    register_stream(&mut contract, STREAM_2, 0, ts(2_200));
    let class = stepped_class_id();
    register(&mut contract, &accounts(2), ts(2_300));
    env(&accounts(1), one_yocto(), ts(2_300));
    contract.mt_transfer(accounts(2), class.clone(), U128(1_000), None, None);
    let id = claim(
        &mut contract,
        &class,
        vec![draw(1, 300)],
        NONCE_VALUE,
        ts(4_000),
    );
    assert!(confirm_payout(
        &mut contract,
        id,
        NONCE_NEXT,
        true,
        ts(4_050),
    ));
    // Stream 0 owes 300; the holder has 100 claimable and a lien whose excess (300 at f = 0.3,
    // nothing claimed by its funders) is credited only when the lien is touched.
    contract.liens.insert(
        9,
        crate::types::LienRecord {
            class_id: class.clone(),
            round_id: 0,
            holder: accounts(1),
            lien: crate::ledger::Lien::new(1_000, 0, 0),
            released: false,
            created_at: 0,
        },
    );
    contract.index_mut(&accounts(1)).liens_held.push(9);
    assert_eq!(claimable(&contract, ts(4_100)), 400);
    payout_env(&accounts(1), ts(4_100));
    contract
        .redeem(U64(0), fmt(&RETURN_TO), Some(proof([15u8; 32])))
        .detach();
    assert_eq!(
        contract.get_position(U64(0)).unwrap().position.state,
        PositionState::Releasing
    );
    assert_eq!(claimable(&contract, ts(4_100)), 100);
}

#[test]
fn solana_token_amounts_are_json_strings() {
    let (contract, _) = solana_holder();
    let stream = serde_json::to_value(contract.get_sol_stream(U64(0)).unwrap()).unwrap();
    for field in [
        "cliff_amount",
        "amount_per_period",
        "net_amount_deposited",
        "engine_withdrawn",
        "registered_withdrawn",
        "pending_withdraw",
    ] {
        assert!(stream[field].is_string(), "{field}: {}", stream[field]);
    }
    // A schedule above 2^53 base units is read exactly.
    let big = 9_007_199_254_740_993u64;
    let args: crate::custody::StreamflowScheduleArgs = serde_json::from_value(serde_json::json!({
        "start_time": 1_000,
        "cliff": 0,
        "cliff_amount": "0",
        "period": 1_000,
        "amount_per_period": big.to_string(),
        "net_amount_deposited": (big * 10).to_string(),
        "end_time": 11_000,
    }))
    .unwrap();
    assert_eq!(args.net_amount_deposited, U64(big * 10));
    assert_eq!(args.amount_per_period, U64(big));
}

#[test]
fn a_tender_cannot_retire_to_rose_vault_or_the_engines_keys() {
    let (mut contract, class) = solana_holder();
    let issuer = accounts(0);
    fund(&mut contract, &issuer, 10 * USDC, ts(1_000));
    env_at(&engine(), ts(100));
    let base = contract.ensure_class(Chain::Base, "0xtoken".into(), 6, stepped_schedule());
    let derived = contract.config.derived_addresses.clone().unwrap();
    let tender = |class_id: &str, retire_to: &str| crate::rounds::TenderParams {
        class_id: class_id.to_string(),
        venue: Venue::Near,
        budget: U128(USDC),
        max_price: U128(1),
        reference_price: None,
        retire_to: retire_to.to_string(),
        window: window(ts(6_000)),
    };
    for (class_id, retire_to) in [
        (&class, derived.vault_sol.as_str()),
        (&class, derived.gas_sol.as_str()),
        (&base, derived.vault_base.as_str()),
        (&base, "0x1111111111111111111111111111111111111111"),
    ] {
        env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
        panics_with(
            "retire_to must not be RoseVault or one of the engine's own keys",
            || contract.create_tender(tender(class_id, retire_to)),
        );
    }
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    contract.create_tender(tender(&class, &fmt(&RETURN_TO)));
    env(&issuer, ROUND_STORAGE_DEPOSIT, ts(2_000));
    contract.create_tender(tender(&base, "0x000000000000000000000000000000000000dead"));
}

/// Attributes, moves and registers `stream` on the schedule of `spec` (nothing withdrawn) for
/// `accounts(1)` at `at`; returns its class.
fn deposit_schedule(
    contract: &mut Contract,
    stream: [u8; 32],
    spec: &StreamSpec,
    at: u64,
) -> String {
    let at_deposit = StreamSpec {
        recipient: deposit_address(),
        ..spec.clone()
    };
    let args = attribute_stream(contract, stream, &at_deposit);
    move_stream(contract, &args.metadata, ts(2_100));
    let at_vault = StreamSpec {
        recipient: vault(),
        ..spec.clone()
    };
    let deposit = NearToken::from_yoctonear(
        contract
            .registration_deposit_for(accounts(1), args.class_id.clone())
            .0,
    );
    env(&accounts(5), deposit, at);
    contract
        .register_sol_deposit(
            fmt(&stream),
            anchor(),
            hex::encode(stream_bytes(stream, &at_vault)),
        )
        .detach();
    let hash = sol_hash(vec![metadata_account(stream, &at_vault)]);
    env_with_results(at + 7 * NS, vec![foreign_response(hash)]);
    assert!(contract.on_sol_deposit_verified(
        stream_key(stream),
        hex::encode(hash),
        hex::encode(stream_bytes(stream, &at_vault)),
        accounts(5),
        U128(deposit.as_yoctonear()),
    ));
    args.class_id
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    /// A sole holder can always redeem its stream: whatever the schedule and whenever it claimed,
    /// its claimable tokens cover what the redeem takes (`redeem_claimable`), because its
    /// holding accrues the floor of its exact accrual, the amount the redeem computes.
    #[test]
    fn a_sole_holder_can_always_redeem_its_stream(
        net in 1_000u64..10_000_000_000_000,
        per_divisor in 2u64..10_000,
        claims in proptest::collection::vec((1u64..2_500, 1u64..=1_000), 0..5),
        wait in 0u64..3_000,
    ) {
        let per = (net / per_divisor).max(1);
        let periods = net.div_ceil(per);
        let spec = StreamSpec {
            net_amount_deposited: net,
            amount_per_period: per,
            end_time: 1_000 + 1_000 * periods,
            ..sol_spec(vault())
        };
        let mut contract = bootstrapped();
        let class = deposit_schedule(&mut contract, STREAM, &spec, ts(1_500));
        let mut now = 2_200u64;
        let mut nonce = 100u8;
        for (advance, share) in claims {
            now += advance;
            env_at(&accounts(1), ts(now));
            let held = contract.get_claimable(accounts(1), class.clone()).0;
            let available = contract.get_sol_streams(class.clone())[0].withdrawable.0;
            let amount = held.min(available) * u128::from(share) / 1_000;
            if amount < 100 {
                continue;
            }
            let id = claim(&mut contract, &class, vec![draw(0, amount)], [nonce; 32], ts(now));
            prop_assert!(confirm_payout(&mut contract, id, [nonce + 1; 32], true, ts(now + 20)));
            nonce += 2;
            now += 20 + crate::custody::CONFIRM_FAILURE_DELAY_BLOCKS;
        }
        now += wait;
        env_at(&accounts(1), ts(now));
        let streams = contract.get_sol_streams(class.clone());
        if streams.is_empty() {
            return Ok(());
        }
        let owed = streams[0].redeem_claimable.0;
        let held = contract.get_claimable(accounts(1), class.clone()).0;
        prop_assert!(owed <= held, "owed {} > claimable {}", owed, held);
        payout_env(&accounts(1), ts(now));
        contract
            .redeem(U64(0), fmt(&RETURN_TO), Some(proof([nonce; 32])))
            .detach();
        prop_assert_eq!(
            contract.get_position(U64(0)).unwrap().position.state,
            PositionState::Releasing
        );
        prop_assert_eq!(contract.get_claimable(accounts(1), class).0, held - owed);
    }
}

#[test]
fn a_stream_ending_within_an_hour_is_refused_at_its_deposit_address() {
    // Streamflow's auto-claim would empty it at its end, before the deposit completes, into a
    // token account no engine path reaches.
    let mut contract = bootstrapped();
    let spec = StreamSpec {
        end_time: 5_000,
        net_amount_deposited: 400,
        ..sol_spec(deposit_address())
    };
    attribute_stream(&mut contract, STREAM, &spec);
    let refused = contract.get_refused_deposit(stream_key(STREAM)).unwrap();
    assert!(
        refused.reason.contains("ends within an hour"),
        "{}",
        refused.reason
    );
    let spec = StreamSpec {
        end_time: 6_000,
        net_amount_deposited: 500,
        ..sol_spec(deposit_address())
    };
    attribute_stream(&mut contract, STREAM_2, &spec);
    assert_eq!(
        contract.get_sol_deposit(fmt(&STREAM_2)).unwrap().stage,
        SolDepositStage::Attributed
    );
}

#[test]
fn an_attribution_names_its_class_in_lowercase_hex() {
    let mut contract = bootstrapped();
    let spec = sol_spec(deposit_address());
    let args = SolDepositArgs {
        metadata: fmt(&STREAM),
        class_id: sol_class_id(&contract, &spec).to_uppercase(),
        return_to: fmt(&RETURN_TO),
        anchor_tx: anchor(),
        metadata_data: hex::encode(stream_bytes(STREAM, &spec)),
        mint_data: hex::encode(mint_bytes(DECIMALS)),
    };
    env(&accounts(1), RECORD_STORAGE_DEPOSIT, ts(2_000));
    panics_with("lowercase hex class id", || {
        contract.attribute_sol_deposit(args)
    });
}
