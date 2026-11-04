//! Solana devnet deposits (spec section 7.2) and the Streamflow custody actions.
//!
//! A holder transfers their stream to the deposit address `dep/<near_account>/<class>` (an
//! MPC-derived Ed25519 key of the engine). Attribution is proof-backed rather than request-backed:
//! `attribute_sol_deposit` derives the deposit address from the MPC contract and proves with a
//! ForeignTx `AccountState` that the stream's recipient is that address (a per-stream record
//! written on request alone could be front-run or overwritten by anyone naming the stream).
//! `move_sol_deposit` then has the deposit key and `gas/sol` sign the `transfer_recipient` to
//! the vault with a caller-supplied recent blockhash (nothing is debited, so an expired blockhash
//! only means a retry), and `register_sol_deposit` proves the stream at the vault and mints the
//! units. A stream the engine refuses, at the deposit address or at the vault, is returnable to
//! the address named at attribution through `return_refused_deposit`.
//!
//! Every stream is registered at most once (its replay key is the metadata account). A stream
//! refused at the vault is never attributed again: the vault signs its return, and a return
//! signed for a stream that could later become a position would let it leave the vault with its
//! units minted. A registration proof that shows the stream elsewhere than at the vault changes
//! nothing (the move may not have executed yet).
//!
//! Only classic SPL Token mints without a freeze authority are supported: the mint account is
//! attested as owned by the Token program, and every token account is its associated token
//! account.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};

use super::payouts::{parse_anchor, parse_hex};
use super::types::{
    PayoutDebit, PayoutKind, RefusedAsset, RefusedDeposit, ReplayKey, SolDeposit, SolDepositArgs,
    SolDepositStage, SolStreamInfo,
};
use super::{
    require_gas_left, GAS_FOR_RECORD_CALLBACK, PATH_VAULT_SOL, RECORD_STORAGE_DEPOSIT,
    TGAS_CALLBACK_WORK, TGAS_CALL_FEES, TGAS_PROOF, TGAS_SIGN_PAIR,
};
use crate::foreign::mpc::{
    payload_hash, Bytes32, Bytes64, ExtractedValue, ForeignChainRpcRequest, SvmAccount,
    SvmExtractor, SvmFinality, SvmRpcRequest,
};
use crate::foreign::solana::{
    self as sol, associated_token_address, create_associated_token_account_idempotent,
    streamflow_transfer_recipient, Mint, StreamflowMetadata, TOKEN_PROGRAM,
};
use crate::math::ONE;
use crate::types::{Chain, ClassId, Position, PositionSource, PositionState};
use crate::unlock::{ClassSchedule, StreamflowStream};
use crate::{class_id_of, Contract, ContractExt, RoseEvent};

/// Tgas the `derived_public_key` view call gets.
const TGAS_DERIVED_KEY: u64 = 10;
/// Static gas of the deposit key callback: the proof it requests and its own work.
const GAS_FOR_KEY_CALLBACK: Gas = Gas::from_tgas(TGAS_PROOF + TGAS_CALLBACK_WORK);

