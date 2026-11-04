//! Foreign custody: MPC-derived addresses, attested deposits, signed payouts (spec section 7).
//!
//! Every method here follows the same discipline:
//!
//! - The engine never trusts caller-supplied foreign bytes. Deposits are rebuilt from typed values,
//!   hashed into the ForeignTx payload and compared with the hash the MPC nodes signed after
//!   reading their own RPC quorum (`verify_foreign_transaction`, no `expected_payload_hash`: a
//!   mismatch then fails in seconds instead of timing out). Payouts are messages the engine builds
//!   itself from ledger state and asks the MPC to sign.
//! - Every fact is acted on at most once through a [`types::ReplayKey`]: marked pending when the
//!   request goes out, cleared on a `PromiseError` or a mismatch, consumed on a match.
//! - The ledger is debited before every `sign` request, and a signature request never refunds:
//!   a failed request does not prove that no signature will surface (a late MPC response is
//!   public), so a Base authorization is retried until signed and a Solana durable-nonce action
//!   whose authority signature failed is cancelled on chain by a nonce-only transaction. Refunds
//!   come only from a failed proof (nothing was signed) or a confirmation that a signed Solana
//!   transaction did not execute. A response the callback could not read is completed with
//!   `submit_base_signature` or `submit_sol_signature`, which verify the signature against the
//!   derived key.
//! - Solana payouts and redeems are two-phase: a signed durable-nonce transaction stays `Signed`
//!   until anyone proves its nonce advanced (`confirm_sol_payout`, `confirm_sol_redeem`); its
//!   receipt nonce, which only the executed transaction advances, then says whether it executed,
//!   and only then is it final or reverted. Both nonce accounts stay reserved to the action
//!   until then, so no other engine-signed transaction can move either.
//! - Streamflow's auto-claim withdraws every ended vault stream into the vault's token account
//!   outside any engine payout; `sync_sol_stream` proves it and books the tokens in the class's
//!   swept balance, which payouts then pay with `TransferChecked` alone.
//! - Callbacks never panic after a replay key was marked: every validation maps to a refusal or a
//!   cleared key, so a pending key cannot be left behind by a rolled-back callback. A callback
//!   that issues promises has static gas covering what it attaches, the receipt fees and its own
//!   work, and every user call checks it has that gas left; every `Requested` state has a retry
//!   once [`PENDING_EXPIRY_BLOCKS`] have passed.
//!
//! Gas: `sign` and `verify_foreign_transaction` get exactly 15 Tgas and 1 yoctoNEAR (the live
//! floor, paid by the engine, which keeps [`MPC_BALANCE_RESERVE`] free before any request).
//! Storage: callers attach the storage of every record they create: [`PAYOUT_STORAGE_DEPOSIT`]
//! for a signed action, [`RECORD_STORAGE_DEPOSIT`] for a deposit attribution or registration.
//!
//! Base Sepolia is the only EVM chain: the chain id of the EIP-712 domain is `Config.base_chain_id`
//! (84532 on Base Sepolia), fixed at init together with the RoseVault address.

mod base;
mod payouts;
mod solana;
mod types;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, Promise, PromiseError,
};

use crate::foreign::mpc::{
    ForeignChainRpcRequest, SignCall, SignatureResponse, VerifyForeignTransactionCall,
    VerifyForeignTransactionResponse, METHOD_SIGN, METHOD_VERIFY_FOREIGN_TRANSACTION,
};
use crate::foreign::{evm, solana as sol};
use crate::storage::bytes_cost;
use crate::types::{Chain, ClassId, DerivedAddresses, PositionId};
use crate::unlock::{ClassSchedule, SablierLinearStream, StreamflowParams, StreamflowStream};
use crate::{class_id_of, Contract, ContractExt, RoseEvent};

pub use base::deposit_units_of;
pub(crate) use payouts::nonce_seed_prefix;
pub use types::*;

