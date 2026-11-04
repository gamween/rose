//! Base Sepolia deposits (spec section 7.1): `StreamDeposited` and `CashDeposited` logs of
//! RoseVault attested by the MPC, and the return of refused deposits.
//!
//! The engine rebuilds the log from the caller's typed values with RoseVault as emitter, so a
//! log emitted by any other contract, or any value differing from the receipt, produces a
//! different payload hash than the one the MPC signs, and the deposit is not registered.
//!
//! Stream tokens: RoseVault cannot detect fee-on-transfer or rebasing ERC-20s behind a Sablier
//! stream (it never pulls the tokens itself). The engine registers streams of any token; a class
//! whose token does not deliver exactly what Sablier streams pays out less than the units
//! promise, and the app labels such tokens from its own token list.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use super::types::{
    BaseLogLocation, BaseSignature, CashDepositedFields, PayoutDebit, PayoutKind, PayoutStatus,
    RefusedAsset, RefusedDeposit, ReplayKey, StreamDepositedFields,
};
use super::{
    require_gas_left, MpcResult, GAS_FOR_RECORD_CALLBACK, PENDING_EXPIRY_BLOCKS,
    RECORD_STORAGE_DEPOSIT, TGAS_BASE_SIGN, TGAS_PROOF,
};
use crate::foreign::evm::{
    self, CashDeposited, Eip712Domain, EvmSignature, LogLocation, ReleaseAuthorization,
    StreamDeposited,
};
use crate::foreign::mpc::{
    payload_hash, Bytes32, EvmExtractor, EvmFinality, EvmRpcRequest, ExtractedValue,
    ForeignChainRpcRequest,
};
use crate::math::{self, ONE};
use crate::types::{Chain, ClassId, Position, PositionSource, PositionState, Venue};
use crate::unlock::{ClassSchedule, SablierLinearStream};
use crate::{Contract, ContractExt, RoseEvent};

/// Static gas of the signature callback of a Base authorization (1.5 Tgas measured; the margin
/// keeps a signed authorization from being lost to a starved callback).
const GAS_FOR_BASE_SIGN_CALLBACK: Gas = GAS_FOR_RECORD_CALLBACK;

