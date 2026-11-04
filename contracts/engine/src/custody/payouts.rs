//! Payouts and in-kind redeems (spec section 7.3): the engine debits the ledger, builds the
//! authorization or transaction itself, asks the MPC to sign it and stores the result for anyone
//! to submit on the foreign chain. A callback refunds only when no signature was produced.
//!
//! Solana payouts feed the vault's token account inside the same transaction: the engine keeps,
//! per registered stream, how much it has withdrawn (`SolStreamInfo::engine_withdrawn`, exact
//! because automatic withdrawals are refused at deposit and only the engine signs for the vault)
//! and puts one Streamflow `withdraw(amount)` per selected stream before the SPL transfer, so a
//! signed payout can never fail on chain for lack of balance. The withdrawn part of an in-kind
//! redeem (the released stream's unlocked, not yet withdrawn tokens, which belong to the other
//! unit holders) is tracked as the vault's pool and used by later payouts before any withdraw.
//! The accounting is updated when a payout is requested and reverted when the MPC produces no
//! signature; a signed transaction that nobody broadcasts (anyone can, at any time: durable
//! nonce, fee paid by `gas/sol`) is the one case where the ledger runs ahead of the chain.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PromiseOrValue};

use super::types::{
    ClaimSourceArgs, Payout, PayoutDebit, PayoutId, PayoutKind, PayoutStatus, RefusedAsset,
    ReplayKey, SolNonceProof, StoredClaimSource, StreamWithdraw,
};
use super::PATH_VAULT_SOL;
use super::PENDING_EXPIRY_BLOCKS;
use crate::foreign::evm::{self, EvmSignature, ReleaseAuthorization, TransferAuthorization};
use crate::foreign::mpc::{
    payload_hash, Bytes32, Bytes64, ExtractedValue, ForeignChainRpcRequest, SvmAccount,
    SvmExtractor, SvmFinality, SvmRpcRequest,
};
use crate::foreign::solana::{
    self as sol, advance_nonce_account, associated_token_address,
    create_associated_token_account_idempotent, spl_transfer_checked,
    streamflow_transfer_recipient, streamflow_withdraw, Instruction, NonceAccount, Pubkey,
    SYSTEM_PROGRAM,
};
use crate::types::{Chain, ClaimSource, PositionId, PositionSource, PositionState, Venue};
use crate::{Contract, ContractExt, RoseEvent};

/// Static gas of the nonce proof callback (hash comparison, two sign promises).
const GAS_FOR_NONCE_CALLBACK: Gas = Gas::from_tgas(20);
/// Static gas of the joined Solana signature callback (assembles and stores the transaction).
pub(super) const GAS_FOR_SOL_SIGN_CALLBACK: Gas = Gas::from_tgas(10);
/// Prepaid gas a Solana payout needs: proof (15 + 20), two signatures (30) and the callback.
const GAS_FOR_SOL_PAYOUT: Gas = Gas::from_tgas(100);
/// Prepaid gas a Solana action with a recent blockhash needs: two signatures and the callback.
pub(super) const GAS_FOR_SOL_ACTION: Gas = Gas::from_tgas(50);

/// Where a Solana payout's tokens come from.
struct SolPlan {
    withdraws: Vec<StreamWithdraw>,
    pool_used: u64,
    pool_credit: u64,
    mint: String,
}

/// Everything needed to prove a Solana account state.
pub(super) struct SolProof {
    pub anchor: [u8; 64],
    pub pubkey: Pubkey,
    pub account: SvmAccount,
}

#[near]
impl Contract {
    /// Claims `amount` unlocked tokens of a Base class to the EVM address `to`: debits the
    /// source, then asks the MPC to sign RoseVault `Transfer(token, to, amount, id)`; the
    /// signature is stored in the payout and the claimant submits `executeTransfer`. Holdings
    /// and lien shares are the caller's; a retired lot is payable by anyone to its `retire_to`
    /// address only. Attach the payout storage deposit and at least 30 Tgas.
    #[payable]
    pub fn claim_base_tokens(
        &mut self,
        source: ClaimSourceArgs,
        amount: U128,
        to: String,
    ) -> Promise {
        Self::assert_payout_deposit();
        require!(
            env::prepaid_gas() >= super::base::GAS_FOR_BASE_AUTHORIZATION,
            "At least 30 Tgas are required for a Base authorization"
        );
        let caller = env::predecessor_account_id();
        let source = source.resolve(&caller);
        let receipt = self.take_claimable(&source, amount.0);
        require!(receipt.chain == Chain::Base, "Not a Base class");
        let to = evm_recipient(&to, receipt.restricted_to.as_deref());
        let id = self.new_payout(
            Chain::Base,
            PayoutKind::BaseTransfer {
                token: receipt.token.clone(),
                to: evm::format_address(&to),
                amount,
            },
            PayoutDebit::Claimable {
                source: StoredClaimSource::from(&source),
                amount,
            },
            &caller,
            None,
        );
        let authorization = TransferAuthorization {
            token: evm::parse_address(&receipt.token).expect("stored lowercase address"),
            to,
            amount: amount.0,
            id,
        };
        self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
    }

