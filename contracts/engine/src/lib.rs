//! rose engine: sealed, uniform-price liquidity rounds for locked token allocations.
//!
//! The pure modules (`math`, `unlock`, `clearing`, `ledger`) have no NEAR dependency and are
//! property-tested natively. The contract modules wire them to NEAR state:
//!
//! - `units`: NEP-245 units with accrual accounting;
//! - `cash`: the cash ledger per venue;
//! - `rounds`: round creation, cancellation and sealed orders;
//! - `sealing`: key release (CKD, `submit_key`, `cancel_no_key`) and verified openings;
//! - `settlement`: clearing, per-bid settlement and liens;
//! - `custody`: MPC-derived addresses, attested foreign deposits, signed payouts and redeems;
//! - `events`: NEP-297 logs and the bounded on-chain history;
//! - `views`: read-only methods.
//!
//! The contract is keyless after init: there is no upgrade, migrate, delete or generic call
//! method. Testnet only.

pub mod clearing;
pub mod foreign;
pub mod ledger;
pub mod math;
pub mod unlock;

mod cash;
mod custody;
mod events;
mod rounds;
mod sealing;
mod settlement;
mod storage;
mod types;
mod units;
mod views;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

pub use cash::FungibleToken;
pub use custody::{CustodyState, PAYOUT_STORAGE_DEPOSIT, PENDING_EXPIRY_BLOCKS};
pub use events::{RoseEvent, StoredEvent, EVENT_CAPACITY, EVENT_STANDARD, EVENT_VERSION};
pub use storage::{StorageBalance, StorageBalanceBounds, HOLDING_ROW_BYTES, STORAGE_ACCOUNT_BYTES};
pub use types::*;
pub use units::{MtReceiver, Token};

use events::StoredEvent as HistoryEvent;

/// Storage deposit required to place a bid or an ask. Refunded when the bid settles, net of the
/// bytes the engine keeps for it (its outcome in the round result and, for an Advance funder, its
/// lien share row).
pub const BID_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
/// Storage deposit required to create a round. It stays with the round record, which remains on
/// chain as public history whether the round settles or is cancelled.
pub const ROUND_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
/// Largest number of bids a round accepts, so `clear` fits one transaction.
pub const MAX_BIDS_PER_ROUND: u32 = 64;
/// Largest number of receivers of one `distribute_units` call.
pub const MAX_DISTRIBUTION_RECEIVERS: usize = 50;
/// One USDC in cash base units (6 decimals): the bond floor.
pub const ONE_USDC: u128 = 1_000_000;
/// Default `key_timeout`: one hour.
pub const DEFAULT_KEY_TIMEOUT_NS: u64 = 60 * 60 * 1_000_000_000;
/// Default `reveal_window`: ten minutes (spec: 24 h suggested in production).
pub const DEFAULT_REVEAL_WINDOW_NS: u64 = 10 * 60 * 1_000_000_000;

const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Classes,
    Positions,
    Holdings,
    Cash,
    Rounds,
    Bids,
    Orders,
    Liens,
    LienShares,
    AccountIndex,
    Events,
    PriceHistory,
    PriceHistoryClass { class_id: ClassId },
    StorageAccounts,
}

/// The engine.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    classes: IterableMap<ClassId, Class>,
    positions: LookupMap<PositionId, Position>,
    next_position_id: PositionId,
    holdings: LookupMap<(types::Holder, ClassId), ledger::Holding>,
    cash: LookupMap<(AccountId, Venue), u128>,
    rounds: LookupMap<RoundId, Round>,
    next_round_id: RoundId,
    bids: LookupMap<(RoundId, BidId), Bid>,
    /// One sealed order per `(round, bidder, side)`: the IBE associated data carries no bid
    /// index, so a second ciphertext by the same account on the same side could open twice.
    orders: LookupMap<(RoundId, AccountId, u8), BidId>,
    liens: LookupMap<LienId, LienRecord>,
    next_lien_id: LienId,
    lien_shares: LookupMap<(LienId, AccountId), LienShare>,
    account_index: LookupMap<AccountId, AccountIndex>,
    events: Vector<HistoryEvent>,
    events_total: u64,
    price_history: LookupMap<ClassId, Vector<PricePoint>>,
    storage_accounts: LookupMap<AccountId, storage::StorageAccount>,
    rounds_settled: u64,
    volume_settled: u128,
    custody: CustodyState,
}