#[near]
impl Contract {
    /// Registers a Sablier stream deposited into RoseVault (spec 7.1 step 3). The caller gives
    /// the receipt location of the `StreamDeposited` log and its decoded fields; the engine asks
    /// the MPC to attest the log at `Safe` finality and, in the callback, compares the attested
    /// payload hash with its own, checks the canonical lockup, non-cancelability and
    /// transferability, builds the class from the attested schedule and decimals, and mints
    /// `deposited` units to `nearAccount` from the deposit checkpoint. A genuine log the engine
    /// refuses is recorded so `return_refused_deposit` can send the stream back to its sender.
    /// Anyone; attach `registration_deposit_for(nearAccount, class)` (the records' storage,
    /// kept, plus the credited account's holder storage, whose unused part is returned; without
    /// a valid account or class, just [`RECORD_STORAGE_DEPOSIT`]) and 80 Tgas (after its own work
    /// the call keeps 50 Tgas for the proof and its 20 Tgas callback, so 50 attached fails). A
    /// failure on
    /// the MPC side (wrong values, unknown transaction, wrong log index, finality not reached)
    /// surfaces after about two minutes; the key is cleared, everything attached is returned and
    /// the call can be retried.
    #[payable]
    pub fn register_base_deposit(
        &mut self,
        location: BaseLogLocation,
        fields: StreamDepositedFields,
    ) -> Promise {
        Self::require_mpc_reserve();
        let fields = canonical_stream_fields(fields);
        let event = stream_deposited(&fields);
        let needed = match self.base_deposit_target(&fields) {
            Some((account, class_id)) => {
                RECORD_STORAGE_DEPOSIT.as_yoctonear()
                    + self.holder_storage_needed(&account, &class_id)
            }
            None => RECORD_STORAGE_DEPOSIT.as_yoctonear(),
        };
        require!(
            env::attached_deposit().as_yoctonear() >= needed,
            format!("Attach {needed} yoctoNEAR of storage (registration_deposit_for)")
        );
        let (key, request, hash) = self.base_log_request(&location, event.topics(), &event.data());
        self.mark_pending(&key);
        if let Some((account, _)) = self.base_deposit_target(&fields) {
            self.hold_for_key(&key, &account);
        }
        self.emit(RoseEvent::DepositVerificationRequested { key: key.clone() });
        require_gas_left(TGAS_PROOF);
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                .on_base_deposit_verified(
                    key,
                    hex::encode(hash),
                    fields,
                    env::predecessor_account_id(),
                    U128(env::attached_deposit().as_yoctonear()),
                ),
        )
    }

    /// Deposit callback: compares the attested hash, consumes the key and registers the
    /// position, or records the refusal. Called by the contract itself; never panics once the
    /// key is pending.
    #[private]
    pub fn on_base_deposit_verified(
        &mut self,
        key: ReplayKey,
        expected_hash: String,
        fields: StreamDepositedFields,
        caller: AccountId,
        attached: U128,
    ) -> bool {
        if !self.is_pending(&key) {
            Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(attached.0));
            return false;
        }
        self.release_key_hold(&key);
        if !self.attested(&key, &expected_hash) {
            Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(attached.0));
            return false;
        }
        let budget = attached
            .0
            .saturating_sub(RECORD_STORAGE_DEPOSIT.as_yoctonear());
        match self.admit_base_stream(&key, &fields, budget) {
            Ok(remainder) => {
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(remainder))
            }
            Err(reason) => {
                self.refuse(
                    &key,
                    RefusedDeposit {
                        chain: Chain::Base,
                        asset: RefusedAsset::BaseStream {
                            lockup: fields.lockup.clone(),
                            stream_id: fields.stream_id,
                        },
                        return_to: fields.sender.clone(),
                        near_account: fields.near_account.clone(),
                        reason,
                        return_payout: None,
                        refused_at: U64(env::block_timestamp()),
                    },
                );
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(budget));
                return false;
            }
        }
        true
    }

    /// Registers a `CashDeposited` log of RoseVault: credits `amount` of `token` to
    /// `nearAccount`'s `Base(token)` venue. Every token is credited, so a deposit in a token the
    /// engine does not accept for rounds (or earmarked for a round that does not exist) is never
    /// lost: it can only leave again through `withdraw_base_cash`, since rounds refuse venues
    /// outside the accepted list. Anyone; attach exactly [`RECORD_STORAGE_DEPOSIT`] for the
    /// replay key, the credited account's cash row and, when it has none, its registration
    /// (kept; returned when the log is not attested) and 80 Tgas.
    #[payable]
    pub fn register_base_cash(
        &mut self,
        location: BaseLogLocation,
        fields: CashDepositedFields,
    ) -> Promise {
        Self::require_mpc_reserve();
        require!(
            env::attached_deposit() == RECORD_STORAGE_DEPOSIT,
            "Attach exactly 0.015 NEAR as the record storage deposit"
        );
        let fields = canonical_cash_fields(fields);
        let event = cash_deposited(&fields);
        let (key, request, hash) = self.base_log_request(&location, event.topics(), &event.data());
        self.mark_pending(&key);
        self.emit(RoseEvent::DepositVerificationRequested { key: key.clone() });
        require_gas_left(TGAS_PROOF);
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                .on_base_cash_verified(
                    key,
                    hex::encode(hash),
                    fields,
                    env::predecessor_account_id(),
                ),
        )
    }

    /// Cash deposit callback: credits the venue once the log is attested. Called by the
    /// contract itself.
    #[private]
    pub fn on_base_cash_verified(
        &mut self,
        key: ReplayKey,
        expected_hash: String,
        fields: CashDepositedFields,
        caller: AccountId,
    ) -> bool {
        if !self.is_pending(&key) || !self.attested(&key, &expected_hash) {
            Self::refund_registration_deposit(&caller, RECORD_STORAGE_DEPOSIT);
            return false;
        }
        let Ok(account) = fields.near_account.parse::<AccountId>() else {
            self.refuse_cash(&key, "nearAccount is not a valid NEAR account id");
            return false;
        };
        if fields.amount.0 == 0 {
            self.refuse_cash(&key, "amount is zero");
            return false;
        }
        let token = fields.token.clone();
        let venue = Venue::Base {
            token: token.clone(),
        };
        let accepted = self.venue_accepted(&venue);
        self.pay_cash_row(&account, &venue);
        self.credit_cash(&account, &venue, fields.amount.0);
        self.emit(RoseEvent::CashDeposited {
            account: account.clone(),
            venue,
            amount: fields.amount,
        });
        self.emit(RoseEvent::BaseCashRegistered {
            key: key.clone(),
            account,
            token,
            amount: fields.amount,
            round_id: U64(fields.round_id),
            accepted,
        });
        true
    }
}