    /// Withdraws `amount` of the caller's Base cash in `token` to the EVM address `to` through a
    /// RoseVault `Transfer` authorization. Attach the payout storage deposit and at least
    /// 30 Tgas.
    #[payable]
    pub fn withdraw_base_cash(&mut self, token: String, amount: U128, to: String) -> Promise {
        Self::assert_payout_deposit();
        require!(
            env::prepaid_gas() >= super::base::GAS_FOR_BASE_AUTHORIZATION,
            "At least 30 Tgas are required for a Base authorization"
        );
        require!(amount.0 > 0, "Amount must be positive");
        let caller = env::predecessor_account_id();
        let token = token.to_lowercase();
        require!(crate::is_evm_address(&token), "Invalid token address");
        let venue = Venue::Base {
            token: token.clone(),
        };
        self.debit_cash(&caller, &venue, amount.0);
        let to = evm_recipient(&to, None);
        let id = self.new_payout(
            Chain::Base,
            PayoutKind::BaseTransfer {
                token: token.clone(),
                to: evm::format_address(&to),
                amount,
            },
            PayoutDebit::Cash {
                account: caller.clone(),
                venue,
                amount,
            },
            &caller,
            None,
        );
        let authorization = TransferAuthorization {
            token: evm::parse_address(&token).expect("validated above"),
            to,
            amount: amount.0,
            id,
        };
        self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
    }

    /// Base signature callback: stores `(r, s, v)` and completes the action, or refunds the
    /// debit when the MPC produced no usable signature. A callback for a payout that is no
    /// longer `Requested` (the other request of a `retry_base_signature` pair already resolved
    /// it) changes nothing, so a payout is completed or refunded exactly once. Called by the
    /// contract itself.
    #[private]
    pub fn on_base_signed(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        if self.payout(id).status != PayoutStatus::Requested {
            return false;
        }
        let signature = Self::sign_result(0)
            .ok()
            .and_then(|response| response.as_secp256k1().cloned())
            .and_then(|signature| EvmSignature::from_mpc(&signature).ok());
        match signature {
            Some(signature) => {
                let payout = self.payout_mut(id);
                payout.base = Some(super::types::BaseSignature {
                    r: hex::encode(signature.r),
                    s: hex::encode(signature.s),
                    v: signature.v,
                });
                self.complete_payout(id);
                true
            }
            None => {
                self.fail_payout(id, "no signature produced");
                false
            }
        }
    }

    /// Claims `amount` unlocked tokens of a Solana class to the associated token account of
    /// `to_owner`: debits the source, proves the caller's durable nonce account (authority =
    /// vault) with a ForeignTx `AccountState`, then has `vault/sol` and `gas/sol` sign
    /// `AdvanceNonceAccount`, one Streamflow `withdraw(amount)` per stream of the class the
    /// engine draws on (its own per-stream accounting, see the module doc),
    /// `create_associated_token_account_idempotent` (paid by `gas/sol`) and SPL `TransferChecked`
    /// from the vault's token account. When the streams the packet size allows cannot cover
    /// `amount`, the call fails naming the amount one payout can carry. Attach the payout
    /// storage deposit and at least 100 Tgas.
    #[payable]
    pub fn claim_sol_tokens(
        &mut self,
        source: ClaimSourceArgs,
        amount: U128,
        to_owner: String,
        nonce: SolNonceProof,
    ) -> Promise {
        Self::assert_payout_deposit();
        require!(
            env::prepaid_gas() >= GAS_FOR_SOL_PAYOUT,
            "At least 100 Tgas are required for a Solana payout"
        );
        let caller = env::predecessor_account_id();
        let amount_u64 = u64::try_from(amount.0)
            .unwrap_or_else(|_| env::panic_str("Amount exceeds the SPL token range"));
        let (vault, gas) = self.sol_keys();
        let proof = self.nonce_proof(&nonce, &vault);
        let nonce_state = NonceAccount::parse(&proof.account.data).expect("validated");
        let source = source.resolve(&caller);
        let class_id = self.claim_class(&source);
        let class = self.class(&class_id).clone();
        require!(class.chain == Chain::Solana, "Not a Solana class");
        let mint = sol::parse_pubkey(&class.token).expect("stored base58 mint");
        let vault_ata = associated_token_address(&vault, &mint).expect("valid seeds");
        let plan_to = sol::parse_pubkey(&to_owner)
            .unwrap_or_else(|_| env::panic_str("to must be a base58 public key"));
        let plan_ata = associated_token_address(&plan_to, &mint).expect("valid seeds");
        let prefix = vec![advance_nonce_account(proof.pubkey, vault)];
        let suffix = vec![
            create_associated_token_account_idempotent(gas, plan_ata, plan_to, mint),
            spl_transfer_checked(vault_ata, mint, plan_ata, vault, amount_u64, class.decimals),
        ];
        let (instructions, plan) =
            self.plan_sol_withdraws(&class_id, &class.token, amount_u64, prefix, suffix);
        let receipt = self.take_claimable(&source, amount.0);
        let to_owner = sol_recipient(&to_owner, receipt.restricted_to.as_deref());
        let id = self.new_payout(
            Chain::Solana,
            PayoutKind::SolTransfer {
                mint: receipt.token,
                to_owner: sol::format_pubkey(&to_owner),
                amount,
            },
            PayoutDebit::Claimable {
                source: StoredClaimSource::from(&source),
                amount,
            },
            &caller,
            None,
        );
        let promise = self.prove_then_sign(id, &proof, nonce_state.nonce, &instructions);
        self.apply_sol_plan(id, plan);
        promise
    }

