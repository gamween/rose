//! Storage records and JSON argument types of the engine.
//!
//! Storage records derive Borsh directly (they never cross the ABI); argument and view types use
//! `#[near(serializers = [json])]` so the ABI can describe them. Amounts in JSON are strings
//! (`U128`, `U64`); timestamps and durations are nanoseconds, as `env::block_timestamp()`.

use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use crate::ledger::{Lien, Lock};
use crate::unlock::ClassSchedule;

/// Lowercase hex SHA-256 of the borsh encoding of `(chain, token, decimals, schedule)`; also the
/// NEP-245 token id of the class units.
pub type ClassId = String;
/// Sequential round id, also the CKD derivation path suffix `round/<id>`.
pub type RoundId = u64;
/// Index of a bid inside its round.
pub type BidId = u32;
/// Sequential lien id.
pub type LienId = u64;
/// Sequential position id.
pub type PositionId = u64;

/// Foreign chain of a class.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Chain {
    /// Base Sepolia (Sablier Lockup v4 positions, USDC cash).
    Base,
    /// Solana devnet (Streamflow positions).
    Solana,
}

/// Cash venue of a round: every escrow, bond, fee and proceed of a round lives in its venue.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Venue {
    /// The configured NEP-141 cash token on NEAR.
    Near,
    /// An accepted ERC-20 held by RoseVault on Base; `token` is the lowercase `0x` address.
    Base { token: String },
}

impl Venue {
    /// The venue with its token address in canonical spelling (any spelling of a valid address
    /// names the same venue); an invalid address is kept, and no venue list contains it.
    pub fn canonical(self) -> Self {
        match self {
            Self::Base { token } => Self::Base {
                token: crate::foreign::evm::canonical_address(&token).unwrap_or(token),
            },
            Self::Near => Self::Near,
        }
    }
}

/// Owner of class units in the holdings ledger.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, BorshSerialize, BorshDeserialize)]
pub enum Holder {
    /// A NEAR account.
    Account(AccountId),
    /// Units bought back by a Tender: non-transferable, their unlocked tokens are payable only to
    /// the Tender's `retire_to` address.
    Retired(RoundId),
}

/// A class of economically identical positions.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Class {
    /// Chain of the positions.
    pub chain: Chain,
    /// Token address (Base, lowercase `0x`) or mint (Solana, base58).
    pub token: String,
    /// Token decimals.
    pub decimals: u8,
    /// Normalized unlock schedule shared by every position.
    pub schedule: ClassSchedule,
    /// Positions registered in the class.
    pub positions: u32,
    /// Units minted minus units burned.
    pub total_units: u128,
    /// Creation block timestamp.
    pub created_at: u64,
}

/// Where a position lives on its chain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PositionSource {
    /// A Sablier Lockup stream owned by RoseVault.
    BaseStream { lockup: String, stream_id: U128 },
    /// A Streamflow stream whose recipient is the Solana vault; `metadata` is the base58
    /// metadata account.
    SolanaStream { metadata: String },
}

/// Custody state of a position.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PositionState {
    /// Held by the vault.
    Held,
    /// Released in kind through `redeem`.
    Released,
    /// A `redeem` is in flight: its units are burned and its release is signed or being signed,
    /// not yet final (a Solana release becomes final once `confirm_sol_redeem` proves it).
    Releasing,
}

/// One locked allocation held by a vault.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Position {
    /// Class of the position.
    pub class_id: ClassId,
    /// Foreign source.
    pub source: PositionSource,
    /// Allocation in token base units (the units minted for it).
    pub allocation: U128,
    /// Account the units were minted to.
    pub depositor: AccountId,
    /// Registration block timestamp.
    pub deposited_at: U64,
    /// Custody state.
    pub state: PositionState,
}

/// Round type.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundKind {
    /// One public buyer with a public budget and max price, sealed asks; bought units are retired.
    Tender,
    /// Sealed asks against sealed bids at one uniform price.
    Exit,
    /// One holder sells a senior claim on the first unlocks of encumbered units; sealed bids.
    Advance,
}

/// Stored phase of a round; `Scheduled`, `Open` and `Clearing` are derived from time.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Before the key request: `Scheduled` until `opens_at`, `Open` afterwards.
    Bidding,
    /// The CKD request is out and no key has arrived.
    KeyRequested,
    /// The key is public: openings until the reveal window ends, then `Clearing`.
    Revealing,
    /// Cleared with a crossing; bids settle one by one.
    Settled,
    /// Cancelled: everything is refundable.
    Cancelled,
}