/// Storage deposit attached to every method that stores a signed action record, sized to the
/// largest record (a Solana payout with a full 1,232-byte transaction: its message, two
/// signatures, its draws and its index entry; measured by
/// `tests::custody::payout_records_fit_their_storage_deposit`); kept with the record, which
/// stays as public history.
pub const PAYOUT_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(25);
/// Storage deposit attached to a deposit attribution or registration, and to a Base cash
/// registration, for the records it creates (deposit and refusal records, the replay key, the
/// position, the stream accounts, a new class, a new cash row); kept with them. A registration
/// attaches it on top of the holder's storage (`registration_deposit_for` includes it).
pub const RECORD_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(15);
/// Free balance the engine keeps above its storage before issuing any MPC request, so the
/// callbacks of the requests in flight can always write their records.
pub const MPC_BALANCE_RESERVE: NearToken = NearToken::from_millinear(500);
/// Blocks after which a pending replay key or a `Requested` payout is considered abandoned (the
/// MPC yield times out after 200 blocks and the callback runs right after), so a callback that
/// ran out of gas cannot block a fact or a payout forever.
pub const PENDING_EXPIRY_BLOCKS: u64 = 600;

/// Blocks between the first proof that a signed Solana transaction's nonce advanced without its
/// effects and the proof that may conclude it did not execute (about 90 s): by then every
/// RPC's finalized view is past the slot that advanced the nonce, so the second read of the
/// streams cannot be stale.
pub const CONFIRM_FAILURE_DELAY_BLOCKS: u64 = 150;

/// Tgas attached to `sign` and `verify_foreign_transaction` (the live floor).
const TGAS_MPC_CALL: u64 = 15;
/// Tgas a receipt pays to create one function call receipt (send and execution fees of the
/// receipt and of the function call action, 2 x 2.3 Tgas live, rounded up).
pub(super) const TGAS_CALL_FEES: u64 = 5;
/// Tgas one MPC request costs the receipt that creates it.
pub(super) const TGAS_MPC_REQUEST: u64 = TGAS_MPC_CALL + TGAS_CALL_FEES;
/// Tgas of the own work of a callback (hash comparison, parsing, record updates).
pub(super) const TGAS_CALLBACK_WORK: u64 = 10;
/// Tgas of a callback that only writes records: its work and nothing it attaches.
pub(super) const TGAS_RECORD_CALLBACK: u64 = TGAS_CALLBACK_WORK + 10;
/// Tgas a joined pair of Solana signatures and its callback cost the receipt creating them.
pub(super) const TGAS_SIGN_PAIR: u64 = 2 * TGAS_MPC_REQUEST + TGAS_RECORD_CALLBACK + TGAS_CALL_FEES;
/// Tgas one Base signature and its callback cost the receipt creating them.
pub(super) const TGAS_BASE_SIGN: u64 = TGAS_MPC_REQUEST + TGAS_RECORD_CALLBACK + TGAS_CALL_FEES;
/// Tgas a proof and its record-only callback cost the receipt creating them.
pub(super) const TGAS_PROOF: u64 = TGAS_MPC_REQUEST + TGAS_RECORD_CALLBACK + TGAS_CALL_FEES;

/// Gas attached to `sign` and `verify_foreign_transaction`.
const GAS_FOR_MPC_CALL: Gas = Gas::from_tgas(TGAS_MPC_CALL);
/// Deposit attached to `sign` and `verify_foreign_transaction` (excess is refunded by the MPC).
const MPC_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Gas attached to each `derived_public_key` view call.
const GAS_FOR_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// Static gas of a callback that only writes records.
pub(super) const GAS_FOR_RECORD_CALLBACK: Gas = Gas::from_tgas(TGAS_RECORD_CALLBACK);
/// Longest MPC response the callbacks read.
pub(super) const MAX_RESULT_LEN: usize = 4096;

/// Derivation path of the Base vault key (domain 0).
pub const PATH_VAULT_BASE: &str = "vault/base";
/// Derivation path of the Solana vault key (domain 1).
pub const PATH_VAULT_SOL: &str = "vault/sol";
/// Derivation path of the Solana fee payer (domain 1).
pub const PATH_GAS_SOL: &str = "gas/sol";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Replays,
    Refused,
    Payouts,
    AccountPayouts,
    AccountPayoutList { account: AccountId },
    SolDeposits,
    SolStreams,
    Releasing,
    Pending,
    ClassStreams,
    KeyHolds,
    NonceHolds,
    Swept,
}

