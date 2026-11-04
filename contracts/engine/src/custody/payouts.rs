//! Payouts and in-kind redeems (spec section 7.3): the engine debits the ledger, builds the
//! authorization or transaction itself, asks the MPC to sign it and stores the result for anyone
//! to submit on the foreign chain.
//!
//! A Base authorization is final once signed: RoseVault holds the tokens and its replay bitmap
//! makes the authorization usable once. A Solana transaction is not: a durable-nonce transaction
//! that fails on chain still advances its nonce, so a signed payout or redeem stays `Signed`
//! until someone proves its nonce advanced (`confirm_sol_payout`, `confirm_sol_redeem`); the
//! streams attested in the same proof then say whether it executed. Only then is the payout
//! final (`Landed`) or refunded (`Failed`).
//!
//! A Solana payout draws on streams the vault still holds, which the claimant names, and on its
//! class's swept balance: the transaction is `[AdvanceNonce] + one Streamflow withdraw(amount)
//! per stream + TransferChecked(sum) + [AdvanceNonce(receipt)]` from the vault's token account to
//! the claimant's existing token account. What the streams pay in, the transfer pays out in the
//! same transaction; the rest is the swept balance, tokens `sync_sol_stream` proved Streamflow's
//! auto-claim moved into the vault's token account. A payout's verdict reads only its two nonce
//! accounts: a durable-nonce transaction that fails still advances its nonce but not its
//! receipt, one that executes leaves both on the same value. Neither the streams (which the
//! auto-claim empties at their end), nor the vault's token account (which anyone can send
//! tokens to), nor the recipient's (which its owner controls) take part in it. A stream carries
//! at most one unconfirmed payout at a time (`SolStreamInfo::drawing`), and its accounting moves
//! (`engine_withdrawn`) only when a withdrawal is proven or synced.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{env, near, require, AccountId, Gas, Promise, PromiseOrValue};

use super::types::{
    ClaimSourceArgs, Payout, PayoutDebit, PayoutId, PayoutKind, PayoutStatus, RefusedAsset,
    ReplayKey, SolDraw, SolDrawArgs, SolNonceProof, SolStreamInfo, SolSwept, SolTransaction,
    StoredClaimSource,
};
use super::{
    require_gas_left, MpcResult, GAS_FOR_RECORD_CALLBACK, PATH_GAS_SOL, PATH_VAULT_SOL,
    PENDING_EXPIRY_BLOCKS, TGAS_CALLBACK_WORK, TGAS_CALL_FEES, TGAS_MPC_REQUEST, TGAS_PROOF,
    TGAS_SIGN_PAIR,
};
use crate::foreign::evm::{self, ReleaseAuthorization, TransferAuthorization};
use crate::foreign::mpc::{
    payload_hash, Bytes32, Bytes64, ExtractedValue, ForeignChainRpcRequest, SvmAccount,
    SvmExtractor, SvmFinality, SvmRpcRequest,
};
use crate::foreign::solana::{
    self as sol, advance_nonce_account, associated_token_address, create_with_seed,
    spl_transfer_checked, streamflow_transfer_recipient, streamflow_withdraw, Instruction,
    NonceAccount, Pubkey, StreamflowWithdrawAccounts, TokenAccount, MAX_SEED_LEN, SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
};
use crate::types::{
    Chain, ClaimSource, ClassId, Holder, PositionId, PositionSource, PositionState, Venue,
};
use crate::{Contract, ContractExt, RoseEvent};

/// Static gas of the payout proof callback: the joined signatures it requests and its own work.
const GAS_FOR_NONCE_CALLBACK: Gas = Gas::from_tgas(TGAS_SIGN_PAIR + TGAS_CALLBACK_WORK);
/// Tgas a payout proof, its callback and the signatures it requests cost the user call.
const TGAS_PROVE_THEN_SIGN: u64 =
    TGAS_MPC_REQUEST + TGAS_SIGN_PAIR + TGAS_CALLBACK_WORK + TGAS_CALL_FEES;
/// Most extractors one ForeignTx request may carry (`MAX_EXTRACTORS_PER_REQUEST` of the MPC
/// contract interface 3.18.0).
pub(super) const MAX_EXTRACTORS: usize = 32;
/// Length of the seed prefix that binds a nonce account to a NEAR account (hex characters of
/// `sha256(account id)`: 96 bits, out of reach of a second-preimage search).
const NONCE_SEED_PREFIX_LEN: usize = 24;
/// Seconds before a stream's `end_time` from which it takes no new draw and no redeem: Streamflow's
/// auto-claim withdraws an ended stream into the vault's token account one second after its end
/// (measured on devnet), after which a Streamflow `withdraw` or `transfer_recipient` of it fails
/// on chain. Its remainder is paid from the class's swept balance once `sync_sol_stream` books
/// it.
pub const SOL_DRAW_CUTOFF_SECS: u64 = 300;

/// The proven accounts of a Solana payout or redeem.
struct PayoutAccounts {
    anchor: [u8; 64],
    nonce: Pubkey,
    nonce_account: SvmAccount,
    nonce_value: [u8; 32],
    receipt: Pubkey,
    receipt_account: SvmAccount,
    recipient_tokens: Pubkey,
    recipient_account: SvmAccount,
}