#[near]
impl Contract {
    /// Attributes a Streamflow stream sitting at the caller's deposit address
    /// `dep/<caller>/<class_id>` to the caller: derives the address from the MPC contract, then
    /// proves the stream metadata and its mint with one ForeignTx `AccountState` request at
    /// `Finalized`. The class need not exist yet (the first deposit of a class creates it at
    /// registration): `class_id` only selects the derivation path, and the class the stream
    /// lands in is recomputed from the attested metadata. The stream must already have the
    /// vault-compatible flags (non-cancelable, non-transferable by the sender, transferable by
    /// the recipient, no automatic withdrawal, not pausable, no rate update, no top-up, no
    /// Streamflow or partner fee), a mint without a freeze authority (whoever holds it could
    /// freeze the vault's token account) and at least one whole token left to lock; otherwise it is
    /// recorded as refused at the deposit address and returnable to `return_to`. A stream
    /// already moved, registered or refused at the vault cannot be attributed. Anyone owning a
    /// NEAR account; attach exactly [`RECORD_STORAGE_DEPOSIT`] (kept with the record, returned
    /// when nothing is recorded) and 120 Tgas (the call keeps 80 Tgas for its chain). The app
    /// passes the account bytes it read at `finalized` right before the call.
    #[payable]
    pub fn attribute_sol_deposit(&mut self, args: SolDepositArgs) -> Promise {
        require!(
            env::attached_deposit() == RECORD_STORAGE_DEPOSIT,
            "Attach exactly 0.015 NEAR as the record storage deposit"
        );
        Self::require_mpc_reserve();
        let caller = env::predecessor_account_id();
        require!(
            args.class_id.len() == 64 && args.class_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "class_id must be the 64-hex class id (compute_sol_class_id)"
        );
        sol::parse_pubkey(&args.metadata)
            .unwrap_or_else(|_| env::panic_str("metadata must be a base58 key"));
        let return_to = sol::parse_pubkey(&args.return_to)
            .unwrap_or_else(|_| env::panic_str("return_to must be a base58 key"));
        let (vault, gas) = self.sol_keys();
        require!(
            return_to != vault && return_to != gas,
            "return_to must not be the engine's vault or fee payer"
        );
        parse_anchor(&args.anchor_tx);
        let metadata = parse_hex(&args.metadata_data, "metadata_data");
        StreamflowMetadata::parse(&metadata)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid stream metadata: {e:?}")));
        Mint::parse(&parse_hex(&args.mint_data, "mint_data")).unwrap_or_else(|_| {
            env::panic_str("mint_data must be an initialized 82-byte SPL Token mint account")
        });
        require!(
            self.attribution_open(&args.metadata),
            "Stream is already moved, registered or refused at the vault"
        );
        let path = deposit_path(&caller, &args.class_id);
        let engine = env::current_account_id();
        let key_args = near_sdk::serde_json::json!({
            "path": path,
            "predecessor": engine,
            "domain_id": self.config.sign_ed25519_domain,
        });
        require_gas_left(
            TGAS_DERIVED_KEY + TGAS_CALL_FEES + TGAS_PROOF + TGAS_CALLBACK_WORK + TGAS_CALL_FEES,
        );
        Promise::new(self.config.mpc_account.clone())
            .function_call(
                "derived_public_key".to_string(),
                near_sdk::serde_json::to_vec(&key_args).expect("args serialize"),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(TGAS_DERIVED_KEY),
            )
            .then(
                Self::ext(engine)
                    .with_static_gas(GAS_FOR_KEY_CALLBACK)
                    .on_sol_deposit_key(args, caller, path),
            )
    }

