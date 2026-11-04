//! Storage records and JSON argument types of the foreign custody wiring.
//!
//! Foreign identifiers are strings in the form their chain renders them: lowercase `0x` hex for
//! Base addresses and hashes, base58 for Solana public keys. Foreign timestamps, block numbers,
//! indexes and stream ids are plain JSON numbers (they are far below `2^53`); token amounts are
//! JSON strings (`U128`, or `U64` for Solana's `u64` amounts), as everywhere else in the engine:
//! a Solana allocation easily exceeds `2^53` base units.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::{near, AccountId};

use crate::types::{Chain, ClaimSource, ClassId, LienId, Venue};
use crate::unlock::{SablierLinearParams, StreamflowParams};

/// Sequential id of a signed foreign action; for Base authorizations it is also the EIP-712 `id`
/// RoseVault's replay bitmap consumes (one counter shared by `Transfer` and `Release`).
pub type PayoutId = u64;

/// Identity of a foreign fact the engine acts on at most once.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReplayKey {
    /// A RoseVault log: transaction hash (lowercase hex, no `0x`) and block-level log index.
    BaseLog { tx_hash: String, log_index: u64 },
    /// A Streamflow stream metadata account (base58): registered at most once.
    SolStream { metadata: String },
    /// A durable nonce value (account and value, base58): signed over at most once.
    SolNonce { account: String, value: String },
}

impl ReplayKey {
    /// The key as the engine stores it: a Base transaction hash written with or without `0x`,
    /// in any case, becomes lowercase hex without `0x`, so every spelling finds the same record.
    pub fn canonical(self) -> Self {
        match self {
            Self::BaseLog { tx_hash, log_index } => Self::BaseLog {
                tx_hash: crate::foreign::mpc::parse_hex_array::<32>(&tx_hash)
                    .map_or(tx_hash, hex::encode),
                log_index,
            },
            other => other,
        }
    }
}

/// State of a replay key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplayState {
    /// A request is in flight since this block height.
    Pending { since_block: u64 },
    /// The fact was acted on.
    Consumed,
}

/// Where a RoseVault log sits on Base: the receipt fields the MPC nodes include in the attested
/// log besides the event itself. `log_index` is the receipt's block-level `logIndex`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BaseLogLocation {
    pub tx_hash: String,
    pub block_hash: String,
    pub block_number: u64,
    pub transaction_index: u64,
    pub log_index: u64,
}

/// Decoded fields of a `StreamDeposited` log, as the app reads them from the receipt.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct StreamDepositedFields {
    pub sender: String,
    pub stream_id: u64,
    pub near_account: String,
    pub lockup: String,
    pub token: String,
    pub decimals: u8,
    pub deposited: U128,
    pub withdrawn: U128,
    pub start: u64,
    pub cliff: u64,
    pub end: u64,
    pub granularity: u64,
    pub start_unlock: U128,
    pub cliff_unlock: U128,
    pub cancelable: bool,
    pub transferable: bool,
    pub timestamp: u64,
}

/// Decoded fields of a `CashDeposited` log.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CashDepositedFields {
    pub sender: String,
    pub token: String,
    pub round_id: u64,
    pub near_account: String,
    pub amount: U128,
    pub timestamp: u64,
}

/// Arguments of `attribute_sol_deposit`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SolDepositArgs {
    /// Streamflow metadata account (base58).
    pub metadata: String,
    /// Class the deposit address was derived for: `dep/<account>/<class_id>`.
    pub class_id: ClassId,
    /// Solana address (base58) the stream goes back to if the engine refuses it.
    pub return_to: String,
    /// Anchor transaction of the proof.
    pub anchor_tx: String,
    /// Metadata account bytes (hex).
    pub metadata_data: String,
    /// Mint account bytes (hex, 82 bytes of a classic SPL Token mint).
    pub mint_data: String,
}

/// The accounts a Solana payout or redeem is built on, proven together with one ForeignTx
/// `AccountState` request at `Finalized` before anything is signed: the durable nonce account
/// (owner System, authority = vault) and the recipient's associated token account for the mint
/// (owner SPL Token, initialized, owned by the recipient), which must already exist so that the
/// engine's fee payer never pays rent for it.
///
/// The nonce account belongs to the calling NEAR account through its address: it must be
/// `create_with_seed(base, seed, System program)` with a `seed` starting with the caller's
/// prefix (`nonce_seed_prefix`), so nobody else can spend its nonce values.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SolNonceProof {
    /// Nonce account (base58).
    pub account: String,
    /// The key the nonce account was created from with a seed (base58; it signed the creation).
    pub base: String,
    /// The seed: the caller's 24-character prefix, then at most 8 characters of the caller's
    /// choice (so one wallet can hold several nonce accounts for one NEAR account).
    pub seed: String,
    /// Anchor transaction (base58 signature): any successful finalized transaction not newer
    /// than the account reads.
    pub anchor_tx: String,
    /// The 80 nonce account bytes (hex), read at `finalized`.
    pub data: String,
    /// The 165 bytes of the recipient's associated token account (hex), read at `finalized`.
    pub recipient_tokens_data: String,
}