#[near]
impl Contract {
    /// Claims `amount` unlocked tokens of a Base class to the EVM address `to`: debits the
    /// source, then asks the MPC to sign RoseVault `Transfer(token, to, amount, id)`; the
    /// signature is stored in the payout and the claimant submits `executeTransfer`. Holdings
    /// and lien shares are the caller's; a retired lot is payable by anyone to its `retire_to`
    /// address only. Attach the payout storage deposit and 80 Tgas (the call keeps 50 Tgas for
    /// the signature request and its callback).
    #[payable]
    pub fn claim_base_tokens(
        &mut self,
        source: ClaimSourceArgs,
        amount: U128,
        to: String,
    ) -> Promise {
        Self::assert_payout_deposit();
        let caller = env::predecessor_account_id();
        let source = source.resolve(&caller);
        let receipt = self.take_claimable(&source, amount.0);
        require!(receipt.chain == Chain::Base, "Not a Base class");
        let to = self.evm_recipient(&to, receipt.restricted_to.as_deref());
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
    /// RoseVault `Transfer` authorization. Attach the payout storage deposit and 80 Tgas.
    #[payable]
    pub fn withdraw_base_cash(&mut self, token: String, amount: U128, to: String) -> Promise {
        Self::assert_payout_deposit();
        require!(amount.0 > 0, "Amount must be positive");
        let caller = env::predecessor_account_id();
        let token = super::base::canonical_address(&token, "token");
        let venue = Venue::Base {
            token: token.clone(),
        };
        self.debit_cash(&caller, &venue, amount.0);
        let to = self.evm_recipient(&to, None);
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

    /// Claims unlocked tokens of a Solana class to `to_owner`'s existing associated token
    /// account. The caller names the streams of the class to draw on (`draws`, at most what each
    /// can pay now: unlocked minus accounted withdrawals; at least one whole token per stream
    /// unless the draw empties it; a stream with an unconfirmed payout, or within
    /// [`SOL_DRAW_CUTOFF_SECS`] of its end, cannot be drawn on) and what to take from the
    /// class's swept balance (`swept`, at most `get_sol_swept(class).available`); the claimed
    /// amount is their sum. The engine debits the source, proves the caller's durable nonce and
    /// receipt nonce accounts (authority = vault, addresses derived with seeds bound to the
    /// caller, neither reserved by another unsettled action, see [`SolNonceProof`]) and the
    /// recipient's token account (initialized, of the class mint, owned by `to_owner`) with
    /// one ForeignTx request, then has `vault/sol` and `gas/sol` sign `AdvanceNonceAccount`,
    /// one Streamflow `withdraw` per draw, `TransferChecked` of the sum and the receipt's
    /// `AdvanceNonceAccount`. The payout stays `Signed` until `confirm_sol_payout`. Attach the
    /// payout storage deposit and 200 Tgas (the call keeps 105 Tgas for its chain).
    #[payable]
    pub fn claim_sol_tokens(
        &mut self,
        source: ClaimSourceArgs,
        draws: Vec<SolDrawArgs>,
        swept: Option<U128>,
        to_owner: String,
        nonce: SolNonceProof,
    ) -> Promise {
        Self::assert_payout_deposit();
        Self::require_mpc_reserve();
        let caller = env::predecessor_account_id();
        let source = source.resolve(&caller);
        let class_id = self.claim_class(&source);
        let class = self.class(&class_id).clone();
        require!(class.chain == Chain::Solana, "Not a Solana class");
        let (planned, drawn) = self.check_draws(&class_id, class.decimals, &draws);
        let swept = u64::try_from(swept.map_or(0, |amount| amount.0)).unwrap_or(u64::MAX);
        let available = self.swept_of(&class_id).available();
        require!(
            swept <= available,
            format!("The class's swept balance can pay at most {available} now")
        );
        let total = drawn
            .checked_add(swept)
            .unwrap_or_else(|| env::panic_str("Amount exceeds the SPL token range"));
        require!(
            total > 0,
            "Name at least one stream to draw on, or an amount of the class's swept balance"
        );
        let to_owner = sol_recipient(&to_owner, None);
        let mint = sol::parse_pubkey(&class.token).expect("stored base58 mint");
        let (vault, _) = self.sol_keys();
        self.require_outside_recipient(&to_owner);
        let accounts = self.payout_accounts(&nonce, &caller, &vault, &mint, &to_owner);
        let vault_tokens = associated_token_address(&vault, &mint).expect("valid seeds");
        let mut instructions = vec![advance_nonce_account(accounts.nonce, vault)];
        for (_, stream, amount) in &planned {
            instructions.push(streamflow_withdraw(
                self.streamflow_program(),
                &withdraw_accounts(stream, vault, vault_tokens),
                *amount,
            ));
        }
        instructions.push(spl_transfer_checked(
            vault_tokens,
            mint,
            accounts.recipient_tokens,
            vault,
            total,
            class.decimals,
        ));
        instructions.push(advance_nonce_account(accounts.receipt, vault));
        let message = self.compile_sol_message(&instructions, accounts.nonce_value);
        let receipt = self.take_claimable(&source, u128::from(total));
        sol_recipient(
            &sol::format_pubkey(&to_owner),
            receipt.restricted_to.as_deref(),
        );
        let id = self.new_payout(
            Chain::Solana,
            PayoutKind::SolTransfer {
                mint: receipt.token,
                to_owner: sol::format_pubkey(&to_owner),
                amount: U128(u128::from(total)),
            },
            PayoutDebit::Claimable {
                source: StoredClaimSource::from(&source),
                amount: U128(u128::from(total)),
            },
            &caller,
            None,
        );
        self.store_sol_message(
            id,
            message,
            accounts.nonce_value,
            Some((accounts.nonce, accounts.receipt)),
            PATH_VAULT_SOL,
            &vault,
        );
        self.hold_nonce_accounts(id, &accounts);
        if swept > 0 {
            let balance = self.custody.swept.entry(class_id.clone()).or_default();
            balance.pending = U64(balance.pending.0 + swept);
            self.sol_transaction_mut(id).swept = U64(swept);
        }
        let mut recorded = Vec::with_capacity(planned.len());
        for (position_id, _, amount) in &planned {
            let position_id = *position_id;
            let info = self
                .custody
                .sol_streams
                .get_mut(&position_id)
                .expect("checked draw");
            info.drawing = Some(U64(id));
            info.pending_withdraw = U64(*amount);
            recorded.push(SolDraw {
                position_id: U64(position_id),
                amount: U128(u128::from(*amount)),
                expected_withdrawn: U128(u128::from(info.engine_withdrawn.0) + u128::from(*amount)),
            });
        }
        self.sol_transaction_mut(id).draws = recorded;
        self.prove_then_sign(id, &accounts)
    }

    /// Redeems a position in kind: burns its allocation `D_p` in class units from the caller's
    /// free units (units locked in rounds or encumbered by liens cannot be redeemed) and
    /// authorizes the release of the position to `to`; the position is `Releasing` meanwhile.
    /// On Base, a RoseVault `Release` (the vault withdraws the vested balance to itself first),
    /// final once signed. On Solana the caller also pays, from its own claimable tokens of the
    /// class, the stream's unlocked tokens not withdrawn yet (they belong to the unit holders and
    /// leave with the stream); the stream must carry no unconfirmed payout; `nonce` proves the
    /// durable nonce and receipt nonce accounts and `to`'s existing token account for the mint;
    /// the stream must be more than [`SOL_DRAW_CUTOFF_SECS`] from its end (Streamflow's
    /// auto-claim empties it at the end and its `transfer_recipient` then fails); the
    /// transaction is `[AdvanceNonce] + transfer_recipient(vault -> to) + [AdvanceNonce(receipt)]`
    /// and stays `Signed` until `confirm_sol_redeem` proves it executed (the burn is then
    /// final) or not (the units and the claimable tokens come back). Attach the payout storage
    /// deposit; 80 Tgas on Base, 200 Tgas on Solana.
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
            "Position is not held: already released or a release is in flight"
        );
        let class_id = position.class_id.clone();
        let f_burned = self.fraction_now(&class_id);
        match &position.source {
            PositionSource::BaseStream { lockup, stream_id } => {
                let stream_id = u64::try_from(stream_id.0).expect("stored from u64");
                let to = self.evm_recipient(&to, None);
                self.burn_units(&class_id, &caller, position.allocation.0);
                let id = self.new_payout(
                    Chain::Base,
                    PayoutKind::BaseRelease {
                        lockup: lockup.clone(),
                        stream_id,
                        to: evm::format_address(&to),
                        vested_to_recipient: false,
                    },
                    PayoutDebit::Units {
                        position_id,
                        class_id,
                        account: caller.clone(),
                        units: position.allocation,
                        f_burned: U128(f_burned),
                        claimable: U128(0),
                    },
                    &caller,
                    Some(position_id.0),
                );
                self.start_release(position_id.0, id, &caller);
                let authorization = ReleaseAuthorization {
                    lockup: evm::parse_address(lockup).expect("stored lowercase address"),
                    stream_id,
                    to,
                    vested_to_recipient: false,
                    id,
                };
                self.request_base_signature(id, authorization.digest(&self.eip712_domain()))
            }
            PositionSource::SolanaStream { metadata } => {
                Self::require_mpc_reserve();
                let nonce =
                    nonce.unwrap_or_else(|| env::panic_str("A nonce account proof is required"));
                let stream = self.sol_stream(position_id.0);
                require!(
                    stream.drawing.is_none(),
                    "A payout drawing on this stream is not confirmed yet: confirm it (confirm_sol_payout) before redeeming"
                );
                require!(
                    drawable(&stream),
                    "The stream ends within five minutes or has ended: Streamflow's auto-claim empties it into the vault, claim its tokens instead"
                );
                let owed = self.owed_by_stream(&stream, position.allocation.0, f_burned);
                require!(
                    stream.engine_withdrawn.0 < stream.net_amount_deposited.0,
                    "Stream is fully withdrawn: there is nothing left to release"
                );
                let to_owner = sol_recipient(&to, None);
                let mint = sol::parse_pubkey(&stream.mint).expect("stored base58 mint");
                let (vault, _) = self.sol_keys();
                self.require_outside_recipient(&to_owner);
                require!(
                    sol::format_pubkey(&to_owner) != self.sol_deposit(metadata).deposit_address,
                    "The recipient must not be the stream's deposit address"
                );
                let accounts = self.payout_accounts(&nonce, &caller, &vault, &mint, &to_owner);
                let owner_source = ClaimSource::Holding {
                    account: caller.clone(),
                    class_id: class_id.clone(),
                };
                let claimable = self.claimable_of(&owner_source);
                require!(
                    claimable >= u128::from(owed),
                    format!(
                        "Redeeming this stream takes {owed} claimable tokens of the class (what its units accrued and payouts did not withdraw, which leaves with it); you have {claimable}"
                    )
                );
                self.burn_units(&class_id, &caller, position.allocation.0);
                if owed > 0 {
                    self.take_claimable(&owner_source, u128::from(owed));
                }
                let instructions = vec![
                    advance_nonce_account(accounts.nonce, vault),
                    streamflow_transfer_recipient(
                        self.streamflow_program(),
                        vault,
                        to_owner,
                        accounts.recipient_tokens,
                        sol::parse_pubkey(metadata).expect("stored base58"),
                        mint,
                    ),
                    advance_nonce_account(accounts.receipt, vault),
                ];
                let id = self.new_payout(
                    Chain::Solana,
                    PayoutKind::SolRelease {
                        metadata: metadata.clone(),
                        to_owner: sol::format_pubkey(&to_owner),
                    },
                    PayoutDebit::Units {
                        position_id,
                        class_id,
                        account: caller.clone(),
                        units: position.allocation,
                        f_burned: U128(f_burned),
                        claimable: U128(u128::from(owed)),
                    },
                    &caller,
                    Some(position_id.0),
                );
                self.start_release(position_id.0, id, &caller);
                let message = self.compile_sol_message(&instructions, accounts.nonce_value);
                self.store_sol_message(
                    id,
                    message,
                    accounts.nonce_value,
                    Some((accounts.nonce, accounts.receipt)),
                    PATH_VAULT_SOL,
                    &vault,
                );
                self.hold_nonce_accounts(id, &accounts);
                self.prove_then_sign(id, &accounts)
            }
        }
    }