impl Contract {
    /// The replay key, ForeignTx request and expected payload hash of a RoseVault log.
    fn base_log_request(
        &self,
        location: &BaseLogLocation,
        topics: Vec<[u8; 32]>,
        data: &[u8],
    ) -> (ReplayKey, ForeignChainRpcRequest, [u8; 32]) {
        let tx_hash = parse_word(&location.tx_hash, "tx_hash");
        let block_hash = parse_word(&location.block_hash, "block_hash");
        let emitter = evm::parse_address(&self.config.rose_vault).expect("validated at init");
        let log = LogLocation {
            transaction_hash: tx_hash,
            transaction_index: location.transaction_index,
            block_hash,
            block_number: location.block_number,
            log_index: location.log_index,
        }
        .evm_log(emitter, topics, data);
        let request = ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: Bytes32(tx_hash),
            extractors: vec![EvmExtractor::Log {
                log_index: location.log_index,
            }],
            finality: EvmFinality::Safe,
        });
        let hash = payload_hash(request.clone(), vec![ExtractedValue::log(log)]);
        let key = ReplayKey::BaseLog {
            tx_hash: hex::encode(tx_hash),
            log_index: location.log_index,
        };
        (key, request, hash)
    }

    /// Reads the ForeignTx result of a deposit callback: `true` when the attested hash equals
    /// `expected_hash` and the key was consumed by this callback; otherwise the pending key is
    /// cleared (or a duplicate callback is ignored).
    pub(super) fn attested(&mut self, key: &ReplayKey, expected_hash: &str) -> bool {
        let Some(response) = Self::foreign_result(0) else {
            self.clear_pending(key);
            self.emit(RoseEvent::DepositVerificationFailed { key: key.clone() });
            return false;
        };
        if hex::encode(response.payload_hash.0) != expected_hash {
            self.clear_pending(key);
            self.emit(RoseEvent::DepositMismatch { key: key.clone() });
            return false;
        }
        self.consume(key)
    }

    /// Records a refused deposit.
    pub(super) fn refuse(&mut self, key: &ReplayKey, refused: RefusedDeposit) {
        self.emit(RoseEvent::DepositRefused {
            key: key.clone(),
            reason: refused.reason.clone(),
        });
        self.custody.refused.insert(key.clone(), refused);
    }

    /// Pays the storage of `account`'s new cash row in `venue` (and of its registration, when it
    /// has none) out of the record deposit the registration kept, so the credited account never
    /// needs to have registered before its Base cash arrives.
    fn pay_cash_row(&mut self, account: &AccountId, venue: &Venue) {
        let mut bytes = self.cash_row_bytes_needed(account, venue);
        if bytes == 0 {
            return;
        }
        if !self.is_registered(account) {
            bytes += crate::STORAGE_ACCOUNT_BYTES;
        }
        let budget = crate::storage::bytes_cost(bytes);
        let rest = self.register_with_budget(account, budget);
        self.top_up_storage(account, rest);
    }

    fn refuse_cash(&mut self, key: &ReplayKey, reason: &str) {
        self.emit(RoseEvent::DepositRefused {
            key: key.clone(),
            reason: reason.to_string(),
        });
    }

    /// The account and class a `StreamDeposited` log would credit, when its values are
    /// admissible (used to size the storage deposit before the request).
    fn base_deposit_target(&self, fields: &StreamDepositedFields) -> Option<(AccountId, ClassId)> {
        let account = fields.near_account.parse::<AccountId>().ok()?;
        let stream = SablierLinearStream::new(stream_deposited(fields).sablier_params()).ok()?;
        let schedule = ClassSchedule::from_sablier(&stream, fields.decimals).ok()?;
        let class_id = crate::class_id_of(Chain::Base, &fields.token, fields.decimals, &schedule);
        Some((account, class_id))
    }

    /// Validates an attested `StreamDeposited` log against the class rules, then creates the
    /// class if needed, registers the position and mints the units. Returns what is left of the
    /// storage `budget` after the holder's registration.
    fn admit_base_stream(
        &mut self,
        key: &ReplayKey,
        fields: &StreamDepositedFields,
        budget: u128,
    ) -> Result<u128, String> {
        if fields.lockup != self.config.sablier_lockup {
            return Err("stream is not on the canonical Sablier Lockup".to_string());
        }
        if fields.cancelable {
            return Err("stream is cancelable".to_string());
        }
        if !fields.transferable {
            return Err("stream is not transferable".to_string());
        }
        if fields.withdrawn.0 >= fields.deposited.0 {
            return Err("stream is depleted".to_string());
        }
        let account = fields
            .near_account
            .parse::<AccountId>()
            .map_err(|_| "nearAccount is not a valid NEAR account id".to_string())?;
        let stream = SablierLinearStream::new(stream_deposited(fields).sablier_params())
            .map_err(|e| e.to_string())?;
        let schedule =
            ClassSchedule::from_sablier(&stream, fields.decimals).map_err(|e| e.to_string())?;
        let class_id =
            self.ensure_class(Chain::Base, fields.token.clone(), fields.decimals, schedule);
        let remainder = self.cover_holder_storage(&account, &class_id, budget);
        let (units, checkpoint) = self.deposit_units(
            &class_id,
            Some(fields.timestamp),
            fields.withdrawn.0,
            fields.deposited.0,
        );
        let position_id = self.insert_position(Position {
            class_id: class_id.clone(),
            source: PositionSource::BaseStream {
                lockup: self.config.sablier_lockup.clone(),
                stream_id: U128(u128::from(fields.stream_id)),
            },
            allocation: U128(units),
            depositor: account.clone(),
            deposited_at: U64(env::block_timestamp()),
            state: PositionState::Held,
        });
        self.mint_units_owed(&class_id, &account, units, checkpoint);
        self.emit(RoseEvent::DepositRegistered {
            key: key.clone(),
            chain: Chain::Base,
            position_id: U64(position_id),
            class_id,
            account,
            units: U128(units),
            checkpoint: U128(checkpoint),
        });
        Ok(remainder)
    }

    /// Units and checkpoint minted for a deposit of `allocation` of which `withdrawn` was already
    /// paid to the holder; see [`deposit_units_of`].
    pub(super) fn deposit_units(
        &self,
        class_id: &ClassId,
        deposit_time: Option<u64>,
        withdrawn: u128,
        allocation: u128,
    ) -> (u128, u128) {
        deposit_units_of(
            &self.class(class_id).schedule,
            self.fraction_now(class_id),
            deposit_time,
            withdrawn,
            allocation,
        )
    }

    /// Signs `Release(lockup, streamId, to, vestedToRecipient = true, id)` for a refused Base
    /// stream: no unit was minted for it, so what vested while the vault held it goes back to
    /// `to` with the stream.
    pub(super) fn return_base_stream(
        &mut self,
        key: &ReplayKey,
        lockup: &str,
        stream_id: u64,
        to: &str,
    ) -> Promise {
        let caller = env::predecessor_account_id();
        let id = self.new_payout(
            Chain::Base,
            PayoutKind::BaseRelease {
                lockup: lockup.to_string(),
                stream_id,
                to: to.to_string(),
                vested_to_recipient: true,
            },
            PayoutDebit::None,
            &caller,
            None,
        );
        self.custody
            .refused
            .get_mut(key)
            .expect("refused record exists")
            .return_payout = Some(U64(id));
        let authorization = ReleaseAuthorization {
            lockup: evm::parse_address(lockup).expect("stored lowercase address"),
            stream_id,
            to: evm::parse_address(to).expect("stored lowercase address"),
            vested_to_recipient: true,
            id,
        };
        self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
    }

    /// The EIP-712 domain of the configured RoseVault.
    pub(super) fn eip712_domain(&self) -> Eip712Domain {
        Eip712Domain {
            chain_id: self.config.base_chain_id,
            verifying_contract: evm::parse_address(&self.config.rose_vault)
                .expect("validated at init"),
        }
    }

    /// Requests the `vault/base` signature of `digest` for payout `id`. The digest must be a
    /// canonical secp256k1 scalar, which a keccak digest fails with probability about 2^-128;
    /// the panic reverts the whole call (the payout record and its id included), so the next
    /// request simply gets the next id and a different digest.
    pub(super) fn request_base_signature(&mut self, id: u64, digest: [u8; 32]) -> Promise {
        require!(
            evm::is_valid_ecdsa_payload(&digest),
            "Digest is not a valid ECDSA payload: the call is reverted, request again"
        );
        Self::require_mpc_reserve();
        let payout = self.payout_mut(id);
        payout.digest = Some(hex::encode(digest));
        payout.sign_requests += 1;
        payout.requested_block = U64(env::block_height());
        require_gas_left(TGAS_BASE_SIGN);
        self.sign_ecdsa_promise(super::PATH_VAULT_BASE, digest)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_BASE_SIGN_CALLBACK)
                    .on_base_signed(U64(id)),
            )
    }
}

