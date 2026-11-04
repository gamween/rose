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
//! Only classic SPL Token mints are supported: the mint account is attested as owned by the
//! Token program, and every token account is its associated token account.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue};

use super::payouts::{parse_anchor, parse_hex, GAS_FOR_SOL_ACTION};
use super::types::{
    PayoutDebit, PayoutKind, RefusedAsset, RefusedDeposit, ReplayKey, SolDeposit, SolDepositArgs,
    SolDepositStage, SolStreamInfo,
};
use super::PATH_VAULT_SOL;
use crate::foreign::mpc::{
    payload_hash, Bytes32, Bytes64, ExtractedValue, ForeignChainRpcRequest, SvmAccount,
    SvmExtractor, SvmFinality, SvmRpcRequest,
};
use crate::foreign::solana::{
    self as sol, associated_token_address, create_associated_token_account_idempotent,
    streamflow_transfer_recipient, Pubkey, StreamflowMetadata, StreamflowWithdrawAccounts,
    TOKEN_PROGRAM,
};
use crate::math::ONE;
use crate::types::{Chain, ClassId, Position, PositionSource, PositionState};
use crate::unlock::{ClassSchedule, StreamflowStream};
use crate::{class_id_of, Contract, ContractExt, RoseEvent};

/// Static gas of the deposit key callback (parses the key, builds the request).
const GAS_FOR_KEY_CALLBACK: Gas = Gas::from_tgas(20);
/// Static gas of the attestation callbacks (hash comparison, record or mint).
const GAS_FOR_ATTESTATION_CALLBACK: Gas = Gas::from_tgas(20);
/// Gas attached to the `derived_public_key` view call.
const GAS_FOR_DERIVED_KEY: Gas = Gas::from_tgas(10);
/// Prepaid gas an attribution needs: key (10 + 20), proof (15 + 20) and overhead.
const GAS_FOR_ATTRIBUTION: Gas = Gas::from_tgas(80);
/// Prepaid gas a registration needs: proof (15 + 20) and overhead.
const GAS_FOR_REGISTRATION: Gas = Gas::from_tgas(50);
/// Length of a classic SPL Token mint account; `decimals` is at offset 44.
const MINT_ACCOUNT_LEN: usize = 82;
const MINT_DECIMALS_OFFSET: usize = 44;