/// Round status as shown to users (spec section 5.6).
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundStatus {
    Scheduled,
    Open,
    KeyRequested,
    Revealing,
    Clearing,
    Settled,
    Cancelled,
}

/// Why a round was cancelled.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    /// The creator cancelled it before the first bid.
    Creator,
    /// No key arrived by `closes_at + key_timeout`.
    NoKey,
    /// No price crosses, or the clearing arithmetic failed (everything refundable).
    NoCrossing,
    /// Closed without any sealed order.
    Empty,
}

/// How the round key reached the contract.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    /// The CKD callback.
    Callback,
    /// `submit_key`.
    Submitted,
}

/// Side of a sealed order. The discriminant is the `side` byte of the IBE associated data.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// A bid: cash escrowed, sealed limit price and quantity.
    Buy,
    /// An ask: units locked, sealed minimum price and quantity.
    Sell,
}

impl Side {
    /// `side` byte of the IBE associated data.
    pub fn ad_byte(self) -> u8 {
        match self {
            Self::Buy => 0,
            Self::Sell => 1,
        }
    }
}

/// Why an opened or unopened bid is void (its bond is slashed, it is never filled).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    /// Nobody opened it during the reveal window.
    Unopened,
    /// A buyer's `charge(limit, quantity) + fee` exceeds its escrow.
    EscrowTooSmall,
    /// A buyer's quantity exceeds the round's `max_buy_quantity`: the class supply when the
    /// round was created (Exit), the claim (Advance).
    QuantityAboveSupply,
    /// A seller's quantity exceeds its locked units.
    QuantityAboveLocked,
    /// The Advance holder's ask quantity differs from the claim.
    ClaimMismatch,
}

/// Public terms of a Tender.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct TenderTerms {
    /// Public budget, cash base units.
    pub budget: u128,
    /// Cash escrowed by the issuer: `budget + fee(budget)`.
    pub escrow: u128,
    /// Foreign address the retired units' unlocked tokens are paid to.
    pub retire_to: String,
}

/// Public terms of an Advance.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct AdvanceTerms {
    /// Units `X` encumbered by the holder.
    pub units: u128,
    /// Claim `K` in token base units.
    pub claim: u128,
    /// Smallest volume that crosses.
    pub min_fill: u128,
    /// The holder's units while the round is live; `None` once they moved to a lien or back.
    pub lock: Option<Lock>,
    /// The holder's sealed reserve, once placed.
    pub ask_bid: Option<BidId>,
    /// The lien created at clearing.
    pub lien_id: Option<LienId>,
}

/// Opened values of a bid.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opened {
    /// Quantity in units (claimed tokens in an Advance).
    pub quantity: U128,
    /// Limit price (bid) or minimum price (ask) per whole token.
    pub price: U128,
}

/// A sealed order while its round is live.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Bid {
    /// Bidder.
    pub bidder: AccountId,
    /// Side.
    pub side: Side,
    /// 192-byte IBE ciphertext.
    pub ciphertext: Vec<u8>,
    /// Cash escrowed (buyers), cash base units.
    pub escrow: u128,
    /// Units locked (sellers of a Tender or Exit).
    pub lock: Option<Lock>,
    /// Bond, cash base units.
    pub bond: u128,
    /// NEAR attached as storage deposit, yoctoNEAR.
    pub storage_deposit: u128,
    /// Bytes of the bidder's storage reserved for the holding row an Exit buy may create
    /// (`HOLDING_ROW_BYTES` when the bidder held no row of the class at bid time, else 0);
    /// released at settlement, before the bought units land.
    pub reserved_row_bytes: u64,
    /// Opened values.
    pub opened: Option<Opened>,
    /// Void reason set at opening.
    pub void: Option<VoidReason>,
    /// Block timestamp of placement.
    pub placed_at: u64,
}

/// Outcome of one bid, stored in the round result when the round ends.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct BidOutcome {
    pub bid_id: BidId,
    pub bidder: AccountId,
    pub side: Side,
    /// Escrow (buyers).
    pub escrow: U128,
    /// Units locked by a Tender or Exit seller; `0` for buyers and for the Advance holder's
    /// reserve (the encumbered units sit on the round).
    pub locked_units: U128,
    pub bond: U128,
    pub opened: Option<Opened>,
    pub void: Option<VoidReason>,
    /// Filled quantity.
    pub fill_quantity: U128,
    /// Cash charged (buyers, rounded up) or paid (sellers, rounded down), fees excluded.
    pub cash: U128,
    /// Protocol fee charged on top of `cash` (buyers only).
    pub fee: U128,
    /// True once `settle_bid` applied the outcome.
    pub settled: bool,
}