#[near]
impl Contract {
    /// Initializes the engine once, at deployment. The deployer removes its access keys
    /// afterwards; nothing in the contract can change `config` except the permissionless
    /// bootstrap of the derived foreign addresses.
    #[init]
    pub fn new(args: InitArgs) -> Self {
        require!(
            rose_ibe::parse_near_g2_bytes(&args.ckd_public_key).is_ok(),
            "Invalid CKD public key"
        );
        require!(
            args.base_cash_tokens.iter().all(|t| is_evm_address(t)),
            "Base cash tokens must be lowercase 0x addresses"
        );
        require!(
            is_evm_address(&args.rose_vault),
            "Invalid RoseVault address"
        );
        require!(
            is_evm_address(&args.sablier_lockup),
            "Invalid Sablier Lockup address"
        );
        require!(args.base_chain_id != 0, "Base chain id is required");
        require!(
            !args.streamflow_program.is_empty(),
            "Streamflow program id is required"
        );
        Self {
            config: Config {
                mpc_account: args.mpc_account,
                sign_secp256k1_domain: args.sign_secp256k1_domain,
                sign_ed25519_domain: args.sign_ed25519_domain,
                ckd_domain: args.ckd_domain,
                foreign_tx_domain: args.foreign_tx_domain,
                ckd_public_key: args.ckd_public_key,
                fee_recipient: args.fee_recipient,
                near_cash_token: args.near_cash_token,
                base_cash_tokens: args.base_cash_tokens,
                rose_vault: args.rose_vault,
                base_chain_id: args.base_chain_id,
                sablier_lockup: args.sablier_lockup,
                streamflow_program: args.streamflow_program,
                default_key_timeout: args
                    .default_key_timeout
                    .unwrap_or(U64(DEFAULT_KEY_TIMEOUT_NS)),
                default_reveal_window: args
                    .default_reveal_window
                    .unwrap_or(U64(DEFAULT_REVEAL_WINDOW_NS)),
                derived_addresses: None,
            },
            classes: IterableMap::new(StorageKey::Classes),
            positions: LookupMap::new(StorageKey::Positions),
            next_position_id: 0,
            holdings: LookupMap::new(StorageKey::Holdings),
            cash: LookupMap::new(StorageKey::Cash),
            rounds: LookupMap::new(StorageKey::Rounds),
            next_round_id: 0,
            bids: LookupMap::new(StorageKey::Bids),
            orders: LookupMap::new(StorageKey::Orders),
            liens: LookupMap::new(StorageKey::Liens),
            next_lien_id: 0,
            lien_shares: LookupMap::new(StorageKey::LienShares),
            account_index: LookupMap::new(StorageKey::AccountIndex),
            events: Vector::new(StorageKey::Events),
            events_total: 0,
            price_history: LookupMap::new(StorageKey::PriceHistory),
            storage_accounts: LookupMap::new(StorageKey::StorageAccounts),
            rounds_settled: 0,
            volume_settled: 0,
            custody: CustodyState::new(),
        }
    }
}

impl Contract {
    /// Compressed CKD master public key.
    pub(crate) fn ckd_public_key(&self) -> [u8; 96] {
        rose_ibe::parse_near_g2_bytes(&self.config.ckd_public_key).expect("validated at init")
    }

    /// The class, or a panic naming it.
    pub(crate) fn class(&self, class_id: &ClassId) -> &Class {
        self.classes.get(class_id).unwrap_or_else(|| {
            env::panic_str(&format!("Unknown class {class_id}"));
        })
    }

    /// The round, or a panic naming it.
    pub(crate) fn round(&self, round_id: RoundId) -> &Round {
        self.rounds.get(&round_id).unwrap_or_else(|| {
            env::panic_str(&format!("Unknown round {round_id}"));
        })
    }

    /// Mutable round, or a panic naming it.
    pub(crate) fn round_mut(&mut self, round_id: RoundId) -> &mut Round {
        self.rounds.get_mut(&round_id).unwrap_or_else(|| {
            env::panic_str(&format!("Unknown round {round_id}"));
        })
    }

    /// Class fraction `f(now)`.
    pub(crate) fn fraction_now(&self, class_id: &ClassId) -> u128 {
        self.class(class_id).schedule.fraction(now_secs())
    }

