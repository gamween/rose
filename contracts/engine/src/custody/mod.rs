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
//! - The ledger is debited before every `sign` request and refunded only when no signature was
//!   produced (a signature is public and valid the moment the MPC responds). For a joined pair of
//!   Solana signatures the vault signature is never refunded once it exists; a missing fee-payer
//!   signature is re-requested over the same stored message.
//! - Callbacks never panic after a replay key was marked: every validation maps to a refusal or a
//!   cleared key, so a pending key cannot be left behind by a rolled-back callback.
//!
//! Gas: `sign` and `verify_foreign_transaction` get exactly 15 Tgas and 1 yoctoNEAR (the live
//! floor, paid by the engine); callbacks have fixed static gas. Storage: deposit-side records are
//! paid by the engine (bounded by real foreign deposits); every signed action record is paid by
//! an attached [`PAYOUT_STORAGE_DEPOSIT`].
//!
//! Base Sepolia is the only EVM chain: its chain id is the compile-time
//! [`crate::foreign::evm::BASE_SEPOLIA_CHAIN_ID`] (the configured RoseVault is a Base Sepolia
//! deployment).

mod base;
mod events;
mod payouts;
mod solana;
mod types;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, Promise, PromiseError,
};

use crate::foreign::mpc::{
    ForeignChainRpcRequest, SignCall, SignatureResponse, VerifyForeignTransactionCall,
    VerifyForeignTransactionResponse, METHOD_SIGN, METHOD_VERIFY_FOREIGN_TRANSACTION,
};
use crate::foreign::{evm, solana as sol};
use crate::types::{Chain, ClassId, DerivedAddresses, PositionId};
use crate::unlock::{ClassSchedule, SablierLinearStream, StreamflowParams, StreamflowStream};
use crate::{class_id_of, Contract, ContractExt};

pub use base::deposit_units_of;
pub use events::CustodyEvent;
pub use types::*;

/// Storage deposit attached to every method that stores a signed action record (about 1.5 KB
/// with a Solana transaction); kept with the record, which stays as public history.
pub const PAYOUT_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// Blocks after which a pending replay key is considered abandoned (the MPC yield times out after
/// 200 blocks and the callback runs right after), so a callback that ran out of gas cannot block
/// a fact forever.
pub const PENDING_EXPIRY_BLOCKS: u64 = 600;

/// Gas attached to `sign` and `verify_foreign_transaction`.
const GAS_FOR_MPC_CALL: Gas = Gas::from_tgas(15);
/// Deposit attached to `sign` and `verify_foreign_transaction` (excess is refunded by the MPC).
const MPC_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Gas attached to each `derived_public_key` view call.
const GAS_FOR_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// Static gas of the bootstrap callback (parses three keys, writes the config).
const GAS_FOR_BOOTSTRAP_CALLBACK: Gas = Gas::from_tgas(10);
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
    SolDeposits,
    SolStreams,
    Releasing,
}