/// Result of a round once it ended.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RoundResult {
    /// Clearing price per whole locked token (per claimed token in an Advance); `0` when
    /// nothing crossed.
    pub price: U128,
    /// Units traded (claimed tokens in an Advance).
    pub volume: U128,
    /// Settled notional: the buying side's charges, fees excluded.
    pub notional: U128,
    /// Total protocol fee.
    pub fee: U128,
    /// Tender: cash charged to the issuer (notional).
    pub issuer_charged: U128,
    /// Tender: escrow returned to the issuer (`escrow - charged - fee(charged)`).
    pub issuer_refund: U128,
    /// Remaining lock duration of the class at `closes_at`, seconds.
    pub remaining_lock_secs: U64,
    /// One outcome per bid, indexed by bid id.
    pub fills: Vec<BidOutcome>,
}

/// A round.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct Round {
    pub id: RoundId,
    pub kind: RoundKind,
    pub class_id: ClassId,
    pub venue: Venue,
    pub creator: AccountId,
    /// Bids accepted from this block timestamp.
    pub opens_at: u64,
    /// Bids accepted before this block timestamp; also the settlement time `ts`.
    pub closes_at: u64,
    /// `cancel_no_key` allowed from `closes_at + key_timeout`.
    pub key_timeout: u64,
    /// Openings accepted for this long after the key arrived.
    pub reveal_window: u64,
    /// Price ceiling of the book, per whole locked token (per claimed token in an Advance).
    pub max_price: u128,
    /// Issuer-declared reference price, display only.
    pub reference_price: Option<u128>,
    /// Largest quantity a buy order may name, fixed at creation: the class supply then (Exit),
    /// the claim (Advance); `None` for a Tender, which takes no buy orders. Fixed so that a later
    /// redeem, which shrinks the supply, never voids a covered bid sealed against it.
    pub max_buy_quantity: Option<u128>,
    /// Class fraction at `closes_at`.
    pub f_ts: u128,
    /// End of the class schedule, Unix seconds.
    pub schedule_end_secs: u64,
    /// Decimals of the class token.
    pub token_decimals: u8,
    pub phase: Phase,
    /// Verified round key, compressed G1.
    pub key: Option<[u8; 48]>,
    pub key_source: Option<KeySource>,
    pub close_requested_at: Option<u64>,
    /// Block height of the last key request (`cancel_no_key` waits until it has resolved).
    pub close_requested_block: Option<u64>,
    pub key_received_at: Option<u64>,
    pub bid_count: BidId,
    pub opened_count: u32,
    pub settled_count: u32,
    pub tender: Option<TenderTerms>,
    pub advance: Option<AdvanceTerms>,
    pub result: Option<RoundResult>,
    pub cancel_reason: Option<CancelReason>,
    /// NEAR attached by the creator as storage deposit, yoctoNEAR; it stays with the record.
    pub storage_deposit: u128,
    pub created_at: u64,
    pub ended_at: Option<u64>,
}

/// A lien created by a settled Advance.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize)]
pub struct LienRecord {
    pub class_id: ClassId,
    pub round_id: RoundId,
    pub holder: AccountId,
    pub lien: Lien,
    /// True once the claim was delivered and the units returned to the holder.
    pub released: bool,
    pub created_at: u64,
}

/// A funder's share of a lien.
#[derive(Clone, Copy, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct LienShare {
    /// Claimed tokens bought by the funder.
    pub claim: u128,
    /// Tokens already taken out for payouts.
    pub claimed: u128,
}

/// Per-account index of the records that views cannot find by scanning a bounded set.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize)]
pub struct AccountIndex {
    /// Unsettled bids.
    pub bids: Vec<(RoundId, BidId)>,
    /// Advances created by the account whose units are still locked on the round.
    pub advances: Vec<RoundId>,
    /// Liens where the account is the encumbered holder.
    pub liens_held: Vec<LienId>,
    /// Liens where the account owns a share.
    pub lien_shares: Vec<LienId>,
}

/// One point of a class's clearing price history (spec section 4, "Clearing prices").
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PricePoint {
    pub round_id: RoundId,
    pub kind: RoundKind,
    /// Clearing price per whole locked token (per claimed token in an Advance).
    pub price: U128,
    /// Remaining lock duration at settlement, seconds.
    pub remaining_lock_secs: U64,
    /// Units traded.
    pub volume: U128,
    /// Settlement time (`closes_at`).
    pub settled_at: U64,
}