    /// Payout proof callback: on a matching attestation consumes the nonce value and requests
    /// the joined `vault/sol` and `gas/sol` signatures; otherwise refunds the debit and clears
    /// the nonce (nothing was signed). A callback for a payout no longer waiting for its proof
    /// changes nothing. Called by the contract itself.
    #[private]
    pub fn on_sol_nonce_verified(
        &mut self,
        payout_id: U64,
        expected_hash: String,
        key: ReplayKey,
    ) -> PromiseOrValue<bool> {
        let id = payout_id.0;
        let payout = self.payout(id);
        if payout.status != PayoutStatus::Requested || payout.sign_requests > 0 {
            return PromiseOrValue::Value(false);
        }
        let since = payout.requested_block.0;
        if !Self::attestation_matches(&expected_hash) || !self.consume(&key) {
            self.clear_own_pending(&key, since);
            self.fail_payout(id, "nonce or recipient attestation failed or mismatched");
            return PromiseOrValue::Value(false);
        }
        let message = self.sol_message_bytes(id);
        PromiseOrValue::Promise(self.sign_sol_pair(id, PATH_VAULT_SOL, message))
    }

    /// Joined signature callback: stores the signatures that verify against their keys and
    /// assembles the transaction once both exist (`Signed`), or keeps a vault signature whose
    /// fee-payer counterpart is missing (`AwaitingGasSignature`). A failed authority request
    /// (`PromiseError`) never refunds a durable-nonce action, since a late signature of it could
    /// still surface and execute: the action is cancelled instead by a transaction that only
    /// advances the nonce (signed through `retry_sol_payout`, open at once), and its confirmation
    /// settles it. A failed move or return (recent blockhash, nothing debited) is marked failed.
    /// An unreadable response leaves the action `Requested` for `submit_sol_signature` or a retry
    /// after the expiry. Called by the contract itself.
    #[private]
    pub fn on_sol_signed(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        let status = self.payout(id).status.clone();
        if !matches!(
            status,
            PayoutStatus::Requested | PayoutStatus::AwaitingGasSignature
        ) {
            return false;
        }
        let authority = Self::sign_result(0);
        let gas = Self::sign_result(1);
        if let MpcResult::Value(response) = &authority {
            if let Some(signature) = response.as_ed25519() {
                self.accept_sol_signature(id, false, signature);
            }
        }
        if let MpcResult::Value(response) = &gas {
            if let Some(signature) = response.as_ed25519() {
                self.accept_sol_signature(id, true, signature);
            }
        }
        let payout = self.payout(id);
        let solana = payout.solana.as_ref().expect("Solana action");
        match (
            solana.authority_signature.is_some(),
            solana.gas_signature.is_some(),
        ) {
            (true, true) => {
                self.complete_payout(id);
                true
            }
            (true, false) => {
                if payout.status == PayoutStatus::Requested {
                    let payout = self.payout_mut(id);
                    payout.status = PayoutStatus::AwaitingGasSignature;
                    payout.updated_at = U64(env::block_timestamp());
                    self.emit(RoseEvent::PayoutAwaitingGasSignature { payout_id });
                }
                false
            }
            (false, _) => {
                if matches!(authority, MpcResult::Failed) {
                    if solana.nonce_account.is_some() {
                        self.cancel_sol_payout(id);
                    } else {
                        self.fail_payout(id, "authority signature not produced");
                    }
                }
                false
            }
        }
    }