/// Custody state, one field of the contract.
#[near]
pub struct CustodyState {
    replays: LookupMap<ReplayKey, ReplayState>,
    refused: LookupMap<ReplayKey, RefusedDeposit>,
    payouts: LookupMap<PayoutId, Payout>,
    next_payout_id: PayoutId,
    account_payouts: LookupMap<AccountId, Vector<PayoutId>>,
    sol_deposits: LookupMap<String, SolDeposit>,
    sol_streams: LookupMap<PositionId, SolStreamInfo>,
    /// Positions with an in-kind release in flight.
    releasing: LookupMap<PositionId, PayoutId>,
    /// Per account, the number of custody actions in flight that will credit it (payouts not
    /// yet signed or failed, deposit registrations not yet resolved): while it is positive the
    /// account cannot withdraw its storage deposit.
    pending: LookupMap<AccountId, u32>,
    /// Solana positions per class still held with tokens left to withdraw (released and fully
    /// withdrawn streams are pruned): the streams a payout may draw on.
    class_streams: LookupMap<ClassId, Vec<PositionId>>,
    /// The account a pending deposit registration holds (see `pending`), per replay key, so an
    /// abandoned request's hold is released when the fact is requested again.
    key_holds: LookupMap<ReplayKey, AccountId>,
    /// Nonce and receipt accounts (base58) of the durable-nonce actions not settled yet, with
    /// the action holding them: no other action may use either until it is settled, so between
    /// its signature and its confirmation only its own transaction (or its cancellation) can
    /// advance them.
    nonce_holds: LookupMap<String, PayoutId>,
    /// Swept balance per Solana class (see [`SolSwept`]).
    swept: LookupMap<ClassId, SolSwept>,
}

impl CustodyState {
    /// Empty custody state.
    pub fn new() -> Self {
        Self {
            replays: LookupMap::new(StorageKey::Replays),
            refused: LookupMap::new(StorageKey::Refused),
            payouts: LookupMap::new(StorageKey::Payouts),
            next_payout_id: 0,
            account_payouts: LookupMap::new(StorageKey::AccountPayouts),
            sol_deposits: LookupMap::new(StorageKey::SolDeposits),
            sol_streams: LookupMap::new(StorageKey::SolStreams),
            releasing: LookupMap::new(StorageKey::Releasing),
            pending: LookupMap::new(StorageKey::Pending),
            class_streams: LookupMap::new(StorageKey::ClassStreams),
            key_holds: LookupMap::new(StorageKey::KeyHolds),
            nonce_holds: LookupMap::new(StorageKey::NonceHolds),
            swept: LookupMap::new(StorageKey::Swept),
        }
    }
}

impl Default for CustodyState {
    fn default() -> Self {
        Self::new()
    }
}

#[near]
impl Contract {
    /// Fills the MPC-derived foreign addresses once: `vault/base` (domain 0, the RoseVault
    /// signer), `vault/sol` and `gas/sol` (domain 1), read from the MPC contract's
    /// `derived_public_key` for this account. Anyone, once; a second call after the addresses
    /// are stored is refused, and a failed request can be retried. Attach 80 Tgas.
    pub fn bootstrap(&mut self) -> Promise {
        require!(
            self.config.derived_addresses.is_none(),
            "Already bootstrapped"
        );
        require_gas_left(3 * (10 + TGAS_CALL_FEES) + TGAS_RECORD_CALLBACK + TGAS_CALL_FEES);
        let engine = env::current_account_id();
        let mpc_account = self.config.mpc_account.clone();
        let derive = |path: &str, domain_id: u64| {
            let args = near_sdk::serde_json::json!({
                "path": path,
                "predecessor": engine,
                "domain_id": domain_id,
            });
            Promise::new(mpc_account.clone()).function_call(
                "derived_public_key".to_string(),
                near_sdk::serde_json::to_vec(&args).expect("args serialize"),
                NearToken::from_yoctonear(0),
                GAS_FOR_DERIVED_KEY,
            )
        };
        self.emit(RoseEvent::BootstrapRequested);
        derive(PATH_VAULT_BASE, self.config.sign_secp256k1_domain)
            .and(derive(PATH_VAULT_SOL, self.config.sign_ed25519_domain))
            .and(derive(PATH_GAS_SOL, self.config.sign_ed25519_domain))
            .then(
                Self::ext(engine)
                    .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                    .on_bootstrap(),
            )
    }

