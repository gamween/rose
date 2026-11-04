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

use super::events::{emit, CustodyEvent};
use super::types::{
    BaseLogLocation, CashDepositedFields, PayoutDebit, PayoutKind, RefusedAsset, RefusedDeposit,
    ReplayKey, StreamDepositedFields,
};
use crate::foreign::evm::{
    self, CashDeposited, Eip712Domain, LogLocation, ReleaseAuthorization, StreamDeposited,
    BASE_SEPOLIA_CHAIN_ID,
};
use crate::foreign::mpc::{
    payload_hash, Bytes32, EvmExtractor, EvmFinality, EvmRpcRequest, ExtractedValue,
    ForeignChainRpcRequest,
};
use crate::math::{self, ONE};
use crate::types::{Chain, ClassId, Position, PositionSource, PositionState, Venue};
use crate::unlock::{ClassSchedule, SablierLinearStream};
use crate::{Contract, ContractExt, RoseEvent};

/// Static gas of the deposit callbacks (hash comparison, class lookup, mint).
const GAS_FOR_DEPOSIT_CALLBACK: Gas = Gas::from_tgas(15);
/// Prepaid gas a registration needs: the request, 15 Tgas to the MPC and the callback.
const GAS_FOR_REGISTRATION: Gas = Gas::from_tgas(50);
/// Static gas of the signature callback of a Base authorization.
pub(super) const GAS_FOR_BASE_SIGN_CALLBACK: Gas = Gas::from_tgas(5);
/// Prepaid gas a Base authorization request needs.
pub(super) const GAS_FOR_BASE_AUTHORIZATION: Gas = Gas::from_tgas(30);