/// Custody state, one field of the contract.
#[near]
pub struct CustodyState {
    replays: LookupMap<ReplayKey, ReplayState>,
    refused: LookupMap<ReplayKey, RefusedDeposit>,
    payouts: LookupMap<PayoutId, Payout>,
    next_payout_id: PayoutId,
    account_payouts: LookupMap<AccountId, Vec<PayoutId>>,
    sol_deposits: LookupMap<String, SolDeposit>,
    sol_streams: LookupMap<PositionId, SolStreamInfo>,
    /// Positions with an in-kind release in flight.
    releasing: LookupMap<PositionId, PayoutId>,
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
    /// are stored is refused, and a failed request can be retried. Attach about 50 Tgas.
    pub fn bootstrap(&mut self) -> Promise {
        require!(
            self.config.derived_addresses.is_none(),
            "Already bootstrapped"
        );
        let engine = env::current_account_id();
        let derive = |path: &str, domain_id: u64| {
            let args = near_sdk::serde_json::json!({
                "path": path,
                "predecessor": engine,
                "domain_id": domain_id,
            });
            Promise::new(self.config.mpc_account.clone()).function_call(
                "derived_public_key".to_string(),
                near_sdk::serde_json::to_vec(&args).expect("args serialize"),
                NearToken::from_yoctonear(0),
                GAS_FOR_DERIVED_KEY,
            )
        };
        events::emit(CustodyEvent::BootstrapRequested);
        derive(PATH_VAULT_BASE, self.config.sign_secp256k1_domain)
            .and(derive(PATH_VAULT_SOL, self.config.sign_ed25519_domain))
            .and(derive(PATH_GAS_SOL, self.config.sign_ed25519_domain))
            .then(
                Self::ext(engine)
                    .with_static_gas(GAS_FOR_BOOTSTRAP_CALLBACK)
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
                events::emit(CustodyEvent::Bootstrapped {
                    vault_base: derived.vault_base.clone(),
                    vault_sol: derived.vault_sol.clone(),
                    gas_sol: derived.gas_sol.clone(),
                });
                self.config.derived_addresses = Some(derived);
                true
            }
            None => {
                events::emit(CustodyEvent::BootstrapFailed);
                false
            }
        }
    }

    /// YoctoNEAR to attach to a deposit registration so that `account` can hold units of
    /// `class_id` (0 when it already can); the unused part is returned.
    pub fn registration_deposit_for(&self, account: AccountId, class_id: ClassId) -> U128 {
        U128(self.holder_storage_needed(&account, &class_id))
    }

    /// State of a replay key, or `None` when the fact was never requested.
    pub fn get_replay(&self, key: ReplayKey) -> Option<ReplayState> {
        self.custody.replays.get(&key).copied()
    }

    /// A refused deposit, or `None`.
    pub fn get_refused_deposit(&self, key: ReplayKey) -> Option<RefusedDeposit> {
        self.custody.refused.get(&key).cloned()
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
            cliff_amount: schedule.cliff_amount,
            period: schedule.period,
            amount_per_period: schedule.amount_per_period,
            net_amount_deposited: schedule.net_amount_deposited,
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
    /// returning the remainder. Panics when the budget is short.
    pub(crate) fn cover_holder_storage(
        &mut self,
        account: &AccountId,
        class_id: &ClassId,
        budget: u128,
    ) -> u128 {
        let budget = self.ensure_registered(account, budget);
        let shortfall = self.storage_shortfall(account, self.holding_row_bytes(account, class_id));
        require!(
            budget >= shortfall,
            format!("Attach the storage deposit for {account}: {shortfall} yoctoNEAR more")
        );
        self.top_up_storage(account, shortfall);
        budget - shortfall
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

    /// Marks `key` pending, or panics when the fact is consumed or a request is in flight.
    pub(crate) fn mark_pending(&mut self, key: &ReplayKey) {
        let height = env::block_height();
        match self.custody.replays.get(key) {
            Some(ReplayState::Consumed) => env::panic_str("Already registered"),
            Some(ReplayState::Pending { since_block })
                if height < since_block.saturating_add(PENDING_EXPIRY_BLOCKS) =>
            {
                env::panic_str("A verification of this fact is already in flight")
            }
            _ => {}
        }
        self.custody.replays.insert(
            key.clone(),
            ReplayState::Pending {
                since_block: height,
            },
        );
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

    /// The ForeignTx response of promise result `index`, or the failure.
    pub(crate) fn foreign_result(
        index: u64,
    ) -> Result<VerifyForeignTransactionResponse, PromiseError> {
        let bytes = env::promise_result_checked(index, MAX_RESULT_LEN)?;
        near_sdk::serde_json::from_slice(&bytes).map_err(|_| PromiseError::Failed)
    }

    /// The `sign` response of promise result `index`, or the failure.
    pub(crate) fn sign_result(index: u64) -> Result<SignatureResponse, PromiseError> {
        let bytes = env::promise_result_checked(index, MAX_RESULT_LEN)?;
        near_sdk::serde_json::from_slice(&bytes).map_err(|_| PromiseError::Failed)
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
                position_id: position_id.map(U64),
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
            .or_default()
            .push(id);
        events::emit(CustodyEvent::PayoutRequested {
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

    /// Requires the attached storage deposit of a signed-action record.
    pub(crate) fn assert_payout_deposit() {
        require!(
            env::attached_deposit() == PAYOUT_STORAGE_DEPOSIT,
            "Attach exactly 0.02 NEAR as the payout storage deposit"
        );
    }
}

/// Arguments of `compute_sol_class_id`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StreamflowScheduleArgs {
    pub start_time: u64,
    pub cliff: u64,
    pub cliff_amount: u64,
    pub period: u64,
    pub amount_per_period: u64,
    pub net_amount_deposited: u64,
    pub end_time: u64,
}