/// One Streamflow withdrawal a Solana payout makes from a stream of its class, chosen by the
/// claimant.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SolDrawArgs {
    pub position_id: U64,
    pub amount: U128,
}

/// Source of claimable tokens, as a JSON argument.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimSourceArgs {
    /// The caller's holding of a class.
    Holding { class_id: ClassId },
    /// The retired lot of a Tender, payable only to its `retire_to` address; anyone may call.
    Retired { round_id: U64 },
    /// The caller's share of a lien.
    LienShare { lien_id: U64 },
}

impl ClaimSourceArgs {
    /// The ledger source for `caller`.
    pub fn resolve(&self, caller: &AccountId) -> ClaimSource {
        match self {
            Self::Holding { class_id } => ClaimSource::Holding {
                account: caller.clone(),
                class_id: class_id.clone(),
            },
            Self::Retired { round_id } => ClaimSource::Retired {
                round_id: round_id.0,
            },
            Self::LienShare { lien_id } => ClaimSource::LienShare {
                lien_id: lien_id.0,
                funder: caller.clone(),
            },
        }
    }
}

/// A ledger source with its account, stored in payout records.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoredClaimSource {
    Holding {
        account: AccountId,
        class_id: ClassId,
    },
    Retired {
        round_id: U64,
    },
    LienShare {
        lien_id: U64,
        funder: AccountId,
    },
}

impl From<&ClaimSource> for StoredClaimSource {
    fn from(source: &ClaimSource) -> Self {
        match source {
            ClaimSource::Holding { account, class_id } => Self::Holding {
                account: account.clone(),
                class_id: class_id.clone(),
            },
            ClaimSource::Retired { round_id } => Self::Retired {
                round_id: U64(*round_id),
            },
            ClaimSource::LienShare { lien_id, funder } => Self::LienShare {
                lien_id: U64(*lien_id),
                funder: funder.clone(),
            },
        }
    }
}

impl From<&StoredClaimSource> for ClaimSource {
    fn from(source: &StoredClaimSource) -> Self {
        match source {
            StoredClaimSource::Holding { account, class_id } => Self::Holding {
                account: account.clone(),
                class_id: class_id.clone(),
            },
            StoredClaimSource::Retired { round_id } => Self::Retired {
                round_id: round_id.0,
            },
            StoredClaimSource::LienShare { lien_id, funder } => Self::LienShare {
                lien_id: lien_id.0 as LienId,
                funder: funder.clone(),
            },
        }
    }
}

/// What a signed foreign action does.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutKind {
    /// RoseVault `Transfer(token, to, amount, id)`.
    BaseTransfer {
        token: String,
        to: String,
        amount: U128,
    },
    /// RoseVault `Release(lockup, streamId, to, vestedToRecipient, id)`: the vested balance goes
    /// to the vault for a redeem (`false`) and to `to` for the return of a refused stream
    /// (`true`).
    BaseRelease {
        lockup: String,
        stream_id: u64,
        to: String,
        vested_to_recipient: bool,
    },
    /// Streamflow withdrawals from the drawn streams into the vault's token account, then SPL
    /// `TransferChecked` of their sum, `amount`, of `mint` to `to_owner`'s associated token
    /// account.
    SolTransfer {
        mint: String,
        to_owner: String,
        amount: U128,
    },
    /// Streamflow `transfer_recipient` of a stream held by the vault to `to_owner`.
    SolRelease { metadata: String, to_owner: String },
    /// Streamflow `transfer_recipient` of an attributed stream from its deposit address to the
    /// vault (spec 7.2 step 2).
    SolMove {
        metadata: String,
        from: String,
        to_owner: String,
    },
    /// Streamflow `transfer_recipient` of a refused stream from where it sits to its return
    /// address.
    SolReturn {
        metadata: String,
        from: String,
        to_owner: String,
    },
}