    /// Redeems a position in kind: burns its allocation `D_p` in class units from the caller
    /// (free units only: units locked in rounds or encumbered by liens cannot be redeemed) and
    /// authorizes the release of the position to `to`. On Base, a RoseVault `Release` (the vault
    /// withdraws the vested balance to itself first); on Solana, a durable-nonce transaction
    /// that first withdraws the stream's unlocked, not yet withdrawn tokens into the vault's
    /// token account (they belong to the other unit holders) and then `transfer_recipient`s the
    /// stream from the vault. The units are minted back if the MPC produces no signature.
    /// Attach the payout storage deposit; at least 30 Tgas on Base, 100 Tgas on Solana.
    #[payable]
    pub fn redeem(
        &mut self,
        position_id: U64,
        to: String,
        nonce: Option<SolNonceProof>,
    ) -> Promise {
        Self::assert_payout_deposit();
        let caller = env::predecessor_account_id();
        let position = self
            .positions
            .get(&position_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown position"));
        require!(
            position.state == PositionState::Held,
            "Position already released"
        );
        require!(
            !self.custody.releasing.contains_key(&position_id.0),
            "A release of this position is in flight"
        );
        require!(
            !self.custody.drawing.contains_key(&position_id.0),
            "A payout withdrawing from this stream is awaiting its signature: redeem once it resolves"
        );
        let debit = PayoutDebit::Units {
            position_id,
            class_id: position.class_id.clone(),
            account: caller.clone(),
            units: position.allocation,
        };
        match &position.source {
            PositionSource::BaseStream { lockup, stream_id } => {
                require!(
                    env::prepaid_gas() >= super::base::GAS_FOR_BASE_AUTHORIZATION,
                    "At least 30 Tgas are required for a Base authorization"
                );
                let stream_id = u64::try_from(stream_id.0).expect("stored from u64");
                let to = evm_recipient(&to, None);
                self.burn_units(&position.class_id, &caller, position.allocation.0);
                let id = self.new_payout(
                    Chain::Base,
                    PayoutKind::BaseRelease {
                        lockup: lockup.clone(),
                        stream_id,
                        to: evm::format_address(&to),
                    },
                    debit,
                    &caller,
                    Some(position_id.0),
                );
                self.start_release(position_id.0, id, &caller);
                let authorization = ReleaseAuthorization {
                    lockup: evm::parse_address(lockup).expect("stored lowercase address"),
                    stream_id,
                    to,
                    id,
                };
                self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
            }
            PositionSource::SolanaStream { metadata } => {
                require!(
                    env::prepaid_gas() >= GAS_FOR_SOL_PAYOUT,
                    "At least 100 Tgas are required for a Solana payout"
                );
                let nonce =
                    nonce.unwrap_or_else(|| env::panic_str("A nonce account proof is required"));
                let to_owner = sol_recipient(&to, None);
                let (vault, gas) = self.sol_keys();
                let proof = self.nonce_proof(&nonce, &vault);
                let nonce_state = NonceAccount::parse(&proof.account.data).expect("validated");
                let stream = self.sol_stream(position_id.0);
                let metadata_pubkey = sol::parse_pubkey(metadata).expect("stored base58");
                self.burn_units(&position.class_id, &caller, position.allocation.0);
                let mint = sol::parse_pubkey(&stream.mint).expect("stored base58 mint");
                let to_ata = associated_token_address(&to_owner, &mint).expect("valid seeds");
                let unlocked = Self::withdrawable_now(&stream);
                let mut instructions = vec![advance_nonce_account(proof.pubkey, vault)];
                if unlocked > 0 {
                    instructions.push(streamflow_withdraw(
                        self.streamflow_program(),
                        &Self::withdraw_accounts(&stream, vault),
                        unlocked,
                    ));
                }
                instructions.push(create_associated_token_account_idempotent(
                    gas, to_ata, to_owner, mint,
                ));
                instructions.push(streamflow_transfer_recipient(
                    self.streamflow_program(),
                    vault,
                    to_owner,
                    to_ata,
                    metadata_pubkey,
                    mint,
                ));
                let id = self.new_payout(
                    Chain::Solana,
                    PayoutKind::SolRelease {
                        metadata: metadata.clone(),
                        to_owner: sol::format_pubkey(&to_owner),
                    },
                    debit,
                    &caller,
                    Some(position_id.0),
                );
                self.start_release(position_id.0, id, &caller);
                let promise = self.prove_then_sign(id, &proof, nonce_state.nonce, &instructions);
                self.apply_sol_plan(
                    id,
                    SolPlan {
                        withdraws: if unlocked > 0 {
                            vec![StreamWithdraw {
                                position_id,
                                amount: U128(u128::from(unlocked)),
                            }]
                        } else {
                            Vec::new()
                        },
                        pool_used: 0,
                        pool_credit: unlocked,
                        mint: stream.mint.clone(),
                    },
                );
                promise
            }
        }
    }

    /// Nonce proof callback: on a matching attestation consumes the nonce value and requests
    /// the joined `vault/sol` and `gas/sol` signatures; otherwise refunds the debit and clears
    /// the nonce. Called by the contract itself.
    #[private]
    pub fn on_sol_nonce_verified(
        &mut self,
        payout_id: U64,
        expected_hash: String,
        key: ReplayKey,
    ) -> PromiseOrValue<bool> {
        let id = payout_id.0;
        let matches = Self::foreign_result(0)
            .map(|response| hex::encode(response.payload_hash.0) == expected_hash)
            .unwrap_or(false);
        if !matches || !self.consume(&key) {
            self.clear_pending(&key);
            self.fail_payout(id, "nonce attestation failed or mismatched");
            return PromiseOrValue::Value(false);
        }
        let message = self.sol_message_bytes(id);
        PromiseOrValue::Promise(self.sign_sol_pair(id, PATH_VAULT_SOL, message))
    }

    /// Joined signature callback: assembles and stores the transaction, keeps a vault signature
    /// whose fee-payer counterpart failed (`resign_sol_gas` completes it), or refunds the debit
    /// when the authority signature failed. Called by the contract itself.
    #[private]
    pub fn on_sol_signed(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        let signature = |index: u64| {
            Self::sign_result(index)
                .ok()
                .and_then(|response| response.as_ed25519().copied())
        };
        match (signature(0), signature(1)) {
            (Some(authority), Some(gas)) => {
                self.store_sol_signatures(id, Some(authority), Some(gas));
                self.complete_payout(id);
                true
            }
            (Some(authority), None) => {
                self.store_sol_signatures(id, Some(authority), None);
                let payout = self.payout_mut(id);
                payout.status = PayoutStatus::AwaitingGasSignature;
                payout.updated_at = U64(env::block_timestamp());
                self.emit(RoseEvent::PayoutAwaitingGasSignature { payout_id });
                false
            }
            (None, _) => {
                if let Some(nonce) = self.nonce_key(id) {
                    self.custody.replays.remove(&nonce);
                }
                self.fail_payout(id, "authority signature not produced");
                false
            }
        }
    }

    /// Re-requests the `vault/base` signature of a Base authorization still `Requested`
    /// [`PENDING_EXPIRY_BLOCKS`] blocks after its request (its callback ran out of gas or the MPC
    /// request timed out without a `PromiseError` reaching the engine): the same digest and id
    /// are signed again, nothing is debited. Anyone; at least 30 Tgas.
    pub fn retry_base_signature(&mut self, payout_id: U64) -> Promise {
        require!(
            env::prepaid_gas() >= super::base::GAS_FOR_BASE_AUTHORIZATION,
            "At least 30 Tgas are required for a Base authorization"
        );
        let payout = self.payout(payout_id.0).clone();
        require!(payout.chain == Chain::Base, "Not a Base authorization");
        require!(
            payout.status == PayoutStatus::Requested,
            "Authorization is not awaiting its signature"
        );
        require!(
            env::block_height() >= payout.requested_block.0 + PENDING_EXPIRY_BLOCKS,
            "The first request is still in flight"
        );
        let digest: [u8; 32] = payout
            .digest
            .as_deref()
            .and_then(|hex_text| hex::decode(hex_text).ok())
            .and_then(|bytes| bytes.try_into().ok())
            .unwrap_or_else(|| env::panic_str("No digest stored"));
        self.payout_mut(payout_id.0).requested_block = U64(env::block_height());
        self.request_base_signature(payout_id.0, digest)
    }

    /// Re-requests the `gas/sol` signature over the stored message of a payout whose vault
    /// signature exists. Anyone; at least 30 Tgas.
    pub fn resign_sol_gas(&mut self, payout_id: U64) -> Promise {
        let id = payout_id.0;
        require!(
            self.payout(id).status == PayoutStatus::AwaitingGasSignature,
            "Payout is not awaiting the fee payer signature"
        );
        let message = self.sol_message_bytes(id);
        self.sign_eddsa_promise(super::PATH_GAS_SOL, message).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_SOL_SIGN_CALLBACK)
                .on_sol_gas_resigned(payout_id),
        )
    }

    /// Fee-payer re-signature callback. Called by the contract itself.
    #[private]
    pub fn on_sol_gas_resigned(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        let Some(gas) = Self::sign_result(0)
            .ok()
            .and_then(|response| response.as_ed25519().copied())
        else {
            return false;
        };
        self.store_sol_signatures(id, None, Some(gas));
        self.complete_payout(id);
        true
    }

    /// A signed action record.
    pub fn get_payout(&self, payout_id: U64) -> Option<Payout> {
        self.custody.payouts.get(&payout_id.0).cloned()
    }

    /// Signed actions requested by `account`, oldest first, paginated.
    pub fn get_payouts(
        &self,
        account: AccountId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Payout> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50) as usize;
        self.custody
            .account_payouts
            .get(&account)
            .map(|ids| {
                ids.iter()
                    .skip(from)
                    .take(limit)
                    .filter_map(|id| self.custody.payouts.get(id).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The signed action releasing `position_id`, while one is in flight.
    pub fn get_pending_release(&self, position_id: U64) -> Option<U64> {
        self.custody
            .releasing
            .get(&position_id.0)
            .map(|id| U64(*id))
    }

    /// Number of signed actions so far (the next EIP-712 id).
    pub fn payouts_total(&self) -> U64 {
        U64(self.custody.next_payout_id)
    }
}

impl Contract {
    /// The bootstrapped Solana vault and fee payer keys.
    pub(super) fn sol_keys(&self) -> (Pubkey, Pubkey) {
        let derived = self.derived();
        (
            sol::parse_pubkey(&derived.vault_sol).expect("stored base58"),
            sol::parse_pubkey(&derived.gas_sol).expect("stored base58"),
        )
    }

    /// The configured Streamflow program.
    pub(super) fn streamflow_program(&self) -> Pubkey {
        sol::parse_pubkey(&self.config.streamflow_program)
            .unwrap_or_else(|_| env::panic_str("Streamflow program id is not a base58 key"))
    }

    /// The registered stream of a Solana position.
    pub(super) fn sol_stream(&self, position_id: PositionId) -> super::types::SolStreamInfo {
        self.custody
            .sol_streams
            .get(&position_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Not a Solana position"))
    }

    /// Tokens of a registered stream unlocked now and not yet withdrawn by the engine.
    pub(super) fn withdrawable_now(stream: &super::types::SolStreamInfo) -> u64 {
        let unlocked = crate::unlock::StreamflowStream::new(stream.params())
            .expect("registered schedule")
            .unlocked_amount(crate::now_secs());
        u64::try_from(unlocked)
            .unwrap_or(u64::MAX)
            .saturating_sub(stream.engine_withdrawn)
    }

    /// Chooses where `need` tokens of `mint` come from: the vault's tracked pool first, then
    /// one Streamflow `withdraw` per held stream of `class_id` with unlocked tokens left, as
    /// many as the packet size allows between `prefix` and `suffix`. Returns the instructions
    /// and the plan to apply; panics naming the coverable amount when `need` does not fit.
    fn plan_sol_withdraws(
        &self,
        class_id: &crate::types::ClassId,
        mint: &str,
        need: u64,
        prefix: Vec<Instruction>,
        suffix: Vec<Instruction>,
    ) -> (Vec<Instruction>, SolPlan) {
        let (vault, gas) = self.sol_keys();
        let pool_used = self
            .custody
            .vault_pool
            .get(mint)
            .copied()
            .unwrap_or(0)
            .min(need);
        let mut remaining = need - pool_used;
        let mut withdraws = Vec::new();
        for position_id in self
            .custody
            .class_streams
            .get(class_id)
            .cloned()
            .unwrap_or_default()
        {
            if remaining == 0 {
                break;
            }
            let held = self
                .positions
                .get(&position_id)
                .is_some_and(|p| p.state == PositionState::Held)
                && !self.custody.releasing.contains_key(&position_id);
            if !held {
                continue;
            }
            let stream = self.sol_stream(position_id);
            let take = Self::withdrawable_now(&stream).min(remaining);
            if take == 0 {
                continue;
            }
            withdraws.push((position_id, take, stream));
            remaining -= take;
        }
        let compile = |kept: &[(PositionId, u64, super::types::SolStreamInfo)]| {
            let mut instructions = prefix.clone();
            for (_, amount, stream) in kept {
                instructions.push(streamflow_withdraw(
                    self.streamflow_program(),
                    &Self::withdraw_accounts(stream, vault),
                    *amount,
                ));
            }
            instructions.extend(suffix.iter().cloned());
            let size = sol::LegacyMessage::compile(&gas, &instructions, [0u8; 32])
                .map(|message| message.serialize().len() + 1 + 2 * 64)
                .unwrap_or(usize::MAX);
            (instructions, size)
        };
        let mut kept = withdraws.len();
        let instructions = loop {
            let (instructions, size) = compile(&withdraws[..kept]);
            if size <= sol::MAX_TRANSACTION_LEN {
                break instructions;
            }
            require!(kept > 0, "Transaction would exceed the Solana packet size");
            kept -= 1;
        };
        let covered: u64 = pool_used + withdraws[..kept].iter().map(|w| w.1).sum::<u64>();
        require!(
            covered == need,
            format!("Only {covered} tokens can be paid in one payout now (unlocked and withdrawable from the class streams): claim at most that amount")
        );
        let plan = SolPlan {
            withdraws: withdraws[..kept]
                .iter()
                .map(|(position_id, amount, _)| StreamWithdraw {
                    position_id: U64(*position_id),
                    amount: U128(u128::from(*amount)),
                })
                .collect(),
            pool_used,
            pool_credit: 0,
            mint: mint.to_string(),
        };
        (instructions, plan)
    }

    /// Records a plan on its payout and updates the per-stream and pool accounting. Each stream
    /// drawn on counts the payout in `CustodyState::drawing` until it is signed or fails.
    fn apply_sol_plan(&mut self, id: PayoutId, plan: SolPlan) {
        for withdraw in &plan.withdraws {
            let count = self
                .custody
                .drawing
                .entry(withdraw.position_id.0)
                .or_insert(0);
            *count = count.saturating_add(1);
            let stream = self
                .custody
                .sol_streams
                .get_mut(&withdraw.position_id.0)
                .expect("planned stream");
            stream.engine_withdrawn = stream
                .engine_withdrawn
                .checked_add(u64::try_from(withdraw.amount.0).expect("u64 amount"))
                .unwrap_or_else(|| env::panic_str("Withdrawn amount overflow"));
        }
        if plan.pool_used > 0 {
            let pool = self
                .custody
                .vault_pool
                .get_mut(&plan.mint)
                .expect("pool exists");
            *pool -= plan.pool_used;
        }
        let solana = self.payout_mut(id).solana.as_mut().expect("message stored");
        solana.withdraws = plan.withdraws;
        solana.pool_used = U128(u128::from(plan.pool_used));
        solana.pool_credit = U128(u128::from(plan.pool_credit));
    }

    /// Ends the in-flight count of a payout on the streams it draws on (signed or failed).
    fn release_draws(&mut self, id: PayoutId) {
        let Some(solana) = self.payout(id).solana.clone() else {
            return;
        };
        for withdraw in &solana.withdraws {
            let position_id = withdraw.position_id.0;
            if let Some(count) = self.custody.drawing.get_mut(&position_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.custody.drawing.remove(&position_id);
                }
            }
        }
    }

    /// Reverts the withdraw accounting of a payout that produced no signature.
    fn revert_sol_plan(&mut self, id: PayoutId) {
        self.release_draws(id);
        let Some(solana) = self.payout(id).solana.clone() else {
            return;
        };
        for withdraw in &solana.withdraws {
            if let Some(stream) = self.custody.sol_streams.get_mut(&withdraw.position_id.0) {
                stream.engine_withdrawn = stream
                    .engine_withdrawn
                    .saturating_sub(u64::try_from(withdraw.amount.0).expect("u64 amount"));
            }
        }
        if solana.pool_used.0 > 0 {
            if let PayoutKind::SolTransfer { mint, .. } = &self.payout(id).kind {
                let mint = mint.clone();
                let pool = self.custody.vault_pool.entry(mint).or_insert(0);
                *pool = pool.saturating_add(u64::try_from(solana.pool_used.0).expect("u64"));
            }
        }
    }

    /// Validates a nonce proof: System-owned, `Current`, initialized, authority = vault.
    fn nonce_proof(&self, nonce: &SolNonceProof, vault: &Pubkey) -> SolProof {
        let pubkey = sol::parse_pubkey(&nonce.account)
            .unwrap_or_else(|_| env::panic_str("Nonce account must be a base58 key"));
        let account = SvmAccount {
            owner: Bytes32(SYSTEM_PROGRAM),
            data: parse_hex(&nonce.data, "nonce data"),
        };
        NonceAccount::from_account_state(&account, vault)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid nonce account: {e:?}")));
        SolProof {
            anchor: parse_anchor(&nonce.anchor_tx),
            pubkey,
            account,
        }
    }

    /// Marks the nonce value pending, stores the message and requests the attestation of the
    /// nonce account.
    fn prove_then_sign(
        &mut self,
        id: PayoutId,
        proof: &SolProof,
        nonce_value: [u8; 32],
        instructions: &[Instruction],
    ) -> Promise {
        let key = ReplayKey::SolNonce {
            account: sol::format_pubkey(&proof.pubkey),
            value: sol::format_pubkey(&nonce_value),
        };
        self.mark_pending(&key);
        let (_, gas) = self.sol_keys();
        self.store_sol_message(
            id,
            &gas,
            instructions,
            nonce_value,
            Some(proof.pubkey),
            PATH_VAULT_SOL,
        );
        let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: Bytes64(proof.anchor),
            finality: SvmFinality::Finalized,
            extractors: vec![SvmExtractor::AccountState {
                pubkey: Bytes32(proof.pubkey),
            }],
        });
        let hash = payload_hash(
            request.clone(),
            vec![ExtractedValue::account(proof.account.clone())],
        );
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_NONCE_CALLBACK)
                .on_sol_nonce_verified(U64(id), hex::encode(hash), key),
        )
    }

    /// Compiles and stores the message of a Solana action.
    pub(super) fn store_sol_message(
        &mut self,
        id: PayoutId,
        fee_payer: &Pubkey,
        instructions: &[Instruction],
        blockhash: [u8; 32],
        nonce_account: Option<Pubkey>,
        authority_path: &str,
    ) -> Vec<u8> {
        let message = sol::LegacyMessage::compile(fee_payer, instructions, blockhash)
            .unwrap_or_else(|e| env::panic_str(&format!("Cannot compile the message: {e:?}")))
            .serialize();
        require!(
            message.len() + 1 + 2 * 64 <= sol::MAX_TRANSACTION_LEN,
            "Transaction would exceed the Solana packet size"
        );
        let payout = self.payout_mut(id);
        payout.solana = Some(super::types::SolTransaction {
            message: hex::encode(&message),
            withdraws: Vec::new(),
            pool_used: U128(0),
            pool_credit: U128(0),
            nonce_account: nonce_account.map(|key| sol::format_pubkey(&key)),
            nonce_value: nonce_account.map(|_| sol::format_pubkey(&blockhash)),
            authority_path: authority_path.to_string(),
            authority_signature: None,
            gas_signature: None,
            transaction: None,
        });
        message
    }

    /// The stored message bytes of a Solana action.
    fn sol_message_bytes(&self, id: PayoutId) -> Vec<u8> {
        let payout = self.payout(id);
        let solana = payout
            .solana
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Not a Solana action"));
        hex::decode(&solana.message).expect("stored hex")
    }

    /// Requests the joined signatures of `authority_path` and `gas/sol` over `message`.
    pub(super) fn sign_sol_pair(
        &mut self,
        id: PayoutId,
        authority_path: &str,
        message: Vec<u8>,
    ) -> Promise {
        self.sign_eddsa_promise(authority_path, message.clone())
            .and(self.sign_eddsa_promise(super::PATH_GAS_SOL, message))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_SOL_SIGN_CALLBACK)
                    .on_sol_signed(U64(id)),
            )
    }

    /// Stores the signatures that arrived and assembles the wire transaction once both exist:
    /// `[2] || sig(gas/sol) || sig(authority) || message` (the fee payer is the first signer of
    /// every message the engine compiles).
    fn store_sol_signatures(
        &mut self,
        id: PayoutId,
        authority: Option<[u8; 64]>,
        gas: Option<[u8; 64]>,
    ) {
        let payout = self.payout_mut(id);
        let solana = payout
            .solana
            .as_mut()
            .unwrap_or_else(|| env::panic_str("Not a Solana action"));
        if let Some(signature) = authority {
            solana.authority_signature = Some(hex::encode(signature));
        }
        if let Some(signature) = gas {
            solana.gas_signature = Some(hex::encode(signature));
        }
        let decode = |text: &Option<String>| -> Option<[u8; 64]> {
            text.as_ref()
                .and_then(|hex_text| hex::decode(hex_text).ok())
                .and_then(|bytes| bytes.try_into().ok())
        };
        if let (Some(authority), Some(gas)) = (
            decode(&solana.authority_signature),
            decode(&solana.gas_signature),
        ) {
            let message = hex::decode(&solana.message).expect("stored hex");
            let transaction = sol::assemble_transaction(&message, &[gas, authority])
                .expect("size checked at build time");
            solana.transaction = Some(hex::encode(transaction));
        }
    }

    /// The nonce replay key of a Solana payout, when it uses one.
    fn nonce_key(&self, id: PayoutId) -> Option<ReplayKey> {
        let solana = self.payout(id).solana.as_ref()?;
        Some(ReplayKey::SolNonce {
            account: solana.nonce_account.clone()?,
            value: solana.nonce_value.clone()?,
        })
    }

    /// Marks a position as releasing.
    fn start_release(&mut self, position_id: PositionId, payout_id: PayoutId, account: &AccountId) {
        self.custody.releasing.insert(position_id, payout_id);
        self.emit(RoseEvent::PositionReleaseRequested {
            position_id: U64(position_id),
            payout_id: U64(payout_id),
            account: account.clone(),
        });
    }

    /// Marks a payout signed and applies its side effects (a released position).
    pub(super) fn complete_payout(&mut self, id: PayoutId) {
        let payout = self.payout_mut(id);
        payout.status = PayoutStatus::Signed;
        payout.updated_at = U64(env::block_timestamp());
        let requester = payout.requester.clone();
        let released = match (&payout.debit, payout.position_id) {
            (PayoutDebit::Units { .. }, Some(position_id)) => Some(position_id.0),
            _ => None,
        };
        let pool_credit = payout
            .solana
            .as_ref()
            .map_or(0, |solana| solana.pool_credit.0);
        let mint = match &payout.kind {
            PayoutKind::SolRelease { .. } => self
                .custody
                .sol_streams
                .get(&released.expect("a release names its position"))
                .map(|stream| stream.mint.clone()),
            _ => None,
        };
        self.release_hold(&requester);
        self.release_draws(id);
        if let (Some(mint), true) = (mint, pool_credit > 0) {
            let pool = self.custody.vault_pool.entry(mint).or_insert(0);
            *pool = pool.saturating_add(u64::try_from(pool_credit).expect("u64 amount"));
        }
        if let Some(position_id) = released {
            self.custody.releasing.remove(&position_id);
            self.mark_position_released(position_id, &requester);
        }
        self.emit(RoseEvent::PayoutSigned { payout_id: U64(id) });
    }

    /// Marks a payout failed and refunds its debit (and reverts its withdraw accounting).
    pub(super) fn fail_payout(&mut self, id: PayoutId, reason: &str) {
        let debit = self.payout(id).debit.clone();
        self.revert_sol_plan(id);
        match &debit {
            PayoutDebit::None => {}
            PayoutDebit::Claimable { source, amount } => {
                self.refund_claimable(&ClaimSource::from(source), amount.0);
            }
            PayoutDebit::Cash {
                account,
                venue,
                amount,
            } => self.credit_cash(account, venue, amount.0),
            PayoutDebit::Units {
                position_id,
                class_id,
                account,
                units,
            } => {
                self.custody.releasing.remove(&position_id.0);
                let f_now = self.fraction_now(class_id);
                self.mint_units_owed(class_id, account, units.0, f_now);
            }
        }
        let payout = self.payout_mut(id);
        payout.status = PayoutStatus::Failed {
            reason: reason.to_string(),
        };
        payout.updated_at = U64(env::block_timestamp());
        let requester = payout.requester.clone();
        self.release_hold(&requester);
        self.emit(RoseEvent::PayoutFailed {
            payout_id: U64(id),
            reason: reason.to_string(),
        });
    }

    /// Whether a refused deposit may request a return now (none yet, or the last one failed).
    pub(super) fn return_allowed(&self, refused: &super::types::RefusedDeposit) -> bool {
        refused.return_payout.is_none_or(|id| {
            matches!(
                self.custody.payouts.get(&id.0).map(|p| &p.status),
                Some(PayoutStatus::Failed { .. })
            )
        })
    }
}