    /// Re-requests the `gas/sol` signature over the stored message of a payout whose vault
    /// signature exists. Anyone; about 50 Tgas.
    pub fn resign_sol_gas(&mut self, payout_id: U64) -> Promise {
        let id = payout_id.0;
        require!(
            self.payout(id).status == PayoutStatus::AwaitingGasSignature,
            "Payout is not awaiting the fee payer signature"
        );
        Self::require_mpc_reserve();
        require_gas_left(TGAS_MPC_REQUEST + super::TGAS_RECORD_CALLBACK + TGAS_CALL_FEES);
        let message = self.sol_message_bytes(id);
        self.sign_eddsa_promise(PATH_GAS_SOL, message).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                .on_sol_gas_resigned(payout_id),
        )
    }

    /// Fee-payer re-signature callback. Called by the contract itself.
    #[private]
    pub fn on_sol_gas_resigned(&mut self, payout_id: U64) -> bool {
        let id = payout_id.0;
        if self.payout(id).status != PayoutStatus::AwaitingGasSignature {
            return false;
        }
        let MpcResult::Value(response) = Self::sign_result(0) else {
            return false;
        };
        match response.as_ed25519() {
            Some(signature) if self.accept_sol_signature(id, true, signature) => {
                self.complete_payout(id);
                true
            }
            _ => false,
        }
    }

    /// Completes a Solana action with a signature the callback could not read: `signature`
    /// (hex, 64 bytes) must verify against the key of `signer_path` (the action's authority
    /// path or `gas/sol`) over the stored message. Anyone, once the signatures were requested.
    pub fn submit_sol_signature(&mut self, payout_id: U64, signer_path: String, signature: String) {
        let id = payout_id.0;
        let payout = self.payout(id);
        require!(
            matches!(
                payout.status,
                PayoutStatus::Requested | PayoutStatus::AwaitingGasSignature
            ) && payout.sign_requests > 0,
            "Payout is not awaiting a signature"
        );
        let solana = payout
            .solana
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Not a Solana action"));
        let is_gas = if signer_path == PATH_GAS_SOL {
            true
        } else {
            require!(
                signer_path == solana.authority_path,
                "signer_path is neither the authority path nor gas/sol"
            );
            false
        };
        let signature: [u8; 64] = crate::foreign::mpc::parse_hex_array(&signature)
            .unwrap_or_else(|| env::panic_str("signature must be 64 bytes of hex"));
        require!(
            self.accept_sol_signature(id, is_gas, &signature),
            "Signature does not verify against the signer's derived key"
        );
        let solana = self.payout(id).solana.as_ref().expect("Solana action");
        match (
            solana.authority_signature.is_some(),
            solana.gas_signature.is_some(),
        ) {
            (true, true) => self.complete_payout(id),
            (true, false) => {
                let payout = self.payout_mut(id);
                payout.status = PayoutStatus::AwaitingGasSignature;
                payout.updated_at = U64(env::block_timestamp());
                self.emit(RoseEvent::PayoutAwaitingGasSignature { payout_id });
            }
            (false, _) => {}
        }
    }

    /// Resolves a Solana action still `Requested` [`PENDING_EXPIRY_BLOCKS`] blocks after its
    /// last request (a callback ran out of gas), or at once when that request failed. Waiting
    /// for its proof: the request is abandoned and the debit refunded (nothing was signed).
    /// Signed with a recent blockhash (a move or a return): marked failed (nothing was debited,
    /// and the blockhash has expired; request the action again). Waiting for its durable-nonce
    /// signatures: the stored message (the original, or the nonce-advancing cancellation) is
    /// signed again. Anyone; about 100 Tgas.
    pub fn retry_sol_payout(&mut self, payout_id: U64) -> Option<Promise> {
        let id = payout_id.0;
        let payout = self.payout(id).clone();
        require!(payout.chain == Chain::Solana, "Not a Solana action");
        require!(
            payout.status == PayoutStatus::Requested,
            "Payout is not awaiting a proof or a signature"
        );
        require!(
            env::block_height() >= payout.requested_block.0 + PENDING_EXPIRY_BLOCKS,
            "The last request is still in flight"
        );
        match self.nonce_key(id) {
            Some(key) if payout.sign_requests == 0 => {
                self.clear_own_pending(&key, payout.requested_block.0);
                self.fail_payout(id, "proof request abandoned");
                None
            }
            None => {
                self.fail_payout(id, "signature request abandoned");
                None
            }
            Some(_) => {
                Self::require_mpc_reserve();
                require_gas_left(TGAS_SIGN_PAIR);
                let message = self.sol_message_bytes(id);
                let path = payout.solana.expect("Solana action").authority_path;
                Some(self.sign_sol_pair(id, &path, message))
            }
        }
    }

    /// Settles a signed Solana payout once its durable nonce advanced (the transaction can no
    /// longer execute): one ForeignTx `AccountState` request at `Finalized` proves the nonce
    /// account (`nonce_data`, its value must differ from the signed one) and the receipt nonce
    /// account (`receipt_data`). A receipt holding the nonce's new value proves the transaction
    /// executed (only it advances the receipt, and it leaves both accounts on the value of the
    /// block it executed in): the payout is `Landed` and its withdrawals count. A receipt behind
    /// the nonce proves the transaction failed on chain or its cancellation executed; that
    /// verdict needs two such proofs, the second requested at least
    /// [`super::CONFIRM_FAILURE_DELAY_BLOCKS`] after the first one's answer (the nodes read each
    /// account separately, and a lagging read of the receipt right after the landing must not
    /// pass for "did not execute"), then the claim is refunded. Both accounts stay reserved to
    /// the payout until then, so no other engine-signed transaction can move either.
    /// `anchor_tx` is any successful finalized transaction not newer than the reads (the
    /// payout's own transaction when it succeeded). Anyone; attach 100 Tgas. Bytes are hex,
    /// read at `finalized`.
    pub fn confirm_sol_payout(
        &mut self,
        payout_id: U64,
        anchor_tx: String,
        nonce_data: String,
        receipt_data: String,
    ) -> Promise {
        let payout = self.payout(payout_id.0);
        require!(
            matches!(payout.kind, PayoutKind::SolTransfer { .. }),
            "Not a Solana payout"
        );
        require!(
            payout.status == PayoutStatus::Signed,
            "Payout is not awaiting confirmation"
        );
        self.request_confirmation(payout_id.0, &anchor_tx, &nonce_data, &receipt_data)
    }

    /// Settles the signed release of a Solana position once its durable nonce advanced, with the
    /// same proof and verdict as [`Self::confirm_sol_payout`]: a receipt holding the nonce's new
    /// value proves the release executed, the burn is final and the position `Released`; a
    /// receipt behind it on two proofs [`super::CONFIRM_FAILURE_DELAY_BLOCKS`] apart proves it
    /// did not, the units come back to the redeemer (accruing from the burn), so do the
    /// claimable tokens it paid, and the position is `Held` again. Anyone; attach 100 Tgas.
    /// Bytes are hex, read at `finalized`.
    pub fn confirm_sol_redeem(
        &mut self,
        position_id: U64,
        anchor_tx: String,
        nonce_data: String,
        receipt_data: String,
    ) -> Promise {
        let id = self
            .custody
            .releasing
            .get(&position_id.0)
            .copied()
            .unwrap_or_else(|| env::panic_str("No release of this position is in flight"));
        let payout = self.payout(id);
        require!(
            matches!(payout.kind, PayoutKind::SolRelease { .. }),
            "Not a Solana release"
        );
        require!(
            payout.status == PayoutStatus::Signed,
            "Release is not awaiting confirmation"
        );
        self.request_confirmation(id, &anchor_tx, &nonce_data, &receipt_data)
    }

    /// Confirmation callback of a payout or release; `requested_at` is the block of the
    /// confirmation call. Called by the contract itself.
    #[private]
    pub fn on_sol_confirmed(
        &mut self,
        payout_id: U64,
        expected_hash: String,
        executed: bool,
        requested_at: U64,
    ) -> bool {
        let id = payout_id.0;
        if self.payout(id).status != PayoutStatus::Signed
            || !Self::attestation_matches(&expected_hash)
        {
            return false;
        }
        if executed {
            self.land_payout(id);
        } else if self.not_executed_twice(id, requested_at.0) {
            self.fail_payout(id, "the transaction did not execute");
        }
        executed
    }

    /// A signed action record; a Solana action carries its wire transaction once both
    /// signatures exist.
    pub fn get_payout(&self, payout_id: U64) -> Option<Payout> {
        self.custody.payouts.get(&payout_id.0).map(with_transaction)
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
                    .filter_map(|id| self.custody.payouts.get(id).map(with_transaction))
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

    /// The Solana streams of a class a payout may draw on, with what each can pay now (0 while
    /// it carries an unconfirmed payout or a release is in flight, and from
    /// [`SOL_DRAW_CUTOFF_SECS`] before its end).
    pub fn get_sol_streams(&self, class_id: ClassId) -> Vec<SolStreamState> {
        self.custody
            .class_streams
            .get(&class_id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|position_id| {
                        let stream = self.custody.sol_streams.get(position_id)?;
                        let held = self
                            .positions
                            .get(position_id)
                            .is_some_and(|p| p.state == PositionState::Held);
                        let open = held && stream.drawing.is_none() && drawable(stream);
                        let withdrawable = if open {
                            Self::withdrawable_now(stream)
                        } else {
                            0
                        };
                        let redeem_claimable = match self.positions.get(position_id) {
                            Some(p) if open => self.owed_by_stream(
                                stream,
                                p.allocation.0,
                                self.fraction_now(&class_id),
                            ),
                            _ => 0,
                        };
                        Some(SolStreamState {
                            position_id: U64(*position_id),
                            withdrawable: U128(u128::from(withdrawable)),
                            redeem_claimable: U128(u128::from(redeem_claimable)),
                            stream: stream.clone(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The swept balance of a Solana class: what `sync_sol_stream` booked of Streamflow's
    /// auto-claims and payouts did not take yet, and the part unconfirmed payouts take.
    pub fn get_sol_swept(&self, class_id: ClassId) -> SolSwept {
        self.swept_of(&class_id)
    }
}

/// A Solana stream of a class with what a payout can draw from it now, and the claimable
/// tokens a redeem of its position would take now.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolStreamState {
    pub position_id: U64,
    pub withdrawable: U128,
    pub redeem_claimable: U128,
    pub stream: SolStreamInfo,
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
    pub(super) fn sol_stream(&self, position_id: PositionId) -> SolStreamInfo {
        self.custody
            .sol_streams
            .get(&position_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Not a Solana position"))
    }

    /// What a released stream takes away from the unit holders, and its redeemer therefore
    /// pays from its claimable: what the position's units accrued at the class fraction since
    /// their checkpoint, minus what payouts withdrew from the stream since its registration. The
    /// rest of its unlocked tokens (the class fraction's rounding and margin, which no unit can
    /// claim) leaves with it; when payouts drew more from the stream than its units accrued,
    /// nothing is owed.
    fn owed_by_stream(&self, stream: &SolStreamInfo, units: u128, f_now: u128) -> u64 {
        let accrued = crate::unlock::accrual(units, stream.checkpoint.0, f_now);
        let withdrawn = u128::from(stream.engine_withdrawn.0 - stream.registered_withdrawn.0);
        u64::try_from(accrued.saturating_sub(withdrawn))
            .unwrap_or(u64::MAX)
            .min(Self::withdrawable_now(stream))
    }

    /// Tokens of a registered stream unlocked now that neither a proven withdrawal nor the
    /// stream's unconfirmed payout takes.
    pub(super) fn withdrawable_now(stream: &SolStreamInfo) -> u64 {
        let unlocked = crate::unlock::StreamflowStream::new(stream.params())
            .expect("registered schedule")
            .unlocked_amount(crate::now_secs());
        u64::try_from(unlocked)
            .unwrap_or(u64::MAX)
            .saturating_sub(stream.engine_withdrawn.0)
            .saturating_sub(stream.pending_withdraw.0)
    }

    /// Validates the draws of a payout of `class_id`: distinct streams of the class still held,
    /// none carrying an unconfirmed payout or within [`SOL_DRAW_CUTOFF_SECS`] of its end, each
    /// amount positive, within what the stream can pay now and at least one whole token unless
    /// it takes everything. Returns the streams with their amounts and the total (the packet
    /// size bounds their number).
    fn check_draws(
        &self,
        class_id: &ClassId,
        decimals: u8,
        draws: &[SolDrawArgs],
    ) -> (Vec<(PositionId, SolStreamInfo, u64)>, u64) {
        let one_token = 10u128.checked_pow(u32::from(decimals)).unwrap_or(u128::MAX);
        let mut planned: Vec<(PositionId, SolStreamInfo, u64)> = Vec::with_capacity(draws.len());
        let mut total: u64 = 0;
        for draw in draws {
            let position_id = draw.position_id.0;
            require!(
                draws
                    .iter()
                    .filter(|other| other.position_id == draw.position_id)
                    .count()
                    == 1,
                "A stream is named twice"
            );
            let position = self
                .positions
                .get(&position_id)
                .unwrap_or_else(|| env::panic_str(&format!("Unknown position {position_id}")));
            require!(
                &position.class_id == class_id,
                format!("Position {position_id} is not a stream of the claimed class")
            );
            require!(
                position.state == PositionState::Held,
                format!("Position {position_id} is not held by the vault")
            );
            let stream = self.sol_stream(position_id);
            require!(
                stream.drawing.is_none(),
                format!("Stream {position_id} carries an unconfirmed payout: confirm it first (confirm_sol_payout)")
            );
            require!(
                drawable(&stream),
                format!("Stream {position_id} ends within five minutes or has ended: Streamflow's auto-claim empties it into the vault, claim from the class's swept balance once sync_sol_stream booked it")
            );
            let available = Self::withdrawable_now(&stream);
            let amount = u64::try_from(draw.amount.0).unwrap_or(u64::MAX);
            require!(
                amount > 0 && amount <= available,
                format!("Stream {position_id} can pay between 1 and {available} now")
            );
            require!(
                u128::from(amount) >= one_token
                    || stream.engine_withdrawn.0 + amount == stream.net_amount_deposited.0,
                format!("A draw takes at least one whole token ({one_token}) unless it empties stream {position_id}")
            );
            total = total
                .checked_add(amount)
                .unwrap_or_else(|| env::panic_str("Amount exceeds the SPL token range"));
            planned.push((position_id, stream, amount));
        }
        (planned, total)
    }

    /// Validates the caller's account bytes of a payout or redeem: the durable nonce and receipt
    /// nonce accounts (two distinct accounts, System-owned, `Current`, initialized, authority =
    /// vault, created with seeds bound to `caller`, neither reserved by an unsettled action) and
    /// the recipient's associated token account for `mint` (initialized, owned by `owner`).
    fn payout_accounts(
        &self,
        proof: &SolNonceProof,
        caller: &AccountId,
        vault: &Pubkey,
        mint: &Pubkey,
        owner: &Pubkey,
    ) -> PayoutAccounts {
        let nonce = sol::parse_pubkey(&proof.account)
            .unwrap_or_else(|_| env::panic_str("Nonce account must be a base58 key"));
        let base = sol::parse_pubkey(&proof.base)
            .unwrap_or_else(|_| env::panic_str("Nonce base must be a base58 key"));
        let prefix = nonce_seed_prefix(caller);
        for seed in [&proof.seed, &proof.receipt_seed] {
            require!(
                seed.starts_with(&prefix) && seed.len() <= MAX_SEED_LEN,
                format!(
                    "Every nonce account's seed must start with {prefix} (the caller's prefix) and be at most {MAX_SEED_LEN} characters"
                )
            );
        }
        require!(
            create_with_seed(&base, &proof.seed, &SYSTEM_PROGRAM) == Ok(nonce),
            "The nonce account must be created with the seed from the base key (createNonceAccount with basePubkey and seed)"
        );
        let receipt = create_with_seed(&base, &proof.receipt_seed, &SYSTEM_PROGRAM)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid receipt seed: {e:?}")));
        require!(
            receipt != nonce,
            "The receipt nonce account must be another account than the nonce account"
        );
        for account in [&nonce, &receipt] {
            if let Some(holder) = self.custody.nonce_holds.get(&sol::format_pubkey(account)) {
                env::panic_str(&format!(
                    "Nonce account {} is reserved by action {holder} until it is confirmed",
                    sol::format_pubkey(account)
                ));
            }
        }
        let nonce_account = SvmAccount {
            owner: Bytes32(SYSTEM_PROGRAM),
            data: parse_hex(&proof.data, "nonce data"),
        };
        let state = NonceAccount::from_account_state(&nonce_account, vault)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid nonce account: {e:?}")));
        let receipt_account = SvmAccount {
            owner: Bytes32(SYSTEM_PROGRAM),
            data: parse_hex(&proof.receipt_data, "receipt data"),
        };
        NonceAccount::from_account_state(&receipt_account, vault)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid receipt nonce account: {e:?}")));
        let recipient_tokens = associated_token_address(owner, mint).expect("valid seeds");
        let recipient_account = SvmAccount {
            owner: Bytes32(TOKEN_PROGRAM),
            data: parse_hex(&proof.recipient_tokens_data, "recipient_tokens_data"),
        };
        TokenAccount::from_account_state(&recipient_account, mint, owner).unwrap_or_else(|e| {
            env::panic_str(&format!(
                "The recipient's token account must exist and be usable: {e:?}"
            ))
        });
        PayoutAccounts {
            anchor: parse_anchor(&proof.anchor_tx),
            nonce,
            nonce_account,
            nonce_value: state.nonce,
            receipt,
            receipt_account,
            recipient_tokens,
            recipient_account,
        }
    }

    /// Reserves the nonce and receipt accounts of durable-nonce action `id` until it is settled.
    fn hold_nonce_accounts(&mut self, id: PayoutId, accounts: &PayoutAccounts) {
        for account in [&accounts.nonce, &accounts.receipt] {
            self.custody
                .nonce_holds
                .insert(sol::format_pubkey(account), id);
        }
    }

    /// Frees the nonce accounts action `id` reserved.
    fn release_nonce_holds(&mut self, id: PayoutId) {
        let Some(solana) = self.payout(id).solana.clone() else {
            return;
        };
        for account in [solana.nonce_account, solana.receipt_account]
            .into_iter()
            .flatten()
        {
            if self.custody.nonce_holds.get(&account) == Some(&id) {
                self.custody.nonce_holds.remove(&account);
            }
        }
    }

    /// The swept balance of `class_id`.
    pub(super) fn swept_of(&self, class_id: &ClassId) -> SolSwept {
        self.custody
            .swept
            .get(class_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Marks the nonce value pending and requests the attestation of the nonce and receipt
    /// accounts and the recipient's token account; the callback requests the signatures.
    fn prove_then_sign(&mut self, id: PayoutId, accounts: &PayoutAccounts) -> Promise {
        let key = ReplayKey::SolNonce {
            account: sol::format_pubkey(&accounts.nonce),
            value: sol::format_pubkey(&accounts.nonce_value),
        };
        self.mark_pending(&key);
        let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
            tx_id: Bytes64(accounts.anchor),
            finality: SvmFinality::Finalized,
            extractors: vec![
                SvmExtractor::AccountState {
                    pubkey: Bytes32(accounts.nonce),
                },
                SvmExtractor::AccountState {
                    pubkey: Bytes32(accounts.receipt),
                },
                SvmExtractor::AccountState {
                    pubkey: Bytes32(accounts.recipient_tokens),
                },
            ],
        });
        let hash = payload_hash(
            request.clone(),
            vec![
                ExtractedValue::account(accounts.nonce_account.clone()),
                ExtractedValue::account(accounts.receipt_account.clone()),
                ExtractedValue::account(accounts.recipient_account.clone()),
            ],
        );
        require_gas_left(TGAS_PROVE_THEN_SIGN);
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_NONCE_CALLBACK)
                .on_sol_nonce_verified(U64(id), hex::encode(hash), key),
        )
    }

    /// The nonce account of a signed durable-nonce action, proven to have advanced past the
    /// value the action was signed with (panics otherwise: the transaction can still execute),
    /// with its new value.
    fn advanced_nonce(
        &self,
        solana: &SolTransaction,
        nonce_data: &str,
    ) -> (Pubkey, SvmAccount, [u8; 32]) {
        let (vault, _) = self.sol_keys();
        let nonce = sol::parse_pubkey(solana.nonce_account.as_deref().expect("durable nonce"))
            .expect("stored base58");
        let signed = sol::parse_pubkey(solana.nonce_value.as_deref().expect("durable nonce"))
            .expect("stored base58");
        let account = SvmAccount {
            owner: Bytes32(SYSTEM_PROGRAM),
            data: parse_hex(nonce_data, "nonce_data"),
        };
        let state = NonceAccount::from_account_state(&account, &vault)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid nonce account: {e:?}")));
        require!(
            state.nonce != signed,
            "The nonce has not advanced: broadcast the stored transaction first (anyone can)"
        );
        (nonce, account, state.nonce)
    }

    /// Requests the confirmation proof of signed durable-nonce action `id`: its nonce account
    /// (advanced) and its receipt nonce account, which holds the nonce's new value exactly when
    /// the action's transaction executed.
    fn request_confirmation(
        &mut self,
        id: PayoutId,
        anchor_tx: &str,
        nonce_data: &str,
        receipt_data: &str,
    ) -> Promise {
        let solana = self.payout(id).solana.clone().expect("Solana action");
        let (nonce, nonce_account, advanced) = self.advanced_nonce(&solana, nonce_data);
        let (vault, _) = self.sol_keys();
        let receipt = sol::parse_pubkey(solana.receipt_account.as_deref().expect("receipt"))
            .expect("stored base58");
        let receipt_account = SvmAccount {
            owner: Bytes32(SYSTEM_PROGRAM),
            data: parse_hex(receipt_data, "receipt_data"),
        };
        let receipt_state = NonceAccount::from_account_state(&receipt_account, &vault)
            .unwrap_or_else(|e| env::panic_str(&format!("Invalid receipt nonce account: {e:?}")));
        let executed = receipt_state.nonce == advanced;
        let (request, hash) = account_state_request(
            anchor_tx,
            vec![nonce, receipt],
            vec![nonce_account, receipt_account],
        );
        Self::require_mpc_reserve();
        require_gas_left(TGAS_PROOF);
        self.verify_foreign_promise(request).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                .on_sol_confirmed(
                    U64(id),
                    hex::encode(hash),
                    executed,
                    U64(env::block_height()),
                ),
        )
    }

    /// Compiles a Solana message with `gas/sol` paying the fee, refusing one whose transaction
    /// would not fit the packet.
    pub(super) fn compile_sol_message(
        &self,
        instructions: &[Instruction],
        blockhash: [u8; 32],
    ) -> Vec<u8> {
        let (_, gas) = self.sol_keys();
        let message = sol::LegacyMessage::compile(&gas, instructions, blockhash)
            .unwrap_or_else(|e| env::panic_str(&format!("Cannot compile the message: {e:?}")))
            .serialize();
        require!(
            message.len() + 1 + 2 * 64 <= sol::MAX_TRANSACTION_LEN,
            "Transaction would exceed the Solana packet size: draw on fewer streams"
        );
        message
    }

    /// Stores the compiled message of a Solana action; `nonce_accounts` are the durable nonce
    /// and receipt accounts of a durable-nonce action.
    pub(super) fn store_sol_message(
        &mut self,
        id: PayoutId,
        message: Vec<u8>,
        blockhash: [u8; 32],
        nonce_accounts: Option<(Pubkey, Pubkey)>,
        authority_path: &str,
        authority: &Pubkey,
    ) {
        self.payout_mut(id).solana = Some(SolTransaction {
            message: Base64VecU8(message),
            draws: Vec::new(),
            swept: U64(0),
            nonce_account: nonce_accounts.map(|(nonce, _)| sol::format_pubkey(&nonce)),
            nonce_value: nonce_accounts.map(|_| sol::format_pubkey(&blockhash)),
            receipt_account: nonce_accounts.map(|(_, receipt)| sol::format_pubkey(&receipt)),
            authority_path: authority_path.to_string(),
            authority: sol::format_pubkey(authority),
            authority_signature: None,
            gas_signature: None,
            cancel: false,
            not_executed_seen_at: None,
            transaction: None,
        });
    }

    /// The Solana record of a payout.
    fn sol_transaction_mut(&mut self, id: PayoutId) -> &mut SolTransaction {
        self.payout_mut(id)
            .solana
            .as_mut()
            .unwrap_or_else(|| env::panic_str("Not a Solana action"))
    }

    /// The stored message bytes of a Solana action.
    fn sol_message_bytes(&self, id: PayoutId) -> Vec<u8> {
        self.payout(id)
            .solana
            .as_ref()
            .unwrap_or_else(|| env::panic_str("Not a Solana action"))
            .message
            .0
            .clone()
    }

    /// Requests the joined signatures of `authority_path` and `gas/sol` over `message`.
    pub(super) fn sign_sol_pair(
        &mut self,
        id: PayoutId,
        authority_path: &str,
        message: Vec<u8>,
    ) -> Promise {
        let payout = self.payout_mut(id);
        payout.sign_requests += 1;
        payout.requested_block = U64(env::block_height());
        self.sign_eddsa_promise(authority_path, message.clone())
            .and(self.sign_eddsa_promise(PATH_GAS_SOL, message))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RECORD_CALLBACK)
                    .on_sol_signed(U64(id)),
            )
    }

    /// Stores a signature of the authority (or of `gas/sol` when `is_gas`) when it verifies
    /// against that key over the stored message. Returns whether it was stored.
    fn accept_sol_signature(&mut self, id: PayoutId, is_gas: bool, signature: &[u8; 64]) -> bool {
        let key = if is_gas {
            self.sol_keys().1
        } else {
            let authority = &self
                .payout(id)
                .solana
                .as_ref()
                .expect("Solana action")
                .authority;
            sol::parse_pubkey(authority).expect("stored base58")
        };
        let solana = self.sol_transaction_mut(id);
        if !env::ed25519_verify(signature, &solana.message.0, &key) {
            return false;
        }
        let stored = Some(Base64VecU8(signature.to_vec()));
        if is_gas {
            solana.gas_signature = stored;
        } else {
            solana.authority_signature = stored;
        }
        true
    }

    /// Replaces the message of a durable-nonce action whose authority signature failed by one
    /// that only advances the nonce (same account and value, so at most one of the two can ever
    /// execute, and it leaves the receipt where it was) and opens its signature request at once
    /// (`retry_sol_payout`); the confirmation then settles the action whichever executed.
    fn cancel_sol_payout(&mut self, id: PayoutId) {
        let solana = self.payout(id).solana.clone().expect("Solana action");
        if !solana.cancel {
            let (vault, _) = self.sol_keys();
            let nonce = sol::parse_pubkey(solana.nonce_account.as_deref().expect("durable nonce"))
                .expect("stored base58");
            let value = sol::parse_pubkey(solana.nonce_value.as_deref().expect("durable nonce"))
                .expect("stored base58");
            let message = self.compile_sol_message(&[advance_nonce_account(nonce, vault)], value);
            let record = self.sol_transaction_mut(id);
            record.message = Base64VecU8(message);
            record.authority_signature = None;
            record.gas_signature = None;
            record.cancel = true;
            self.emit(RoseEvent::PayoutCancelling { payout_id: U64(id) });
        }
        self.mark_request_resolved(id);
    }

    /// Records a proof that payout `id` did not execute, requested at block `requested_at`;
    /// true when an earlier such proof was answered at least
    /// [`super::CONFIRM_FAILURE_DELAY_BLOCKS`] before this one was requested, so the two proofs
    /// read the chain that far apart (the first one's reads happened before its answer, this
    /// one's after its request), and the verdict may be acted on. The first proof is recorded at
    /// the block it was answered.
    fn not_executed_twice(&mut self, id: PayoutId, requested_at: u64) -> bool {
        let now = env::block_height();
        let solana = self.sol_transaction_mut(id);
        match solana.not_executed_seen_at {
            Some(seen) => requested_at >= seen.0 + super::CONFIRM_FAILURE_DELAY_BLOCKS,
            None => {
                solana.not_executed_seen_at = Some(U64(now));
                false
            }
        }
    }

    /// Panics when `owner` is one of the engine's own Solana keys: tokens or a stream sent there
    /// would sit outside every record.
    fn require_outside_recipient(&self, owner: &Pubkey) {
        let (vault, gas) = self.sol_keys();
        require!(
            *owner != vault && *owner != gas,
            "The recipient must not be the engine's vault or fee payer"
        );
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
        self.positions
            .get_mut(&position_id)
            .expect("position exists")
            .state = PositionState::Releasing;
        self.emit(RoseEvent::PositionReleaseRequested {
            position_id: U64(position_id),
            payout_id: U64(payout_id),
            account: account.clone(),
        });
    }

    /// Marks a payout signed. A Base authorization is final (a redeem releases its position);
    /// a durable-nonce Solana action waits for its confirmation; a Solana action with a recent
    /// blockhash (a move or a return) is final.
    pub(super) fn complete_payout(&mut self, id: PayoutId) {
        let payout = self.payout_mut(id);
        payout.status = PayoutStatus::Signed;
        payout.updated_at = U64(env::block_timestamp());
        let payout = payout.clone();
        let awaits_confirmation = payout
            .solana
            .as_ref()
            .is_some_and(|solana| solana.nonce_account.is_some());
        if !awaits_confirmation {
            self.release_hold(&payout.requester);
            if let (PayoutDebit::Units { .. }, Some(position_id)) =
                (&payout.debit, payout.position_id)
            {
                self.finish_release(position_id.0, &payout.requester);
            }
        }
        self.emit(RoseEvent::PayoutSigned { payout_id: U64(id) });
    }

    /// Marks a Solana action proven executed: the drawn streams count their withdrawals, the
    /// swept balance pays what the payout took from it, a released position is final, and the
    /// nonce accounts are free again.
    fn land_payout(&mut self, id: PayoutId) {
        let payout = self.payout(id).clone();
        let solana = payout.solana.as_ref().expect("Solana action");
        if solana.swept.0 > 0 {
            let class_id = self.claim_class(&ClaimSource::from(match &payout.debit {
                PayoutDebit::Claimable { source, .. } => source,
                _ => env::panic_str("Internal custody error: a swept draw without a claim"),
            }));
            let balance = self.custody.swept.get_mut(&class_id).expect("booked");
            balance.balance = U64(balance.balance.0 - solana.swept.0);
            balance.pending = U64(balance.pending.0 - solana.swept.0);
        }
        self.release_nonce_holds(id);
        for draw in &solana.draws {
            let position_id = draw.position_id.0;
            let class_id = self
                .positions
                .get(&position_id)
                .expect("drawn")
                .class_id
                .clone();
            let stream = self
                .custody
                .sol_streams
                .get_mut(&position_id)
                .expect("drawn stream");
            stream.engine_withdrawn =
                U64(u64::try_from(draw.expected_withdrawn.0).expect("within the stream"));
            stream.drawing = None;
            stream.pending_withdraw = U64(0);
            if stream.engine_withdrawn.0 >= stream.net_amount_deposited.0 {
                self.prune_stream(&class_id, position_id);
            }
        }
        if let (PayoutDebit::Units { .. }, Some(position_id)) = (&payout.debit, payout.position_id)
        {
            self.finish_release(position_id.0, &payout.requester);
        }
        let record = self.payout_mut(id);
        record.status = PayoutStatus::Landed;
        record.updated_at = U64(env::block_timestamp());
        self.release_hold(&payout.requester);
        self.emit(RoseEvent::PayoutLanded { payout_id: U64(id) });
    }

    /// Makes a release final: the position is `Released` and no payout draws on it again.
    fn finish_release(&mut self, position_id: PositionId, account: &AccountId) {
        self.custody.releasing.remove(&position_id);
        self.mark_position_released(position_id, account);
        let class_id = self
            .positions
            .get(&position_id)
            .expect("position exists")
            .class_id
            .clone();
        self.prune_stream(&class_id, position_id);
    }

    /// Drops a stream from the ones payouts of its class may draw on.
    pub(super) fn prune_stream(&mut self, class_id: &ClassId, position_id: PositionId) {
        if let Some(streams) = self.custody.class_streams.get_mut(class_id) {
            streams.retain(|id| *id != position_id);
            if streams.is_empty() {
                self.custody.class_streams.remove(class_id);
            }
        }
    }

    /// Marks a payout failed and refunds its debit through the owed-credit paths: claimable
    /// tokens, cash, or a redeem's units (accruing from the burn) and paid claimable tokens with
    /// the position held again. The streams, the swept balance and the nonce accounts it held
    /// are free again.
    pub(super) fn fail_payout(&mut self, id: PayoutId, reason: &str) {
        let payout = self.payout(id).clone();
        if let (Some(solana), PayoutDebit::Claimable { source, .. }) =
            (&payout.solana, &payout.debit)
        {
            if solana.swept.0 > 0 {
                let class_id = self.claim_class(&ClaimSource::from(source));
                let balance = self.custody.swept.get_mut(&class_id).expect("booked");
                balance.pending = U64(balance.pending.0 - solana.swept.0);
            }
        }
        self.release_nonce_holds(id);
        for draw in payout.solana.iter().flat_map(|solana| &solana.draws) {
            if let Some(stream) = self.custody.sol_streams.get_mut(&draw.position_id.0) {
                if stream.drawing == Some(U64(id)) {
                    stream.drawing = None;
                    stream.pending_withdraw = U64(0);
                }
            }
        }
        match &payout.debit {
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
                f_burned,
                claimable,
            } => {
                self.custody.releasing.remove(&position_id.0);
                self.positions
                    .get_mut(&position_id.0)
                    .expect("position exists")
                    .state = PositionState::Held;
                self.mint_units_owed(class_id, account, units.0, f_burned.0);
                self.add_claimable(&Holder::Account(account.clone()), class_id, claimable.0);
            }
        }
        let record = self.payout_mut(id);
        record.status = PayoutStatus::Failed {
            reason: reason.to_string(),
        };
        record.updated_at = U64(env::block_timestamp());
        self.release_hold(&payout.requester);
        self.emit(RoseEvent::PayoutFailed {
            payout_id: U64(id),
            reason: reason.to_string(),
        });
    }

    /// Whether a refused deposit may request a return now: none yet or the last one failed; for
    /// a Solana stream also while the last one is signed (its recent blockhash may have expired,
    /// and only one `transfer_recipient` of the stream can execute: a stream refused at the
    /// vault is never registered again, and a stale return from a deposit address can no longer
    /// move a stream that reached the vault).
    pub(super) fn return_allowed(&self, refused: &super::types::RefusedDeposit) -> bool {
        refused.return_payout.is_none_or(|id| {
            match self.custody.payouts.get(&id.0).map(|p| &p.status) {
                Some(PayoutStatus::Failed { .. }) => true,
                Some(PayoutStatus::Signed) => refused.chain == Chain::Solana,
                _ => false,
            }
        })
    }
}