/// What the engine debited before requesting the signature. Refunded only when its proof failed
/// (nothing was signed) or a signed Solana transaction was proven not to have executed; never
/// because a signature request failed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutDebit {
    /// Nothing (custody maintenance and refused-deposit returns).
    None,
    /// Unlocked tokens taken from a claim source.
    Claimable {
        source: StoredClaimSource,
        amount: U128,
    },
    /// Cash taken from a venue balance.
    Cash {
        account: AccountId,
        venue: Venue,
        amount: U128,
    },
    /// Units burned for an in-kind redeem, and for a Solana stream the claimable tokens the
    /// redeemer paid for the unlocked tokens the stream still holds. Both come back (the units
    /// accruing from `f_burned`) when the release does not land.
    Units {
        position_id: U64,
        class_id: ClassId,
        account: AccountId,
        units: U128,
        f_burned: U128,
        claimable: U128,
    },
}

/// Lifecycle of a signed foreign action.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutStatus {
    /// Waiting for a proof or a signature.
    Requested,
    /// The authorization or transaction is stored; anyone can submit it. A Solana payout or
    /// redeem stays here until `confirm_sol_payout` / `confirm_sol_redeem` proves its durable
    /// nonce advanced, then becomes `Landed` or `Failed`.
    Signed,
    /// The vault signature exists but the fee payer's does not: `resign_sol_gas` (or
    /// `submit_sol_signature`) completes it.
    AwaitingGasSignature,
    /// Nothing was signed, or the signed Solana transaction was proven not to have executed;
    /// the debit was refunded.
    Failed { reason: String },
    /// A Solana payout or redeem proven executed on chain.
    Landed,
}

/// A signature of `vault/base` over the payout's EIP-712 digest, as `executeTransfer` and
/// `executeRelease` take it (hex `r` and `s`, `v` in `{27, 28}`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseSignature {
    pub r: String,
    pub s: String,
    pub v: u8,
}

/// A Streamflow `withdraw` inside a payout transaction. While the payout is unconfirmed the
/// amount is the stream's `pending_withdraw`; `expected_withdrawn` is the stream's attested
/// `amount_withdrawn` once the transaction executed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolDraw {
    pub position_id: U64,
    pub amount: U128,
    pub expected_withdrawn: U128,
}

/// A Solana legacy transaction the engine built, with its signatures as they arrive. Bytes are
/// stored raw and rendered as base64 in JSON.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolTransaction {
    /// The compiled message every signer signs.
    pub message: Base64VecU8,
    /// Streamflow withdrawals inside the message (payouts only), feeding the vault's token
    /// account with exactly what the message pays out of it.
    pub draws: Vec<SolDraw>,
    /// Nonce account and the value the message uses as its blockhash, for durable-nonce
    /// transactions (`None` with a recent blockhash).
    pub nonce_account: Option<String>,
    pub nonce_value: Option<String>,
    /// Derivation path of the authority that signs besides `gas/sol` (`vault/sol` or a deposit
    /// address path). The fee payer is always the first signature of the wire transaction.
    pub authority_path: String,
    /// Address (base58) of that authority, the key its signature verifies against.
    pub authority: String,
    /// Signature of the authority (64 bytes).
    pub authority_signature: Option<Base64VecU8>,
    /// Signature of `gas/sol` (64 bytes).
    pub gas_signature: Option<Base64VecU8>,
    /// The stored message only advances the nonce: the authority signature of the original
    /// message failed, and since a late signature of it could still surface, the payout is
    /// cancelled on chain (this message or the original executes, never both) and settled by
    /// its confirmation like any other.
    pub cancel: bool,
    /// Block of the first confirmation proof that showed the nonce advanced without the
    /// transaction's effects; the verdict "did not execute" needs another proof
    /// [`super::CONFIRM_FAILURE_DELAY_BLOCKS`] later, so a lagging read cannot produce it.
    pub not_executed_seen_at: Option<U64>,
    /// Wire transaction once both signatures exist, `[2] || sig(gas/sol) || sig(authority) ||
    /// message`: assembled by the views, never stored.
    #[borsh(skip)]
    pub transaction: Option<Base64VecU8>,
}

/// A signed foreign action.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payout {
    pub id: U64,
    pub chain: Chain,
    pub kind: PayoutKind,
    pub debit: PayoutDebit,
    /// Account that requested the action.
    pub requester: AccountId,
    /// Block height of the latest proof or signature request: a payout still `Requested`
    /// [`crate::PENDING_EXPIRY_BLOCKS`] later may be retried (`retry_base_signature`,
    /// `retry_sol_payout`). Set back by that many blocks when the request failed, so the retry
    /// is open at once.
    pub requested_block: U64,
    /// Signature requests issued so far.
    pub sign_requests: u32,
    /// Position released or withdrawn, when the action concerns one.
    pub position_id: Option<U64>,
    pub status: PayoutStatus,
    /// EIP-712 digest the vault key signs (hex), for Base actions.
    pub digest: Option<String>,
    pub base: Option<BaseSignature>,
    pub solana: Option<SolTransaction>,
    pub created_at: U64,
    pub updated_at: U64,
}