#[near]
impl Contract {
    /// Sends a refused deposit back: on Base, signs `Release(lockup, streamId, to = sender, id)`;
    /// on Solana, signs `transfer_recipient` from where the stream sits (the vault or the
    /// deposit address) to the return address named at attribution, with the caller-supplied
    /// recent blockhash. Anyone; attach the payout storage deposit; at least 30 Tgas (Base) or
    /// 50 Tgas (Solana). Callable again only when the previous return failed.
    #[payable]
    pub fn return_refused_deposit(
        &mut self,
        key: ReplayKey,
        recent_blockhash: Option<String>,
    ) -> Promise {
        Self::assert_payout_deposit();
        let refused = self
            .custody
            .refused
            .get(&key)
            .cloned()
            .unwrap_or_else(|| env::panic_str("No refused deposit under this key"));
        require!(
            self.return_allowed(&refused),
            "A return of this deposit is already signed or in flight"
        );
        match &refused.asset {
            RefusedAsset::BaseStream { lockup, stream_id } => {
                require!(
                    env::prepaid_gas() >= super::base::GAS_FOR_BASE_AUTHORIZATION,
                    "At least 30 Tgas are required for a Base authorization"
                );
                self.return_base_stream(&key, lockup, *stream_id, &refused.return_to)
            }
            RefusedAsset::SolStream {
                metadata,
                held_by,
                held_by_path,
            } => {
                require!(
                    env::prepaid_gas() >= GAS_FOR_SOL_ACTION,
                    "At least 50 Tgas are required for a Solana action"
                );
                let blockhash = recent_blockhash
                    .unwrap_or_else(|| env::panic_str("A recent blockhash is required"));
                self.return_sol_stream(
                    &key,
                    metadata,
                    held_by,
                    held_by_path,
                    &refused.return_to,
                    &blockhash,
                )
            }
        }
    }
}