#[near]
impl Contract {
    /// Base signature callback: stores `(r, s, v)` and completes the action. A Base
    /// authorization is never refunded: a signature of its digest could surface after the
    /// request failed (an MPC response arriving past the yield timeout is public), and it would
    /// stay executable on RoseVault forever. A failed request makes the payout retryable at once
    /// (`retry_base_signature`); an unreadable response leaves it `Requested` for
    /// `submit_base_signature` or a retry after [`PENDING_EXPIRY_BLOCKS`]. A callback for a
    /// payout no longer `Requested` changes nothing. Called by the contract itself.
    #[private]
    pub fn on_base_signed(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        if self.payout(id).status != PayoutStatus::Requested {
            return false;
        }
        let digest = self.base_digest(id);
        let signature = match Self::sign_result(0) {
            MpcResult::Failed => {
                self.mark_request_resolved(id);
                return false;
            }
            MpcResult::Unreadable => None,
            MpcResult::Value(response) => response
                .as_secp256k1()
                .and_then(|signature| EvmSignature::from_mpc(signature).ok()),
        };
        match signature.filter(|signature| self.signed_by_vault(&digest, signature)) {
            Some(signature) => {
                self.store_base_signature(id, &signature);
                true
            }
            None => false,
        }
    }

    /// Completes a Base authorization whose signature the callback could not read: `(r, s, v)`
    /// (hex, `v` in `{27, 28}`; a high `s` is normalized) must recover to the vault's derived
    /// address over the stored digest. Anyone, while the payout is `Requested`.
    pub fn submit_base_signature(&mut self, payout_id: U64, r: String, s: String, v: u8) {
        let id = payout_id.0;
        let payout = self.payout(id);
        require!(payout.chain == Chain::Base, "Not a Base authorization");
        require!(
            payout.status == PayoutStatus::Requested && payout.sign_requests > 0,
            "Authorization is not awaiting its signature"
        );
        require!(v == 27 || v == 28, "v must be 27 or 28");
        let signature = EvmSignature::from_parts(parse_word(&r, "r"), parse_word(&s, "s"), v - 27)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid signature: {e:?}")));
        let digest = self.base_digest(id);
        require!(
            self.signed_by_vault(&digest, &signature),
            "Signature does not recover to the vault's derived address"
        );
        self.store_base_signature(id, &signature);
    }