    /// Deposit key callback: requires the stream's recipient to be the derived address, then
    /// requests the attestation of the stream and mint accounts; otherwise returns the record
    /// deposit. Called by the contract itself.
    #[private]
    pub fn on_sol_deposit_key(
        &mut self,
        args: SolDepositArgs,
        caller: AccountId,
        path: String,
    ) -> PromiseOrValue<bool> {
        let deposit_address = env::promise_result_checked(0, super::MAX_RESULT_LEN)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice::<String>(&bytes).ok())
            .and_then(|key| sol::parse_near_ed25519(&key).ok());
        let metadata_account = SvmAccount {
            owner: Bytes32(self.streamflow_program()),
            data: parse_hex(&args.metadata_data, "metadata_data"),
        };
        let metadata = StreamflowMetadata::parse(&metadata_account.data).expect("validated");
        let Some(deposit_address) =
            deposit_address.filter(|address| metadata.recipient == *address)
        else {
            Self::refund_registration_deposit(&caller, RECORD_STORAGE_DEPOSIT);
            return PromiseOrValue::Value(false);
        };
        let mint_account = SvmAccount {
            owner: Bytes32(TOKEN_PROGRAM),
            data: parse_hex(&args.mint_data, "mint_data"),
        };
        let metadata_pubkey = sol::parse_pubkey(&args.metadata).expect("validated");
        let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: Bytes64(parse_anchor(&args.anchor_tx)),
            finality: SvmFinality::Finalized,
            extractors: vec![
                SvmExtractor::AccountState {
                    pubkey: Bytes32(metadata_pubkey),
                },
                SvmExtractor::AccountState {
                    pubkey: Bytes32(metadata.mint),
                },
            ],
        });
        let hash = payload_hash(
            request.clone(),
            vec![
                ExtractedValue::account(metadata_account),
                ExtractedValue::account(mint_account),
            ],
        );
        PromiseOrValue::Promise(
            self.verify_foreign_promise(request).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                    .on_sol_deposit_attested(
                        args,
                        caller,
                        path,
                        sol::format_pubkey(&deposit_address),
                        hex::encode(hash),
                    ),
            ),
        )
    }

    /// Attribution callback: on a matching attestation records the deposit as attributed (or
    /// refused at the deposit address) unless the stream moved on meanwhile (moved, registered,
    /// refused at the vault, or a registration in flight); otherwise returns the record deposit.
    /// Never touches the stream's replay key. Called by the contract itself.
    #[private]
    pub fn on_sol_deposit_attested(
        &mut self,
        args: SolDepositArgs,
        caller: AccountId,
        path: String,
        deposit_address: String,
        expected_hash: String,
    ) -> bool {
        let key = ReplayKey::SolStream {
            metadata: args.metadata.clone(),
        };
        if !Self::attestation_matches(&expected_hash) {
            self.emit(RoseEvent::DepositVerificationFailed { key });
            Self::refund_registration_deposit(&caller, RECORD_STORAGE_DEPOSIT);
            return false;
        }
        if !self.attribution_open(&args.metadata) || self.custody.replays.get(&key).is_some() {
            Self::refund_registration_deposit(&caller, RECORD_STORAGE_DEPOSIT);
            return false;
        }
        let metadata_bytes = parse_hex(&args.metadata_data, "metadata_data");
        let token = Mint::parse(&parse_hex(&args.mint_data, "mint_data")).expect("validated");
        let decimals = token.decimals;
        let metadata = StreamflowMetadata::parse(&metadata_bytes).expect("validated");
        let program = self.streamflow_program();
        let deposit_pubkey = sol::parse_pubkey(&deposit_address).expect("formatted above");
        let account = SvmAccount {
            owner: Bytes32(program),
            data: metadata_bytes,
        };
        let eligible = StreamflowMetadata::check_deposit(&account, &program, &deposit_pubkey)
            .map_err(|e| format!("{e:?}"))
            .and_then(|metadata| {
                if token.freeze_authority.is_some() {
                    return Err(FREEZABLE_MINT.to_string());
                }
                eligible_stream(&metadata, decimals)
            });
        let mint = sol::format_pubkey(&metadata.mint);
        let (class_id, stage) = match eligible {
            Ok(stream) => (
                class_id_of(
                    Chain::Solana,
                    &mint,
                    decimals,
                    &ClassSchedule::from_streamflow(&stream),
                ),
                SolDepositStage::Attributed,
            ),
            Err(reason) => {
                self.refuse(
                    &key,
                    RefusedDeposit {
                        chain: Chain::Solana,
                        asset: RefusedAsset::SolStream {
                            metadata: args.metadata.clone(),
                            held_by: deposit_address.clone(),
                            held_by_path: path.clone(),
                        },
                        return_to: args.return_to.clone(),
                        near_account: caller.to_string(),
                        reason,
                        return_payout: None,
                        refused_at: U64(env::block_timestamp()),
                    },
                );
                (args.class_id.clone(), SolDepositStage::Refused)
            }
        };
        let attributed = stage == SolDepositStage::Attributed;
        if attributed {
            self.custody.refused.remove(&key);
            self.emit(RoseEvent::SolDepositAttributed {
                metadata: args.metadata.clone(),
                account: caller.clone(),
                class_id: class_id.clone(),
                deposit_address: deposit_address.clone(),
            });
        }
        self.custody.sol_deposits.insert(
            args.metadata.clone(),
            SolDeposit {
                metadata: args.metadata,
                account: caller,
                class_id,
                path,
                deposit_address,
                mint,
                decimals,
                return_to: args.return_to,
                stage,
                attributed_at: U64(env::block_timestamp()),
            },
        );
        attributed
    }

    /// Signs the move of an attributed stream from its deposit address to the vault:
    /// `create_associated_token_account_idempotent` for the vault (paid by `gas/sol`) then
    /// Streamflow `transfer_recipient` by the deposit key, with the caller's recent blockhash.
    /// Anyone; attach the payout storage deposit and 120 Tgas (the call keeps 70 Tgas for its
    /// signatures). Callable again with a fresh
    /// blockhash while the stream is not registered.
    #[payable]
    pub fn move_sol_deposit(&mut self, metadata: String, recent_blockhash: String) -> Promise {
        Self::assert_payout_deposit();
        Self::require_mpc_reserve();
        let deposit = self.sol_deposit(&metadata);
        require!(
            matches!(
                deposit.stage,
                SolDepositStage::Attributed | SolDepositStage::MoveSigned { .. }
            ),
            "Stream is not awaiting its move"
        );
        let (vault, gas) = self.sol_keys();
        let mint = sol::parse_pubkey(&deposit.mint).expect("stored base58");
        let authority = sol::parse_pubkey(&deposit.deposit_address).expect("stored base58");
        let vault_ata = associated_token_address(&vault, &mint).expect("valid seeds");
        let instructions = vec![
            create_associated_token_account_idempotent(gas, vault_ata, vault, mint),
            streamflow_transfer_recipient(
                self.streamflow_program(),
                authority,
                vault,
                vault_ata,
                sol::parse_pubkey(&metadata).expect("stored base58"),
                mint,
            ),
        ];
        let id = self.new_payout(
            Chain::Solana,
            PayoutKind::SolMove {
                metadata: metadata.clone(),
                from: deposit.deposit_address.clone(),
                to_owner: sol::format_pubkey(&vault),
            },
            PayoutDebit::None,
            &env::predecessor_account_id(),
            None,
        );
        self.custody
            .sol_deposits
            .get_mut(&metadata)
            .expect("checked above")
            .stage = SolDepositStage::MoveSigned { payout_id: U64(id) };
        let blockhash = parse_blockhash(&recent_blockhash);
        let message = self.compile_sol_message(&instructions, blockhash);
        self.store_sol_message(
            id,
            message.clone(),
            blockhash,
            None,
            &deposit.path,
            &authority,
        );
        require_gas_left(TGAS_SIGN_PAIR);
        self.sign_sol_pair(id, &deposit.path, message)
    }

    /// Registers an attributed stream once it sits at the vault: proves the metadata account at
    /// `Finalized` (recipient = vault, eligibility flags, schedule equal to the class) and mints
    /// `net_amount_deposited` units to the attributed account from a checkpoint that excludes
    /// what the holder already withdrew. A proof showing the stream elsewhere than at the vault
    /// changes nothing (call again once the move executed); an ineligible stream at the vault is
    /// refused and returnable from the vault. Anyone; attach
    /// `registration_deposit_for(account, class)` (the records' storage, kept, plus the holder's
    /// storage, whose unused part is returned) and 80 Tgas.
    #[payable]
    pub fn register_sol_deposit(
        &mut self,
        metadata: String,
        anchor_tx: String,
        metadata_data: String,
    ) -> Promise {
        Self::require_mpc_reserve();
        let deposit = self.sol_deposit(&metadata);
        require!(
            matches!(
                deposit.stage,
                SolDepositStage::Attributed | SolDepositStage::MoveSigned { .. }
            ),
            "Stream is not awaiting registration"
        );
        let needed = RECORD_STORAGE_DEPOSIT.as_yoctonear()
            + self.holder_storage_needed(&deposit.account, &deposit.class_id);
        require!(
            env::attached_deposit().as_yoctonear() >= needed,
            format!(
                "Attach {needed} yoctoNEAR of storage for {} (registration_deposit_for)",
                deposit.account
            )
        );
        let data = parse_hex(&metadata_data, "metadata_data");
        StreamflowMetadata::parse(&data)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid stream metadata: {e:?}")));
        let key = ReplayKey::SolStream {
            metadata: metadata.clone(),
        };
        self.mark_pending(&key);
        self.hold_for_key(&key, &deposit.account);
        let account = SvmAccount {
            owner: Bytes32(self.streamflow_program()),
            data,
        };
        let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: Bytes64(parse_anchor(&anchor_tx)),
            finality: SvmFinality::Finalized,
            extractors: vec![SvmExtractor::AccountState {
                pubkey: Bytes32(sol::parse_pubkey(&metadata).expect("stored base58")),
            }],
        });
        let hash = payload_hash(request.clone(), vec![ExtractedValue::account(account)]);
        self.emit(RoseEvent::DepositVerificationRequested { key: key.clone() });
        require_gas_left(TGAS_PROOF);
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                .on_sol_deposit_verified(
                    key,
                    hex::encode(hash),
                    metadata_data,
                    env::predecessor_account_id(),
                    U128(env::attached_deposit().as_yoctonear()),
                ),
        )
    }

    /// Registration callback: mints the units or records the refusal of a stream proven at the
    /// vault. A proof of a stream not at the vault, a failed or mismatched proof, or a stream
    /// whose stage moved on meanwhile clears the key and returns everything attached. Called by
    /// the contract itself; never panics once the key is pending.
    #[private]
    pub fn on_sol_deposit_verified(
        &mut self,
        key: ReplayKey,
        expected_hash: String,
        metadata_data: String,
        caller: AccountId,
        attached: U128,
    ) -> bool {
        let ReplayKey::SolStream { metadata } = &key else {
            env::panic_str("Internal custody error: not a Solana stream key");
        };
        if !self.is_pending(&key) {
            Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(attached.0));
            return false;
        }
        self.release_key_hold(&key);
        let deposit = self.sol_deposit(metadata);
        let data = parse_hex(&metadata_data, "metadata_data");
        let (vault, _) = self.sol_keys();
        let at_vault = StreamflowMetadata::parse(&data).is_ok_and(|m| m.recipient == vault);
        let awaiting = matches!(
            deposit.stage,
            SolDepositStage::Attributed | SolDepositStage::MoveSigned { .. }
        );
        if !Self::attestation_matches(&expected_hash) || !at_vault || !awaiting {
            self.clear_pending(&key);
            self.emit(RoseEvent::DepositVerificationFailed { key: key.clone() });
            Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(attached.0));
            return false;
        }
        self.consume(&key);
        let budget = attached
            .0
            .saturating_sub(RECORD_STORAGE_DEPOSIT.as_yoctonear());
        match self.admit_sol_stream(&key, &deposit, data, budget) {
            Ok(remainder) => {
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(remainder));
                true
            }
            Err(reason) => {
                self.refuse(
                    &key,
                    RefusedDeposit {
                        chain: Chain::Solana,
                        asset: RefusedAsset::SolStream {
                            metadata: metadata.clone(),
                            held_by: self.derived().vault_sol.clone(),
                            held_by_path: PATH_VAULT_SOL.to_string(),
                        },
                        return_to: deposit.return_to.clone(),
                        near_account: deposit.account.to_string(),
                        reason,
                        return_payout: None,
                        refused_at: U64(env::block_timestamp()),
                    },
                );
                self.custody
                    .sol_deposits
                    .get_mut(metadata)
                    .expect("record exists")
                    .stage = SolDepositStage::Refused;
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(budget));
                false
            }
        }
    }

    /// A Solana deposit record.
    pub fn get_sol_deposit(&self, metadata: String) -> Option<SolDeposit> {
        self.custody.sol_deposits.get(&metadata).cloned()
    }

    /// The registered stream accounts of a Solana position.
    pub fn get_sol_stream(&self, position_id: U64) -> Option<SolStreamInfo> {
        self.custody.sol_streams.get(&position_id.0).cloned()
    }

    /// The deposit address derivation path of `account` for `class_id`.
    pub fn deposit_path_of(&self, account: AccountId, class_id: ClassId) -> String {
        deposit_path(&account, &class_id)
    }
}