#[near]
impl Contract {
    /// Attributes a Streamflow stream sitting at the caller's deposit address
    /// `dep/<caller>/<class_id>` to the caller: derives the address from the MPC contract, then
    /// proves the stream metadata and its mint with one ForeignTx `AccountState` request at
    /// `Finalized`. The class need not exist yet (the first deposit of a class creates it at
    /// registration): `class_id` only selects the derivation path, and the class the stream
    /// lands in is recomputed from the attested metadata. The stream must already have the
    /// vault-compatible flags (non-cancelable, non-transferable by the sender, transferable by
    /// the recipient, no automatic withdrawal, not pausable, no rate update, no top-up);
    /// otherwise it is recorded as refused at the deposit address and returnable to
    /// `return_to`. Anyone owning a NEAR account; at least 80 Tgas. The app passes the account
    /// bytes it read at `finalized` right before the call.
    pub fn attribute_sol_deposit(&mut self, args: SolDepositArgs) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_FOR_ATTRIBUTION,
            "At least 80 Tgas are required to attribute a deposit"
        );
        let caller = env::predecessor_account_id();
        require!(
            args.class_id.len() == 64 && args.class_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "class_id must be the 64-hex class id (compute_sol_class_id)"
        );
        sol::parse_pubkey(&args.metadata)
            .unwrap_or_else(|_| env::panic_str("metadata must be a base58 key"));
        sol::parse_pubkey(&args.return_to)
            .unwrap_or_else(|_| env::panic_str("return_to must be a base58 key"));
        parse_anchor(&args.anchor_tx);
        let metadata = parse_hex(&args.metadata_data, "metadata_data");
        StreamflowMetadata::parse(&metadata)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid stream metadata: {e:?}")));
        let mint = parse_hex(&args.mint_data, "mint_data");
        require!(
            mint.len() == MINT_ACCOUNT_LEN,
            "mint_data must be an 82-byte SPL Token mint account"
        );
        if let Some(existing) = self.custody.sol_deposits.get(&args.metadata) {
            let released = matches!(existing.stage, SolDepositStage::Registered { position_id }
                if self.positions.get(&position_id.0).is_some_and(|p| p.state == PositionState::Released));
            require!(
                !matches!(existing.stage, SolDepositStage::Registered { .. }) || released,
                "Stream is already registered"
            );
        }
        let path = deposit_path(&caller, &args.class_id);
        let engine = env::current_account_id();
        let key_args = near_sdk::serde_json::json!({
            "path": path,
            "predecessor": engine,
            "domain_id": self.config.sign_ed25519_domain,
        });
        Promise::new(self.config.mpc_account.clone())
            .function_call(
                "derived_public_key".to_string(),
                near_sdk::serde_json::to_vec(&key_args).expect("args serialize"),
                NearToken::from_yoctonear(0),
                GAS_FOR_DERIVED_KEY,
            )
            .then(
                Self::ext(engine)
                    .with_static_gas(GAS_FOR_KEY_CALLBACK)
                    .on_sol_deposit_key(args, caller, path),
            )
    }

    /// Deposit key callback: requires the stream's recipient to be the derived address, then
    /// requests the attestation of the stream and mint accounts. Called by the contract itself.
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
            .and_then(|key| sol::parse_near_ed25519(&key).ok())
            .unwrap_or_else(|| env::panic_str("Deposit address derivation failed"));
        let metadata_account = SvmAccount {
            owner: Bytes32(self.streamflow_program()),
            data: parse_hex(&args.metadata_data, "metadata_data"),
        };
        let metadata = StreamflowMetadata::parse(&metadata_account.data).expect("validated");
        require!(
            metadata.recipient == deposit_address,
            "Stream is not at the caller's deposit address"
        );
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
                    .with_static_gas(GAS_FOR_ATTESTATION_CALLBACK)
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
    /// refused at the deposit address). Called by the contract itself.
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
        let matches = Self::foreign_result(0)
            .map(|response| hex::encode(response.payload_hash.0) == expected_hash)
            .unwrap_or(false);
        if !matches {
            self.emit(RoseEvent::DepositVerificationFailed { key });
            return false;
        }
        let metadata_bytes = parse_hex(&args.metadata_data, "metadata_data");
        let mint_bytes = parse_hex(&args.mint_data, "mint_data");
        let decimals = mint_bytes[MINT_DECIMALS_OFFSET];
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
                StreamflowStream::new(metadata.params()).map_err(|e| e.to_string())
            })
            .and_then(|stream| {
                if ClassSchedule::from_streamflow(&stream).fraction(crate::now_secs()) == ONE {
                    Err("stream is fully unlocked: withdraw it instead".to_string())
                } else {
                    Ok(stream)
                }
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
        self.custody.replays.remove(&key);
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
    /// Anyone; attach the payout storage deposit and at least 50 Tgas. Callable again with a
    /// fresh blockhash while the stream is not registered.
    #[payable]
    pub fn move_sol_deposit(&mut self, metadata: String, recent_blockhash: String) -> Promise {
        Self::assert_payout_deposit();
        require!(
            env::prepaid_gas() >= GAS_FOR_SOL_ACTION,
            "At least 50 Tgas are required for a Solana action"
        );
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
        let message = self.store_sol_message(
            id,
            &gas,
            &instructions,
            parse_blockhash(&recent_blockhash),
            None,
            &deposit.path,
        );
        self.sign_sol_pair(id, &deposit.path, message)
    }

    /// Registers an attributed stream once it sits at the vault: proves the metadata account at
    /// `Finalized` (recipient = vault, eligibility flags, schedule equal to the class) and mints
    /// `net_amount_deposited` units to the attributed account from a checkpoint that excludes
    /// what the holder already withdrew. A stream refused here is returnable from the vault.
    /// Anyone; attach the registration deposit of the credited account when it is not a unit
    /// holder yet (returned when unused) and at least 50 Tgas.
    #[payable]
    pub fn register_sol_deposit(
        &mut self,
        metadata: String,
        anchor_tx: String,
        metadata_data: String,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_FOR_REGISTRATION,
            "At least 50 Tgas are required to register a deposit"
        );
        let deposit = self.sol_deposit(&metadata);
        require!(
            matches!(
                deposit.stage,
                SolDepositStage::Attributed | SolDepositStage::MoveSigned { .. }
            ),
            "Stream is not awaiting registration"
        );
        require!(
            env::attached_deposit().as_yoctonear()
                >= self.holder_storage_needed(&deposit.account, &deposit.class_id),
            format!(
                "Attach the storage deposit for {} (registration_deposit_for)",
                deposit.account
            )
        );
        let key = ReplayKey::SolStream {
            metadata: metadata.clone(),
        };
        self.mark_pending(&key);
        self.hold(&deposit.account);
        let account = SvmAccount {
            owner: Bytes32(self.streamflow_program()),
            data: parse_hex(&metadata_data, "metadata_data"),
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
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ATTESTATION_CALLBACK)
                .on_sol_deposit_verified(
                    key,
                    hex::encode(hash),
                    metadata_data,
                    env::predecessor_account_id(),
                    U128(env::attached_deposit().as_yoctonear()),
                ),
        )
    }

    /// Registration callback: mints the units or records the refusal. Called by the contract
    /// itself; never panics once the key is pending.
    #[private]
    pub fn on_sol_deposit_verified(
        &mut self,
        key: ReplayKey,
        expected_hash: String,
        metadata_data: String,
        caller: AccountId,
        attached: U128,
    ) -> bool {
        let attached = NearToken::from_yoctonear(attached.0);
        let ReplayKey::SolStream { metadata } = &key else {
            env::panic_str("Internal custody error: not a Solana stream key");
        };
        let deposit = self.sol_deposit(metadata);
        self.release_hold(&deposit.account);
        if !self.attested(&key, &expected_hash) {
            Self::refund_registration_deposit(&caller, attached);
            return false;
        }
        let data = parse_hex(&metadata_data, "metadata_data");
        match self.admit_sol_stream(&key, &deposit, data, attached.as_yoctonear()) {
            Ok(remainder) => {
                Self::refund_registration_deposit(&caller, NearToken::from_yoctonear(remainder))
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
                Self::refund_registration_deposit(&caller, attached);
                return false;
            }
        }
        true
    }

    /// A Solana deposit record.
    pub fn get_sol_deposit(&self, metadata: String) -> Option<SolDeposit> {
        self.custody.sol_deposits.get(&metadata).cloned()
    }

    /// The registered stream accounts of a Solana position.
    pub fn get_sol_stream(&self, position_id: U64) -> Option<SolStreamInfo> {
        self.custody.sol_streams.get(&position_id.0).cloned()
    }

    /// Tokens of `mint` in the vault's token account that in-kind redeems withdrew and no
    /// payout has used yet (the pool later payouts draw on before any stream withdrawal).
    pub fn get_vault_pool(&self, mint: String) -> U128 {
        U128(u128::from(
            self.custody.vault_pool.get(&mint).copied().unwrap_or(0),
        ))
    }

    /// The deposit address derivation path of `account` for `class_id`.
    pub fn deposit_path_of(&self, account: AccountId, class_id: ClassId) -> String {
        deposit_path(&account, &class_id)
    }
}