#[near]
impl Contract {
    /// Sends a refused deposit back: on Base, signs `Release(lockup, streamId, to = sender, id)`;
    /// on Solana, signs `transfer_recipient` from where the stream sits (the vault or the
    /// deposit address) to the return address named at attribution, with the caller-supplied
    /// recent blockhash. Anyone; attach the payout storage deposit and about 60 Tgas (Base) or
    /// 120 Tgas (Solana). On Base callable again only when the previous return failed; on Solana
    /// also once the previous one is signed (its blockhash may have expired).
    #[payable]
    pub fn return_refused_deposit(
        &mut self,
        key: ReplayKey,
        recent_blockhash: Option<String>,
    ) -> Promise {
        Self::assert_payout_deposit();
        let key = key.canonical();
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
                self.return_base_stream(&key, lockup, *stream_id, &refused.return_to)
            }
            RefusedAsset::SolStream {
                metadata,
                held_by,
                held_by_path,
            } => {
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

/// A Streamflow `withdraw` by the vault from a registered stream, with the accounts the attested
/// metadata names.
fn withdraw_accounts(
    stream: &SolStreamInfo,
    vault: Pubkey,
    vault_tokens: Pubkey,
) -> StreamflowWithdrawAccounts {
    let key = |text: &str| sol::parse_pubkey(text).expect("stored base58");
    StreamflowWithdrawAccounts {
        authority: vault,
        recipient: vault,
        recipient_tokens: vault_tokens,
        metadata: key(&stream.metadata),
        escrow_tokens: key(&stream.escrow_tokens),
        streamflow_treasury: sol::STREAMFLOW_TREASURY,
        streamflow_treasury_tokens: key(&stream.streamflow_treasury_tokens),
        partner: key(&stream.partner),
        partner_tokens: key(&stream.partner_tokens),
        mint: key(&stream.mint),
    }
}

/// One `AccountState` request at `Finalized` over `pubkeys` anchored on `anchor_tx`, with the
/// payload hash of `accounts`.
fn account_state_request(
    anchor_tx: &str,
    pubkeys: Vec<Pubkey>,
    accounts: Vec<SvmAccount>,
) -> (ForeignChainRpcRequest, [u8; 32]) {
    require!(
        pubkeys.len() <= MAX_EXTRACTORS,
        "Too many accounts for one proof"
    );
    let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
        tx_id: Bytes64(parse_anchor(anchor_tx)),
        finality: SvmFinality::Finalized,
        extractors: pubkeys
            .into_iter()
            .map(|pubkey| SvmExtractor::AccountState {
                pubkey: Bytes32(pubkey),
            })
            .collect(),
    });
    let hash = payload_hash(
        request.clone(),
        accounts.into_iter().map(ExtractedValue::account).collect(),
    );
    (request, hash)
}