impl Contract {
    pub(super) fn sol_deposit(&self, metadata: &str) -> SolDeposit {
        self.custody
            .sol_deposits
            .get(metadata)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Stream is not attributed"))
    }

    /// True when a stream may be attributed: never seen, still waiting for its move, or refused
    /// at its deposit address. A stream moved, registered (even released since) or refused at
    /// the vault never is again.
    fn attribution_open(&self, metadata: &str) -> bool {
        match self.custody.sol_deposits.get(metadata).map(|d| &d.stage) {
            None | Some(SolDepositStage::Attributed) => true,
            Some(SolDepositStage::Refused) => !self.custody.refused.get(&ReplayKey::SolStream {
                metadata: metadata.to_string(),
            })
            .is_some_and(|refused| {
                matches!(&refused.asset, RefusedAsset::SolStream { held_by_path, .. } if held_by_path == PATH_VAULT_SOL)
            }),
            Some(SolDepositStage::MoveSigned { .. } | SolDepositStage::Registered { .. }) => false,
        }
    }

    /// Validates an attested stream at the vault against the class rules, then registers the
    /// position and mints the units from a checkpoint excluding what was already withdrawn.
    /// Returns what is left of the storage `budget` after the holder's registration.
    fn admit_sol_stream(
        &mut self,
        key: &ReplayKey,
        deposit: &SolDeposit,
        data: Vec<u8>,
        budget: u128,
    ) -> Result<u128, String> {
        let program = self.streamflow_program();
        let (vault, _) = self.sol_keys();
        let account = SvmAccount {
            owner: Bytes32(program),
            data,
        };
        let metadata = StreamflowMetadata::check_deposit(&account, &program, &vault)
            .map_err(|e| format!("{e:?}"))?;
        if sol::format_pubkey(&metadata.mint) != deposit.mint {
            return Err("mint differs from the attributed stream".to_string());
        }
        if Ok(metadata.recipient_tokens) != associated_token_address(&vault, &metadata.mint) {
            return Err("stream pays a token account other than the vault's".to_string());
        }
        let stream = eligible_stream(&metadata, deposit.decimals)?;
        let allocation = u128::from(metadata.net_amount_deposited);
        let class_id = self.ensure_class(
            Chain::Solana,
            deposit.mint.clone(),
            deposit.decimals,
            ClassSchedule::from_streamflow(&stream),
        );
        let remainder = self.cover_holder_storage(&deposit.account, &class_id, budget);
        let (units, checkpoint) = super::deposit_units_of(
            &self.class(&class_id).schedule,
            self.fraction_now(&class_id),
            None,
            u128::from(metadata.amount_withdrawn),
            allocation,
        );
        let position_id = self.insert_position(Position {
            class_id: class_id.clone(),
            source: PositionSource::SolanaStream {
                metadata: deposit.metadata.clone(),
            },
            allocation: U128(units),
            depositor: deposit.account.clone(),
            deposited_at: U64(env::block_timestamp()),
            state: PositionState::Held,
        });
        self.custody.sol_streams.insert(
            position_id,
            SolStreamInfo {
                metadata: deposit.metadata.clone(),
                mint: deposit.mint.clone(),
                escrow_tokens: sol::format_pubkey(&metadata.escrow_tokens),
                streamflow_treasury_tokens: sol::format_pubkey(
                    &metadata.streamflow_treasury_tokens,
                ),
                partner: sol::format_pubkey(&metadata.partner),
                partner_tokens: sol::format_pubkey(&metadata.partner_tokens),
                start_time: metadata.start_time,
                cliff: metadata.cliff,
                cliff_amount: U64(metadata.cliff_amount),
                period: metadata.period,
                amount_per_period: U64(metadata.amount_per_period),
                net_amount_deposited: U64(metadata.net_amount_deposited),
                end_time: metadata.end_time,
                engine_withdrawn: U64(metadata.amount_withdrawn),
                registered_withdrawn: U64(metadata.amount_withdrawn),
                checkpoint: U128(checkpoint),
                drawing: None,
                pending_withdraw: U64(0),
            },
        );
        self.custody
            .class_streams
            .entry(class_id.clone())
            .or_default()
            .push(position_id);
        self.custody
            .sol_deposits
            .get_mut(&deposit.metadata)
            .expect("record exists")
            .stage = SolDepositStage::Registered {
            position_id: U64(position_id),
        };
        self.mint_units_owed(&class_id, &deposit.account, units, checkpoint);
        self.emit(RoseEvent::DepositRegistered {
            key: key.clone(),
            chain: Chain::Solana,
            position_id: U64(position_id),
            class_id,
            account: deposit.account.clone(),
            units: U128(units),
            checkpoint: U128(checkpoint),
        });
        Ok(remainder)
    }