impl Contract {
    fn sol_deposit(&self, metadata: &str) -> SolDeposit {
        self.custody
            .sol_deposits
            .get(metadata)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Stream is not attributed"))
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
        let stream = StreamflowStream::new(metadata.params()).map_err(|e| e.to_string())?;
        let allocation = u128::from(metadata.net_amount_deposited);
        if u128::from(metadata.amount_withdrawn) >= allocation {
            return Err("stream is fully withdrawn".to_string());
        }
        let schedule = ClassSchedule::from_streamflow(&stream);
        if schedule.fraction(crate::now_secs()) == ONE {
            return Err("stream is fully unlocked: withdraw it instead".to_string());
        }
        let class_id = self.ensure_class(
            Chain::Solana,
            deposit.mint.clone(),
            deposit.decimals,
            schedule,
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
                partner: sol::format_pubkey(&metadata.partner),
                start_time: metadata.start_time,
                cliff: metadata.cliff,
                cliff_amount: metadata.cliff_amount,
                period: metadata.period,
                amount_per_period: metadata.amount_per_period,
                net_amount_deposited: metadata.net_amount_deposited,
                end_time: metadata.end_time,
                engine_withdrawn: metadata.amount_withdrawn,
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
        let message = self.store_sol_message(
            id,
            &gas,
            &instructions,
            parse_blockhash(recent_blockhash),
            None,
            held_by_path,
        );
        self.sign_sol_pair(id, held_by_path, message)
    }
}

impl Contract {
    /// The accounts of a Streamflow `withdraw` by the vault of a registered stream.
    pub(super) fn withdraw_accounts(
        stream: &super::types::SolStreamInfo,
        vault: Pubkey,
    ) -> StreamflowWithdrawAccounts {
        let mint = sol::parse_pubkey(&stream.mint).expect("stored base58");
        let partner = sol::parse_pubkey(&stream.partner).expect("stored base58");
        StreamflowWithdrawAccounts {
            authority: vault,
            recipient: vault,
            recipient_tokens: associated_token_address(&vault, &mint).expect("valid seeds"),
            metadata: sol::parse_pubkey(&stream.metadata).expect("stored base58"),
            escrow_tokens: sol::parse_pubkey(&stream.escrow_tokens).expect("stored base58"),
            streamflow_treasury: sol::STREAMFLOW_TREASURY,
            streamflow_treasury_tokens: associated_token_address(&sol::STREAMFLOW_TREASURY, &mint)
                .expect("valid seeds"),
            partner,
            partner_tokens: associated_token_address(&partner, &mint).expect("valid seeds"),
            mint,
        }
    }
}

/// `dep/<account>/<class_id>`.
fn deposit_path(account: &AccountId, class_id: &ClassId) -> String {
    format!("dep/{account}/{class_id}")
}

fn parse_blockhash(text: &str) -> [u8; 32] {
    sol::parse_pubkey(text)
        .unwrap_or_else(|_| env::panic_str("recent_blockhash must be a base58 hash"))
}