    /// Re-requests the `vault/base` signature of a Base authorization still `Requested`, once its
    /// last request failed or [`PENDING_EXPIRY_BLOCKS`] blocks after it (its callback ran out of
    /// gas): the same digest and id are signed again and nothing is debited. Anyone; attach
    /// 80 Tgas.
    pub fn retry_base_signature(&mut self, payout_id: U64) -> Promise {
        let payout = self.payout(payout_id.0).clone();
        require!(payout.chain == Chain::Base, "Not a Base authorization");
        require!(
            payout.status == PayoutStatus::Requested,
            "Authorization is not awaiting its signature"
        );
        require!(
            env::block_height() >= payout.requested_block.0 + PENDING_EXPIRY_BLOCKS,
            "The last request is still in flight"
        );
        let digest = self.base_digest(payout_id.0);
        self.request_base_signature(payout_id.0, digest)
    }
}

impl Contract {
    /// The stored EIP-712 digest of a Base authorization.
    fn base_digest(&self, id: u64) -> [u8; 32] {
        self.payout(id)
            .digest
            .as_deref()
            .and_then(crate::foreign::mpc::parse_hex_array)
            .unwrap_or_else(|| env::panic_str("No digest stored"))
    }

    /// True when `signature` over `digest` recovers to the bootstrapped `vault/base` address.
    fn signed_by_vault(&self, digest: &[u8; 32], signature: &EvmSignature) -> bool {
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&signature.r);
        rs[32..].copy_from_slice(&signature.s);
        env::ecrecover(digest, &rs, signature.v - 27, true)
            .map(|key| evm::format_address(&evm::address_from_public_key(&key)))
            .is_some_and(|address| address == self.derived().vault_base)
    }

    /// Stores a verified signature and completes the authorization.
    fn store_base_signature(&mut self, id: u64, signature: &EvmSignature) {
        self.payout_mut(id).base = Some(BaseSignature {
            r: hex::encode(signature.r),
            s: hex::encode(signature.s),
            v: signature.v,
        });
        self.complete_payout(id);
    }
}