    /// Bootstrap callback: stores the three derived addresses when all three keys arrived and
    /// parse; never rewrites stored addresses. Called by the contract itself.
    #[private]
    pub fn on_bootstrap(&mut self) -> bool {
        if self.config.derived_addresses.is_some() {
            return true;
        }
        let key = |index: u64| -> Option<String> {
            env::promise_result_checked(index, MAX_RESULT_LEN)
                .ok()
                .and_then(|bytes| near_sdk::serde_json::from_slice::<String>(&bytes).ok())
        };
        let addresses = key(0)
            .and_then(|k| evm::address_from_near_public_key(&k).ok())
            .map(|address| evm::format_address(&address))
            .zip(key(1).and_then(|k| sol::parse_near_ed25519(&k).ok()))
            .zip(key(2).and_then(|k| sol::parse_near_ed25519(&k).ok()));
        match addresses {
            Some(((vault_base, vault_sol), gas_sol)) => {
                let derived = DerivedAddresses {
                    vault_base,
                    vault_sol: sol::format_pubkey(&vault_sol),
                    gas_sol: sol::format_pubkey(&gas_sol),
                };
                self.emit(RoseEvent::Bootstrapped {
                    vault_base: derived.vault_base.clone(),
                    vault_sol: derived.vault_sol.clone(),
                    gas_sol: derived.gas_sol.clone(),
                });
                self.config.derived_addresses = Some(derived);
                true
            }
            None => {
                self.emit(RoseEvent::BootstrapFailed);
                false
            }
        }
    }

    /// YoctoNEAR to attach to a deposit registration crediting `account` with units of
    /// `class_id`: the storage of the records it creates ([`RECORD_STORAGE_DEPOSIT`], kept) plus
    /// what `account` needs to hold the units (its registration or one more holding row; 0 when
    /// it already can), whose unused part is returned.
    pub fn registration_deposit_for(&self, account: AccountId, class_id: ClassId) -> U128 {
        U128(
            RECORD_STORAGE_DEPOSIT.as_yoctonear() + self.holder_storage_needed(&account, &class_id),
        )
    }

    /// The 24 hex characters (`sha256(account_id)`) every seed of `account_id`'s payout nonce
    /// accounts starts with (see `SolNonceProof`). Pure, for the app.
    pub fn nonce_seed_prefix_of(&self, account_id: AccountId) -> String {
        nonce_seed_prefix(&account_id)
    }

    /// State of a replay key, or `None` when the fact was never requested.
    pub fn get_replay(&self, key: ReplayKey) -> Option<ReplayState> {
        self.custody.replays.get(&key.canonical()).copied()
    }

    /// A refused deposit, or `None`.
    pub fn get_refused_deposit(&self, key: ReplayKey) -> Option<RefusedDeposit> {
        self.custody.refused.get(&key.canonical()).cloned()
    }

    /// The class id a Sablier Lockup Linear stream of `token` with `decimals` decimals lands in,
    /// or the refusal reason. Pure, for the app.
    #[handle_result]
    pub fn compute_base_class_id(
        &self,
        token: String,
        decimals: u8,
        schedule: SablierScheduleArgs,
    ) -> Result<ClassId, String> {
        let token = evm::canonical_address(&token)
            .ok_or_else(|| "token must be a 20-byte hex address".to_string())?;
        let stream = SablierLinearStream::new((&schedule).into()).map_err(|e| e.to_string())?;
        let class = ClassSchedule::from_sablier(&stream, decimals).map_err(|e| e.to_string())?;
        Ok(class_id_of(Chain::Base, &token, decimals, &class))
    }

    /// The class id a Streamflow stream of `mint` with `decimals` decimals lands in, or the
    /// refusal reason. Pure, for the app (and the deposit path `dep/<account>/<class>`).
    #[handle_result]
    pub fn compute_sol_class_id(
        &self,
        mint: String,
        decimals: u8,
        schedule: StreamflowScheduleArgs,
    ) -> Result<ClassId, String> {
        let params = StreamflowParams {
            start_time: schedule.start_time,
            cliff: schedule.cliff,
            cliff_amount: schedule.cliff_amount.0,
            period: schedule.period,
            amount_per_period: schedule.amount_per_period.0,
            net_amount_deposited: schedule.net_amount_deposited.0,
            end_time: schedule.end_time,
            ..StreamflowParams::default()
        };
        let stream = StreamflowStream::new(params).map_err(|e| e.to_string())?;
        Ok(class_id_of(
            Chain::Solana,
            &mint,
            decimals,
            &ClassSchedule::from_streamflow(&stream),
        ))
    }
}