    /// True when `venue` is one the engine settles in.
    pub(crate) fn venue_accepted(&self, venue: &Venue) -> bool {
        match venue {
            Venue::Near => true,
            Venue::Base { token } => self.config.base_cash_tokens.contains(token),
        }
    }

    /// Registers a class if it does not exist yet and returns its id. Classes are keyed by their
    /// economic content, so two deposits with the same chain, token, decimals and normalized
    /// schedule always land in the same class. Internal API for the deposit wiring.
    pub fn ensure_class(
        &mut self,
        chain: Chain,
        token: String,
        decimals: u8,
        schedule: unlock::ClassSchedule,
    ) -> ClassId {
        let class_id = class_id_of(chain, &token, decimals, &schedule);
        if !self.classes.contains_key(&class_id) {
            self.classes.insert(
                class_id.clone(),
                Class {
                    chain,
                    token,
                    decimals,
                    schedule,
                    positions: 0,
                    total_units: 0,
                    created_at: env::block_timestamp(),
                },
            );
            self.emit(RoseEvent::ClassCreated {
                class_id: class_id.clone(),
            });
        }
        class_id
    }

    /// Stores a registered position and returns its id. Internal API for the deposit wiring;
    /// the caller mints the units separately with `mint_units`.
    pub fn insert_position(&mut self, position: Position) -> PositionId {
        let class = self.classes.get_mut(&position.class_id).unwrap_or_else(|| {
            env::panic_str(&format!("Unknown class {}", position.class_id));
        });
        class.positions += 1;
        let position_id = self.next_position_id;
        self.next_position_id += 1;
        self.emit(RoseEvent::PositionRegistered {
            position_id: U64(position_id),
            class_id: position.class_id.clone(),
            depositor: position.depositor.clone(),
            allocation: position.allocation,
        });
        self.positions.insert(position_id, position);
        position_id
    }

    /// Marks a position as released in kind. Internal API for `redeem`.
    pub fn mark_position_released(&mut self, position_id: PositionId, account: &AccountId) {
        let position = self.positions.get_mut(&position_id).unwrap_or_else(|| {
            env::panic_str(&format!("Unknown position {position_id}"));
        });
        require!(
            position.state == PositionState::Held,
            "Position already released"
        );
        position.state = PositionState::Released;
        let class_id = position.class_id.clone();
        self.emit(RoseEvent::PositionReleased {
            position_id: U64(position_id),
            class_id,
            account: account.clone(),
        });
    }

    /// Mutable per-account index, created on demand.
    pub(crate) fn index_mut(&mut self, account: &AccountId) -> &mut AccountIndex {
        self.account_index.entry(account.clone()).or_default()
    }

    /// Drops an account's index once it is empty, releasing its storage.
    pub(crate) fn prune_index(&mut self, account: &AccountId) {
        let empty = self.account_index.get(account).is_some_and(|index| {
            index.bids.is_empty()
                && index.advances.is_empty()
                && index.liens_held.is_empty()
                && index.lien_shares.is_empty()
        });
        if empty {
            self.account_index.remove(account);
        }
    }
}

/// Class id: lowercase hex SHA-256 of the borsh encoding of `(chain, token, decimals, schedule)`.
pub fn class_id_of(
    chain: Chain,
    token: &str,
    decimals: u8,
    schedule: &unlock::ClassSchedule,
) -> ClassId {
    let bytes = borsh::to_vec(&(chain, token, decimals, schedule)).expect("class key serializes");
    hex::encode(env::sha256(&bytes))
}

/// Block timestamp in Unix seconds.
pub(crate) fn now_secs() -> u64 {
    env::block_timestamp() / NANOS_PER_SECOND
}

/// Unix seconds of a block timestamp in nanoseconds.
pub(crate) fn secs_of(timestamp_ns: u64) -> u64 {
    timestamp_ns / NANOS_PER_SECOND
}

/// True for a lowercase `0x` + 40 hex characters EVM address.
pub(crate) fn is_evm_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Requires exactly one yoctoNEAR attached (NEP-245 transfers).
pub(crate) fn assert_one_yocto() {
    require!(
        env::attached_deposit() == NearToken::from_yoctonear(1),
        "Requires attached deposit of exactly 1 yoctoNEAR"
    );
}