/// What a refused deposit is and where it sits.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefusedAsset {
    /// A Sablier stream held by RoseVault.
    BaseStream { lockup: String, stream_id: u64 },
    /// A Streamflow stream held by `held_by` (the vault or a deposit address).
    SolStream {
        metadata: String,
        held_by: String,
        held_by_path: String,
    },
}

/// A genuine deposit the engine refused at registration, returnable to its sender.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefusedDeposit {
    pub chain: Chain,
    pub asset: RefusedAsset,
    /// Foreign address the asset goes back to: the depositor on Base, the address named at
    /// attribution on Solana.
    pub return_to: String,
    /// NEAR account the deposit was meant for.
    pub near_account: String,
    pub reason: String,
    /// The latest return action requested.
    pub return_payout: Option<U64>,
    pub refused_at: U64,
}

/// Stage of a Solana deposit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SolDepositStage {
    /// Proven at the deposit address; `move_sol_deposit` may sign the move.
    Attributed,
    /// The move to the vault is signed and stored in the payout.
    MoveSigned { payout_id: U64 },
    /// Registered as a position.
    Registered { position_id: U64 },
    /// Refused; see the refused deposit record.
    Refused,
}

/// A Streamflow stream attributed to a NEAR account through its deposit address.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolDeposit {
    pub metadata: String,
    pub account: AccountId,
    pub class_id: ClassId,
    /// Derivation path of the deposit address.
    pub path: String,
    /// The deposit address (base58).
    pub deposit_address: String,
    pub mint: String,
    pub decimals: u8,
    pub return_to: String,
    pub stage: SolDepositStage,
    pub attributed_at: U64,
}

/// The accounts of a registered Streamflow position the engine needs to build instructions.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SolStreamInfo {
    pub metadata: String,
    pub mint: String,
    /// Accounts of a Streamflow `withdraw`, as the attested metadata names them (the program
    /// requires them to match it).
    pub escrow_tokens: String,
    pub streamflow_treasury_tokens: String,
    pub partner: String,
    pub partner_tokens: String,
    pub start_time: u64,
    pub cliff: u64,
    pub cliff_amount: U64,
    pub period: u64,
    pub amount_per_period: U64,
    pub net_amount_deposited: U64,
    pub end_time: u64,
    /// Tokens withdrawn from the stream's escrow and proven: the attested `amount_withdrawn`
    /// at registration plus every payout withdrawal proven landed since. Only the engine
    /// withdraws vault streams (automatic withdrawal is refused at deposit).
    pub engine_withdrawn: U64,
    /// The attested `amount_withdrawn` at registration (paid to the depositor before).
    pub registered_withdrawn: U64,
    /// Accrual checkpoint the position's units were minted from.
    pub checkpoint: U128,
    /// The one payout drawing on the stream that is not confirmed yet (at most one at a time, so
    /// that the attested `amount_withdrawn` tells unambiguously whether it landed).
    pub drawing: Option<U64>,
    /// What that payout withdraws (0 when none).
    pub pending_withdraw: U64,
}

impl SolStreamInfo {
    /// The registered schedule.
    pub fn params(&self) -> StreamflowParams {
        StreamflowParams {
            start_time: self.start_time,
            cliff: self.cliff,
            cliff_amount: self.cliff_amount.0,
            period: self.period,
            amount_per_period: self.amount_per_period.0,
            net_amount_deposited: self.net_amount_deposited.0,
            end_time: self.end_time,
            ..StreamflowParams::default()
        }
    }
}

/// Arguments of the class id helpers.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SablierScheduleArgs {
    pub start: u64,
    pub cliff: u64,
    pub end: u64,
    pub granularity: u64,
    pub start_unlock: U128,
    pub cliff_unlock: U128,
    pub deposited: U128,
}

impl From<&SablierScheduleArgs> for SablierLinearParams {
    fn from(args: &SablierScheduleArgs) -> Self {
        Self {
            start: args.start,
            cliff: args.cliff,
            end: args.end,
            granularity: args.granularity,
            start_unlock: args.start_unlock.0,
            cliff_unlock: args.cliff_unlock.0,
            deposited: args.deposited.0,
        }
    }
}