/// An EVM recipient, required to equal `restricted_to` when a source restricts it.
fn evm_recipient(to: &str, restricted_to: Option<&str>) -> evm::Address {
    let address = evm::parse_address(to)
        .unwrap_or_else(|| env::panic_str("to must be a 20-byte hex address"));
    require!(address != [0u8; 20], "to must not be the zero address");
    if let Some(restricted) = restricted_to {
        require!(
            evm::parse_address(restricted) == Some(address),
            "This source pays only to its retire_to address"
        );
    }
    address
}

/// A Solana recipient owner, required to equal `restricted_to` when a source restricts it.
fn sol_recipient(to: &str, restricted_to: Option<&str>) -> Pubkey {
    let owner =
        sol::parse_pubkey(to).unwrap_or_else(|_| env::panic_str("to must be a base58 public key"));
    if let Some(restricted) = restricted_to {
        require!(
            sol::parse_pubkey(restricted) == Ok(owner),
            "This source pays only to its retire_to address"
        );
    }
    owner
}

pub(super) fn parse_hex(text: &str, what: &str) -> Vec<u8> {
    crate::foreign::mpc::parse_hex(text)
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be hex")))
}

pub(super) fn parse_anchor(text: &str) -> [u8; 64] {
    let mut anchor = [0u8; 64];
    match bs58::decode(text).onto(&mut anchor) {
        Ok(64) => anchor,
        _ => env::panic_str("anchor_tx must be a base58 transaction signature"),
    }
}