/// Source of claimable unlocked tokens, for the payout wiring.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimSource {
    /// An account's holding of a class.
    Holding {
        account: AccountId,
        class_id: ClassId,
    },
    /// The retired lot of a Tender, payable only to its `retire_to` address.
    Retired { round_id: RoundId },
    /// A funder's share of a lien.
    LienShare { lien_id: LienId, funder: AccountId },
}

/// What a `take_claimable` debit entitles the payout to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimReceipt {
    pub class_id: ClassId,
    pub chain: Chain,
    /// Token address or mint of the class.
    pub token: String,
    /// Foreign address the payout must go to, when the source restricts it (retired lots).
    pub restricted_to: Option<String>,
}

/// Contract configuration, fixed at init (`derived_addresses` is filled once by the foreign
/// bootstrap).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    /// MPC contract (`v1.signer-prod.testnet`).
    pub mpc_account: AccountId,
    /// MPC domain ids.
    pub sign_secp256k1_domain: u64,
    pub sign_ed25519_domain: u64,
    pub ckd_domain: u64,
    pub foreign_tx_domain: u64,
    /// Compressed CKD master public key (domain 2), `bls12381g2:<base58>`.
    pub ckd_public_key: String,
    /// Receives fees and slashed bonds, in every venue.
    pub fee_recipient: AccountId,
    /// NEP-141 cash token of the `Near` venue.
    pub near_cash_token: AccountId,
    /// Accepted Base cash tokens (lowercase `0x`).
    pub base_cash_tokens: Vec<String>,
    /// RoseVault address on Base (lowercase `0x`).
    pub rose_vault: String,
    /// EVM chain id of the RoseVault deployment, the `chainId` of its EIP-712 domain (84532 on
    /// Base Sepolia).
    pub base_chain_id: u64,
    /// Canonical Sablier Lockup address on Base (lowercase `0x`).
    pub sablier_lockup: String,
    /// Streamflow program id on Solana.
    pub streamflow_program: String,
    /// Default `key_timeout`, nanoseconds.
    pub default_key_timeout: U64,
    /// Default `reveal_window`, nanoseconds.
    pub default_reveal_window: U64,
    /// MPC-derived foreign addresses, once bootstrapped.
    pub derived_addresses: Option<DerivedAddresses>,
}

/// Foreign addresses derived by the MPC for the engine.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DerivedAddresses {
    /// Path `vault/base`, EVM address.
    pub vault_base: String,
    /// Path `vault/sol`, Ed25519 address.
    pub vault_sol: String,
    /// Path `gas/sol`, Ed25519 address.
    pub gas_sol: String,
}

/// Init arguments.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct InitArgs {
    pub mpc_account: AccountId,
    pub sign_secp256k1_domain: u64,
    pub sign_ed25519_domain: u64,
    pub ckd_domain: u64,
    pub foreign_tx_domain: u64,
    pub ckd_public_key: String,
    pub fee_recipient: AccountId,
    pub near_cash_token: AccountId,
    pub base_cash_tokens: Vec<String>,
    pub rose_vault: String,
    /// EVM chain id of the RoseVault deployment (84532 on Base Sepolia).
    pub base_chain_id: u64,
    pub sablier_lockup: String,
    pub streamflow_program: String,
    /// Defaults to one hour.
    pub default_key_timeout: Option<U64>,
    /// Defaults to ten minutes.
    pub default_reveal_window: Option<U64>,
}

/// Timing of a new round, nanoseconds.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, Default)]
pub struct RoundWindow {
    /// Defaults to the current block timestamp.
    pub opens_at: Option<U64>,
    /// Bids close (and the settlement time `ts`); in the future, at most
    /// [`crate::MAX_ROUND_HORIZON_NS`] (30 days) ahead.
    pub closes_at: U64,
    /// Defaults to the configured default; between [`crate::MIN_KEY_TIMEOUT_NS`] (1 minute)
    /// and [`crate::MAX_KEY_TIMEOUT_NS`] (7 days).
    pub key_timeout: Option<U64>,
    /// Defaults to the configured default; between [`crate::MIN_REVEAL_WINDOW_NS`] (5 minutes)
    /// and [`crate::MAX_REVEAL_WINDOW_NS`] (7 days).
    pub reveal_window: Option<U64>,
}