/// `(units, checkpoint)` minted for a deposit of `allocation` base units of which `withdrawn`
/// was already paid to the holder, so that the units' lifetime claim
/// `units * (ONE - checkpoint) / ONE` never exceeds `allocation - withdrawn`, what the stream
/// will still pay the vault.
///
/// The checkpoint is the class fraction at the deposit time (tokens unlocked between the
/// deposit and its registration belong to the depositor), raised to `paid = ceil(ONE *
/// withdrawn / allocation)`: the class fraction is lowered by a safety margin, which on its own
/// would let the units claim up to one base unit per whole token more than the stream pays. The
/// checkpoint never exceeds `f(now)` (a mint cannot start in the future), and in the rare case
/// where `paid` is still above `f(now)` at registration the units are reduced instead to the
/// largest `units` with `floor(units * (ONE - f(now)) / ONE) <= allocation - withdrawn`;
/// otherwise the full allocation is minted.
pub fn deposit_units_of(
    schedule: &ClassSchedule,
    f_now: u128,
    deposit_time: Option<u64>,
    withdrawn: u128,
    allocation: u128,
) -> (u128, u128) {
    let at_deposit = deposit_time.map_or(0, |t| schedule.fraction(t));
    let paid = math::mul_div_ceil(ONE, withdrawn, allocation).unwrap_or(ONE);
    let checkpoint = at_deposit.max(paid).min(f_now);
    let units = if paid <= f_now {
        allocation
    } else {
        math::mul_div_ceil(ONE, allocation - withdrawn + 1, ONE - f_now)
            .map_or(allocation, |bound| bound.saturating_sub(1))
            .min(allocation)
    };
    (units, checkpoint)
}

/// `fields` with every address in its canonical spelling (see [`evm::canonical_address`]).
/// Applied first by every Base registration, so the class id, the venue, the lockup check and
/// the return address never depend on how the caller spelled an address.
fn canonical_stream_fields(fields: StreamDepositedFields) -> StreamDepositedFields {
    StreamDepositedFields {
        sender: canonical_address(&fields.sender, "sender"),
        lockup: canonical_address(&fields.lockup, "lockup"),
        token: canonical_address(&fields.token, "token"),
        ..fields
    }
}

/// `fields` with every address in its canonical spelling.
fn canonical_cash_fields(fields: CashDepositedFields) -> CashDepositedFields {
    CashDepositedFields {
        sender: canonical_address(&fields.sender, "sender"),
        token: canonical_address(&fields.token, "token"),
        ..fields
    }
}

/// The canonical spelling of an EVM address argument, or a panic naming it.
pub(crate) fn canonical_address(text: &str, what: &str) -> String {
    evm::canonical_address(text)
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be a 20-byte hex address")))
}

/// The typed event of decoded `StreamDeposited` fields.
fn stream_deposited(fields: &StreamDepositedFields) -> StreamDeposited {
    StreamDeposited {
        sender: parse_address(&fields.sender, "sender"),
        stream_id: fields.stream_id,
        near_account: fields.near_account.clone(),
        lockup: parse_address(&fields.lockup, "lockup"),
        token: parse_address(&fields.token, "token"),
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
    }
}

/// The typed event of decoded `CashDeposited` fields.
fn cash_deposited(fields: &CashDepositedFields) -> CashDeposited {
    CashDeposited {
        sender: parse_address(&fields.sender, "sender"),
        token: parse_address(&fields.token, "token"),
        round_id: fields.round_id,
        near_account: fields.near_account.clone(),
        amount: fields.amount.0,
        timestamp: fields.timestamp,
    }
}

fn parse_address(text: &str, what: &str) -> evm::Address {
    evm::parse_address(text)
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be a 20-byte hex address")))
}

fn parse_word(text: &str, what: &str) -> [u8; 32] {
    crate::foreign::mpc::parse_hex_array(text)
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be a 32-byte hex value")))
}