#[near]
impl Contract {
    /// Registers a Sablier stream deposited into RoseVault (spec 7.1 step 3). The caller gives
    /// the receipt location of the `StreamDeposited` log and its decoded fields; the engine asks
    /// the MPC to attest the log at `Safe` finality and, in the callback, compares the attested
    /// payload hash with its own, checks the canonical lockup, non-cancelability and
    /// transferability, builds the class from the attested schedule and decimals, and mints
    /// `deposited` units to `nearAccount` from the deposit checkpoint. A genuine log the engine
    /// refuses is recorded so `return_refused_deposit` can send the stream back to its sender.
    /// Anyone; attach the registration deposit of the credited account when it is not a unit
    /// holder yet (returned when unused) and at least 50 Tgas. A failure on the MPC side (wrong
    /// values, unknown transaction, wrong log index, finality not reached) surfaces after about
    /// two minutes; the key is cleared and the call can be retried.
    #[payable]
    pub fn register_base_deposit(
        &mut self,
        location: BaseLogLocation,
        fields: StreamDepositedFields,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_FOR_REGISTRATION,
            "At least 50 Tgas are required to register a deposit"
        );
        let event = stream_deposited(&fields);
        if let Some((account, class_id)) = self.base_deposit_target(&fields) {
            require!(
                env::attached_deposit().as_yoctonear()
                    >= self.holder_storage_needed(&account, &class_id),
                format!("Attach the storage deposit for {account} (registration_deposit_for)")
            );
        }
        let (key, request, hash) = self.base_log_request(&location, event.topics(), &event.data());
        self.mark_pending(&key);
        emit(CustodyEvent::DepositVerificationRequested { key: key.clone() });
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_DEPOSIT_CALLBACK)
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
        let attached = NearToken::from_yoctonear(attached.0);
        if !self.attested(&key, &expected_hash) {
            Self::refund_registration_deposit(&caller, attached);
            return false;
        }
        match self.admit_base_stream(&key, &fields, attached.as_yoctonear()) {
            Ok(remainder) => {
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(remainder))
            }
            Err(reason) => {
                self.refuse(
                    &key,
                    RefusedDeposit {
                        chain: Chain::Base,
                        asset: RefusedAsset::BaseStream {
                            lockup: fields.lockup.to_lowercase(),
                            stream_id: fields.stream_id,
                        },
                        return_to: fields.sender.to_lowercase(),
                        near_account: fields.near_account.clone(),
                        reason,
                        return_payout: None,
                        refused_at: U64(env::block_timestamp()),
                    },
                );
                Self::refund_registration_deposit(&caller, attached);
                return false;
            }
        }
        true
    }

    /// Registers a `CashDeposited` log of RoseVault: credits `amount` of `token` to
    /// `nearAccount`'s `Base(token)` venue. Every token is credited, so a deposit in a token the
    /// engine does not accept for rounds (or earmarked for a round that does not exist) is never
    /// lost: it can only leave again through `withdraw_base_cash`, since rounds refuse venues
    /// outside the accepted list. Anyone; at least 50 Tgas.
    pub fn register_base_cash(
        &mut self,
        location: BaseLogLocation,
        fields: CashDepositedFields,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_FOR_REGISTRATION,
            "At least 50 Tgas are required to register a deposit"
        );
        let event = cash_deposited(&fields);
        let (key, request, hash) = self.base_log_request(&location, event.topics(), &event.data());
        self.mark_pending(&key);
        emit(CustodyEvent::DepositVerificationRequested { key: key.clone() });
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_DEPOSIT_CALLBACK)
                .on_base_cash_verified(key, hex::encode(hash), fields),
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
    ) -> bool {
        if !self.attested(&key, &expected_hash) {
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
        let token = fields.token.to_lowercase();
        let venue = Venue::Base {
            token: token.clone(),
        };
        let accepted = self.venue_accepted(&venue);
        self.credit_cash(&account, &venue, fields.amount.0);
        self.emit(RoseEvent::CashDeposited {
            account: account.clone(),
            venue,
            amount: fields.amount,
        });
        emit(CustodyEvent::BaseCashRegistered {
            key: key.clone(),
            account,
            token,
            amount: fields.amount,
            round_id: fields.round_id,
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
        let Ok(response) = Self::foreign_result(0) else {
            self.clear_pending(key);
            emit(CustodyEvent::DepositVerificationFailed { key: key.clone() });
            return false;
        };
        if hex::encode(response.payload_hash.0) != expected_hash {
            self.clear_pending(key);
            emit(CustodyEvent::DepositMismatch { key: key.clone() });
            return false;
        }
        self.consume(key)
    }

    /// Records a refused deposit.
    pub(super) fn refuse(&mut self, key: &ReplayKey, refused: RefusedDeposit) {
        emit(CustodyEvent::DepositRefused {
            key: key.clone(),
            reason: refused.reason.clone(),
        });
        self.custody.refused.insert(key.clone(), refused);
    }

    fn refuse_cash(&mut self, key: &ReplayKey, reason: &str) {
        emit(CustodyEvent::DepositRefused {
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
        let class_id = crate::class_id_of(
            Chain::Base,
            &fields.token.to_lowercase(),
            fields.decimals,
            &schedule,
        );
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
        if fields.lockup.to_lowercase() != self.config.sablier_lockup {
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
        let token = fields.token.to_lowercase();
        let class_id = self.ensure_class(Chain::Base, token, fields.decimals, schedule);
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
        self.mint_units(&class_id, &account, units, checkpoint);
        emit(CustodyEvent::DepositRegistered {
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

    /// Signs `Release(lockup, streamId, to, id)` for a refused Base stream.
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
            id,
        };
        self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
    }

    /// The EIP-712 domain of the configured RoseVault.
    pub(super) fn eip712_domain(&self) -> Eip712Domain {
        Eip712Domain {
            chain_id: BASE_SEPOLIA_CHAIN_ID,
            verifying_contract: evm::parse_address(&self.config.rose_vault)
                .expect("validated at init"),
        }
    }

    /// Requests the `vault/base` signature of `digest` for payout `id` (the digest must be a
    /// canonical secp256k1 scalar, which a keccak digest fails with probability about 2^-128).
    pub(super) fn request_base_signature(&mut self, id: u64, digest: [u8; 32]) -> Promise {
        require!(
            evm::is_valid_ecdsa_payload(&digest),
            "Digest is not a valid ECDSA payload: retry with the next authorization id"
        );
        self.payout_mut(id).digest = Some(hex::encode(digest));
        self.sign_ecdsa_promise(super::PATH_VAULT_BASE, digest)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_BASE_SIGN_CALLBACK)
                    .on_base_signed(U64(id)),
            )
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

/// The typed event of decoded `StreamDeposited` fields (addresses in any case).
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