impl Contract {
    /// The bootstrapped foreign addresses, or a panic.
    pub(crate) fn derived(&self) -> &DerivedAddresses {
        self.config
            .derived_addresses
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Engine is not bootstrapped"))
    }

    /// Returns to `caller` what is left of the storage deposit it attached for the account its
    /// deposit mints to.
    pub(crate) fn refund_registration_deposit(caller: &AccountId, attached: NearToken) {
        if !attached.is_zero() {
            Promise::new(caller.clone()).transfer(attached).detach();
        }
    }

    /// YoctoNEAR a caller must attach so that `account` can hold a row of `class_id`: its
    /// registration when it has none, plus any shortfall of its deposit for one more row.
    pub(crate) fn holder_storage_needed(&self, account: &AccountId, class_id: &ClassId) -> u128 {
        if !self.is_registered(account) {
            return self.min_storage_deposit();
        }
        self.storage_shortfall(account, self.holding_row_bytes(account, class_id))
    }

    /// Registers `account` and tops up its deposit for a row of `class_id` out of `budget`,
    /// returning the remainder. Runs in deposit callbacks, so it never panics: the request
    /// phase required the budget and refuses storage withdrawals while the deposit is pending,
    /// and if the budget is short all the same the engine pays the missing bytes (an owed
    /// credit, see `credit_holding`).
    pub(crate) fn cover_holder_storage(
        &mut self,
        account: &AccountId,
        class_id: &ClassId,
        budget: u128,
    ) -> u128 {
        let budget = self.register_with_budget(account, budget);
        let shortfall = self.storage_shortfall(account, self.holding_row_bytes(account, class_id));
        let top_up = shortfall.min(budget);
        self.top_up_storage(account, top_up);
        budget - top_up
    }

    fn holding_row_bytes(&self, account: &AccountId, class_id: &ClassId) -> u64 {
        if self.holdings.contains_key(&(
            crate::types::Holder::Account(account.clone()),
            class_id.clone(),
        )) {
            0
        } else {
            crate::HOLDING_ROW_BYTES
        }
    }

    /// Counts one more custody action in flight for `account` (see `CustodyState::pending`).
    pub(crate) fn hold(&mut self, account: &AccountId) {
        let count = self.custody.pending.entry(account.clone()).or_insert(0);
        *count = count.saturating_add(1);
    }