/// A payout record as the views return it: with the assembled wire transaction of a Solana
/// action whose two signatures exist.
fn with_transaction(payout: &Payout) -> Payout {
    let mut payout = payout.clone();
    if let Some(solana) = payout.solana.as_mut() {
        if let (Some(authority), Some(gas)) = (&solana.authority_signature, &solana.gas_signature) {
            let signatures: Vec<[u8; 64]> = [&gas.0, &authority.0]
                .into_iter()
                .filter_map(|bytes| bytes.as_slice().try_into().ok())
                .collect();
            solana.transaction = sol::assemble_transaction(&solana.message.0, &signatures)
                .ok()
                .map(Base64VecU8);
        }
    }
    payout
}

impl Contract {
    /// An EVM recipient in any spelling, required to equal `restricted_to` when a source
    /// restricts it. The zero address, RoseVault and the engine's `vault/base` address are
    /// refused: tokens or a stream sent there would sit in custody outside every record.
    fn evm_recipient(&self, to: &str, restricted_to: Option<&str>) -> evm::Address {
        let address = evm::parse_address(to)
            .unwrap_or_else(|| env::panic_str("to must be a 20-byte hex address"));
        require!(address != [0u8; 20], "to must not be the zero address");
        require!(
            !self.is_engine_address(Chain::Base, &evm::format_address(&address)),
            "to must not be RoseVault or the engine's vault/base address: what is sent there sits outside every record"
        );
        if let Some(restricted) = restricted_to {
            require!(
                evm::parse_address(restricted) == Some(address),
                "This source pays only to its retire_to address"
            );
        }
        address
    }
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

/// The 24 hex characters of `sha256(account id)` that start the seed of every nonce account
/// `account` may use (see [`SolNonceProof`]).
pub(crate) fn nonce_seed_prefix(account: &AccountId) -> String {
    hex::encode(sol::sha256(account.as_bytes()))[..NONCE_SEED_PREFIX_LEN].to_string()
}

/// Whether `stream` still takes draws and redeems: more than [`SOL_DRAW_CUTOFF_SECS`] before
/// its end.
pub(super) fn drawable(stream: &SolStreamInfo) -> bool {
    crate::now_secs().saturating_add(SOL_DRAW_CUTOFF_SECS) < stream.end_time
}