    /// Signs `transfer_recipient` of a refused stream from `held_by` to `to_owner`.
    pub(super) fn return_sol_stream(
        &mut self,
        key: &ReplayKey,
        metadata: &str,
        held_by: &str,
        held_by_path: &str,
        to_owner: &str,
        recent_blockhash: &str,
    ) -> Promise {
        Self::require_mpc_reserve();
        let (_, gas) = self.sol_keys();
        let deposit = self.sol_deposit(metadata);
        let mint = sol::parse_pubkey(&deposit.mint).expect("stored base58");
        let authority = sol::parse_pubkey(held_by).expect("stored base58");
        let to_owner_key = sol::parse_pubkey(to_owner).expect("stored base58");
        let to_ata = associated_token_address(&to_owner_key, &mint).expect("valid seeds");
        let instructions = vec![
            create_associated_token_account_idempotent(gas, to_ata, to_owner_key, mint),
            streamflow_transfer_recipient(
                self.streamflow_program(),
                authority,
                to_owner_key,
                to_ata,
                sol::parse_pubkey(metadata).expect("stored base58"),
                mint,
            ),
        ];
        let id = self.new_payout(
            Chain::Solana,
            PayoutKind::SolReturn {
                metadata: metadata.to_string(),
                from: held_by.to_string(),
                to_owner: to_owner.to_string(),
            },
            PayoutDebit::None,
            &env::predecessor_account_id(),
            None,
        );
        self.custody
            .refused
            .get_mut(key)
            .expect("refused record exists")
            .return_payout = Some(U64(id));
        let blockhash = parse_blockhash(recent_blockhash);
        let message = self.compile_sol_message(&instructions, blockhash);
        self.store_sol_message(
            id,
            message.clone(),
            blockhash,
            None,
            held_by_path,
            &authority,
        );
        require_gas_left(TGAS_SIGN_PAIR);
        self.sign_sol_pair(id, held_by_path, message)
    }
}