    /// Counts one custody action of `account` as resolved.
    pub(crate) fn release_hold(&mut self, account: &AccountId) {
        if let Some(count) = self.custody.pending.get_mut(account) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.custody.pending.remove(account);
            }
        }
    }

    /// True while `account` has a custody action in flight.
    pub(crate) fn has_pending_custody(&self, account: &AccountId) -> bool {
        self.custody.pending.get(account).is_some_and(|c| *c > 0)
    }

    /// Marks `key` pending, or panics when the fact is consumed or a request is in flight. An
    /// abandoned request (pending for [`PENDING_EXPIRY_BLOCKS`]) is replaced, and the account
    /// hold it took is released.
    pub(crate) fn mark_pending(&mut self, key: &ReplayKey) {
        let height = env::block_height();
        match self.custody.replays.get(key) {
            Some(ReplayState::Consumed) => env::panic_str("Already registered"),
            Some(ReplayState::Pending { since_block })
                if height < since_block.saturating_add(PENDING_EXPIRY_BLOCKS) =>
            {
                env::panic_str("A verification of this fact is already in flight")
            }
            Some(ReplayState::Pending { .. }) => self.release_key_hold(key),
            None => {}
        }
        self.custody.replays.insert(
            key.clone(),
            ReplayState::Pending {
                since_block: height,
            },
        );
    }

    /// Holds `account` (see `CustodyState::pending`) for the request pending under `key`.
    pub(crate) fn hold_for_key(&mut self, key: &ReplayKey, account: &AccountId) {
        self.hold(account);
        self.custody.key_holds.insert(key.clone(), account.clone());
    }

    /// Releases the hold taken for the request pending under `key`, if any.
    pub(crate) fn release_key_hold(&mut self, key: &ReplayKey) {
        if let Some(account) = self.custody.key_holds.remove(key) {
            self.release_hold(&account);
        }
    }

    /// True while `key` is pending (a request in flight or abandoned but not replaced).
    pub(crate) fn is_pending(&self, key: &ReplayKey) -> bool {
        matches!(
            self.custody.replays.get(key),
            Some(ReplayState::Pending { .. })
        )
    }

    /// Clears a key marked pending at block `since` (a payout's own nonce mark): a newer mark of
    /// the same fact, made once this one had expired, is left alone.
    pub(crate) fn clear_own_pending(&mut self, key: &ReplayKey, since: u64) {
        if self.custody.replays.get(key) == Some(&ReplayState::Pending { since_block: since }) {
            self.custody.replays.remove(key);
        }
    }

    /// Clears a pending key (no signature or attestation was acted on).
    pub(crate) fn clear_pending(&mut self, key: &ReplayKey) {
        if matches!(
            self.custody.replays.get(key),
            Some(ReplayState::Pending { .. })
        ) {
            self.custody.replays.remove(key);
        }
    }

    /// Consumes a key. Returns `false` when it was already consumed (a duplicate callback).
    pub(crate) fn consume(&mut self, key: &ReplayKey) -> bool {
        if self.custody.replays.get(key) == Some(&ReplayState::Consumed) {
            return false;
        }
        self.custody
            .replays
            .insert(key.clone(), ReplayState::Consumed);
        true
    }

    /// `verify_foreign_transaction` for `request` with the configured ForeignTx domain, 15 Tgas
    /// and 1 yoctoNEAR paid by the engine.
    pub(crate) fn verify_foreign_promise(&self, request: ForeignChainRpcRequest) -> Promise {
        let mut call = VerifyForeignTransactionCall::new(request);
        call.request.domain_id = self.config.foreign_tx_domain;
        Promise::new(self.config.mpc_account.clone()).function_call(
            METHOD_VERIFY_FOREIGN_TRANSACTION.to_string(),
            near_sdk::serde_json::to_vec(&call).expect("request serializes"),
            MPC_DEPOSIT,
            GAS_FOR_MPC_CALL,
        )
    }

    /// `sign` of an EIP-712 digest with the configured secp256k1 domain.
    pub(crate) fn sign_ecdsa_promise(&self, path: &str, digest: [u8; 32]) -> Promise {
        let mut call = SignCall::ecdsa(path, digest);
        call.request.domain_id = self.config.sign_secp256k1_domain;
        self.sign_promise(&call)
    }

    /// `sign` of a Solana message with the configured Ed25519 domain.
    pub(crate) fn sign_eddsa_promise(&self, path: &str, message: Vec<u8>) -> Promise {
        let mut call = SignCall::eddsa(path, message);
        call.request.domain_id = self.config.sign_ed25519_domain;
        self.sign_promise(&call)
    }

    fn sign_promise(&self, call: &SignCall) -> Promise {
        Promise::new(self.config.mpc_account.clone()).function_call(
            METHOD_SIGN.to_string(),
            near_sdk::serde_json::to_vec(call).expect("request serializes"),
            MPC_DEPOSIT,
            GAS_FOR_MPC_CALL,
        )
    }

    /// The ForeignTx response of promise result `index`, or `None` when it failed or does not
    /// parse (nothing is signed by a proof, so both mean the same).
    pub(crate) fn foreign_result(index: u64) -> Option<VerifyForeignTransactionResponse> {
        let bytes = env::promise_result_checked(index, MAX_RESULT_LEN).ok()?;
        near_sdk::serde_json::from_slice(&bytes).ok()
    }

    /// True when the ForeignTx response of promise result 0 attests exactly `expected_hash`.
    pub(crate) fn attestation_matches(expected_hash: &str) -> bool {
        Self::foreign_result(0)
            .is_some_and(|response| hex::encode(response.payload_hash.0) == expected_hash)
    }

    /// The `sign` response of promise result `index`.
    pub(crate) fn sign_result(index: u64) -> MpcResult<SignatureResponse> {
        match env::promise_result_checked(index, MAX_RESULT_LEN) {
            Err(PromiseError::Failed) => MpcResult::Failed,
            Err(_) => MpcResult::Unreadable,
            Ok(bytes) => near_sdk::serde_json::from_slice(&bytes)
                .map_or(MpcResult::Unreadable, MpcResult::Value),
        }
    }

    /// Panics unless the engine keeps [`MPC_BALANCE_RESERVE`] free above its storage.
    pub(crate) fn require_mpc_reserve() {
        let locked = bytes_cost(env::storage_usage());
        require!(
            env::account_balance().as_yoctonear()
                >= locked.saturating_add(MPC_BALANCE_RESERVE.as_yoctonear()),
            "The engine's free balance is below its reserve for MPC requests: send it NEAR"
        );
    }

    /// Stores a new signed-action record for `requester` and returns its id.
    pub(crate) fn new_payout(
        &mut self,
        chain: Chain,
        kind: PayoutKind,
        debit: PayoutDebit,
        requester: &AccountId,
        position_id: Option<PositionId>,
    ) -> PayoutId {
        let id = self.custody.next_payout_id;
        self.custody.next_payout_id += 1;
        let now = env::block_timestamp();
        self.custody.payouts.insert(
            id,
            Payout {
                id: U64(id),
                chain,
                kind,
                debit,
                requester: requester.clone(),
                requested_block: U64(env::block_height()),
                position_id: position_id.map(U64),
                sign_requests: 0,
                status: PayoutStatus::Requested,
                digest: None,
                base: None,
                solana: None,
                created_at: U64(now),
                updated_at: U64(now),
            },
        );
        self.custody
            .account_payouts
            .entry(requester.clone())
            .or_insert_with(|| {
                Vector::new(StorageKey::AccountPayoutList {
                    account: requester.clone(),
                })
            })
            .push(id);
        self.hold(requester);
        self.emit(RoseEvent::PayoutRequested {
            payout_id: U64(id),
            chain,
            requester: requester.clone(),
        });
        id
    }

    /// The payout record, or a panic.
    pub(crate) fn payout(&self, id: PayoutId) -> &Payout {
        self.custody
            .payouts
            .get(&id)
            .unwrap_or_else(|| env::panic_str(&format!("Unknown payout {id}")))
    }

    /// Mutable payout record, or a panic.
    pub(crate) fn payout_mut(&mut self, id: PayoutId) -> &mut Payout {
        self.custody
            .payouts
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str(&format!("Unknown payout {id}")))
    }

    /// Records that the last signature request of payout `id` resolved without a signature, so
    /// the retry may be requested at once instead of after [`PENDING_EXPIRY_BLOCKS`].
    pub(crate) fn mark_request_resolved(&mut self, id: PayoutId) {
        let payout = self.payout_mut(id);
        payout.requested_block = U64(env::block_height().saturating_sub(PENDING_EXPIRY_BLOCKS));
        payout.updated_at = U64(env::block_timestamp());
    }

    /// Requires the attached storage deposit of a signed-action record.
    pub(crate) fn assert_payout_deposit() {
        require!(
            env::attached_deposit() == PAYOUT_STORAGE_DEPOSIT,
            "Attach exactly 0.025 NEAR as the payout storage deposit"
        );
    }
}

/// What a `sign` promise returned.
pub(crate) enum MpcResult<T> {
    /// The promise failed (`PromiseError::Failed`): no signature reached the engine, though a
    /// response arriving after the MPC's yield timeout may still be public.
    Failed,
    /// The promise succeeded but its value cannot be read: a signature may exist.
    Unreadable,
    /// The response.
    Value(T),
}

/// Panics unless the current call has `tgas` left after its own work for the promises it
/// creates: a callback chain that would run out of gas is refused upfront instead of leaving a
/// request behind.
pub(crate) fn require_gas_left(tgas: u64) {
    let left = env::prepaid_gas().saturating_sub(env::used_gas());
    require!(
        left >= Gas::from_tgas(tgas + TGAS_CALL_FEES),
        format!(
            "Attach more gas: this call needs {} Tgas more than it used so far",
            tgas + TGAS_CALL_FEES
        )
    );
}

/// Arguments of `compute_sol_class_id`: the stream's schedule, token amounts as `U64` strings.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StreamflowScheduleArgs {
    pub start_time: u64,
    pub cliff: u64,
    pub cliff_amount: U64,
    pub period: u64,
    pub amount_per_period: U64,
    pub net_amount_deposited: U64,
    pub end_time: u64,
}