/// Refusal reason of a stream whose mint has a freeze authority.
const FREEZABLE_MINT: &str = "the mint has a freeze authority: its holder could freeze the vault's token account and block every payout of the class";

/// The schedule of an attested stream when the engine can lock it: a valid plain schedule, not
/// fully unlocked (its units would accrue nothing) and at least one whole token left to lock
/// (`net_amount_deposited` and its part not withdrawn yet), like RoseVault on Base.
fn eligible_stream(
    metadata: &StreamflowMetadata,
    decimals: u8,
) -> Result<StreamflowStream, String> {
    let stream = StreamflowStream::new(metadata.params()).map_err(|e| e.to_string())?;
    let one_token = 10u128.checked_pow(u32::from(decimals)).unwrap_or(u128::MAX);
    let allocation = u128::from(metadata.net_amount_deposited);
    let withdrawn = u128::from(metadata.amount_withdrawn);
    if withdrawn >= allocation {
        return Err("stream is fully withdrawn".to_string());
    }
    if allocation < one_token || allocation - withdrawn < one_token {
        return Err("stream holds less than one whole token".to_string());
    }
    if ClassSchedule::from_streamflow(&stream).fraction(crate::now_secs()) == ONE {
        return Err("stream is fully unlocked: withdraw it instead".to_string());
    }
    Ok(stream)
}

/// `dep/<account>/<class_id>`.
fn deposit_path(account: &AccountId, class_id: &ClassId) -> String {
    format!("dep/{account}/{class_id}")
}

fn parse_blockhash(text: &str) -> [u8; 32] {
    sol::parse_pubkey(text)
        .unwrap_or_else(|_| env::panic_str("recent_blockhash must be a base58 hash"))
}
