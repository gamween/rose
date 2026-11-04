//! NEP-297 events (standard `rose`, version `1.0.0`) and the bounded on-chain event history.
//!
//! Every state change, custody included, emits an `EVENT_JSON:` log and is appended to a ring
//! buffer of the last [`EVENT_CAPACITY`] events, so the app needs no indexer. Unit movements log
//! the NEP-245 event instead of a `rose` one (see `units.rs`) but are recorded in the history all
//! the same.
//!
//! Nobody pays for a history entry, so the history is bounded in bytes, not only in entries:
//! free texts are cut at [`EVENT_TEXT_MAX_BYTES`], every entry then fits
//! [`EVENT_RECORD_MAX_BYTES`] (measured over every variant in `tests::events`), and `new`
//! refuses to initialize an engine whose balance does not cover the full history
//! ([`EVENT_HISTORY_RESERVE_BYTES`]) on top of its state and its MPC reserve.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::Vector;
use near_sdk::{env, near, serde::Serialize, AccountId};

use crate::custody::ReplayKey;
use crate::types::{
    BidId, CancelReason, Chain, ClassId, KeySource, RoundKind, Side, Venue, VoidReason,
};
use crate::Contract;

/// NEP-297 `standard` of the engine's events.
pub const EVENT_STANDARD: &str = "rose";
/// NEP-297 `version` of the engine's events.
pub const EVENT_VERSION: &str = "1.0.0";
/// Number of events kept in the on-chain history.
pub const EVENT_CAPACITY: u32 = 1024;
/// Longest free text an event keeps (an error, a refusal reason, a claim source), in bytes;
/// a longer one is cut at a character boundary.
pub const EVENT_TEXT_MAX_BYTES: usize = 192;
/// Most bytes one history entry occupies (its key, its value and NEAR's 40-byte record
/// overhead), for the largest variant with 64-character account ids and texts of
/// [`EVENT_TEXT_MAX_BYTES`]; measured in `tests::events`.
pub const EVENT_RECORD_MAX_BYTES: u64 = 448;
/// Most bytes the full history occupies: what the engine's balance must cover at init, since
/// no caller pays for history entries.
pub const EVENT_HISTORY_RESERVE_BYTES: u64 = EVENT_CAPACITY as u64 * EVENT_RECORD_MAX_BYTES;

/// An engine event. Serialized as `{"event": "<snake_case variant>", "data": {...}}`.
#[near(serializers = [borsh, json])]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum RoseEvent {
    ClassCreated {
        class_id: ClassId,
    },
    PositionRegistered {
        position_id: U64,
        class_id: ClassId,
        depositor: AccountId,
        allocation: U128,
    },
    PositionReleased {
        position_id: U64,
        class_id: ClassId,
        account: AccountId,
    },
    UnitsMinted {
        class_id: ClassId,
        account: AccountId,
        units: U128,
    },
    UnitsBurned {
        class_id: ClassId,
        account: AccountId,
        units: U128,
    },
    UnitsTransferred {
        class_id: ClassId,
        from: AccountId,
        to: AccountId,
        units: U128,
    },
    CashDeposited {
        account: AccountId,
        venue: Venue,
        amount: U128,
    },
    CashWithdrawn {
        account: AccountId,
        venue: Venue,
        amount: U128,
    },
    CashWithdrawalFailed {
        account: AccountId,
        venue: Venue,
        amount: U128,
    },
    RoundCreated {
        round_id: U64,
        kind: RoundKind,
        class_id: ClassId,
        venue: Venue,
        creator: AccountId,
        opens_at: U64,
        closes_at: U64,
        max_price: U128,
    },
    BidPlaced {
        round_id: U64,
        bid_id: BidId,
        bidder: AccountId,
        side: Side,
        escrow: U128,
        locked_units: U128,
        bond: U128,
    },
    RoundCancelled {
        round_id: U64,
        reason: CancelReason,
    },
    KeyRequested {
        round_id: U64,
    },
    KeyRequestFailed {
        round_id: U64,
    },
    /// A CKD response arrived for a round that no longer waits for a key.
    KeyIgnored {
        round_id: U64,
    },
    /// The clearing arithmetic failed: the round is cancelled, everything is refundable.
    ClearingFailed {
        round_id: U64,
        error: String,
    },
    StorageDeposited {
        account: AccountId,
        amount: U128,
        total: U128,
    },
    StorageWithdrawn {
        account: AccountId,
        amount: U128,
    },
    StorageUnregistered {
        account: AccountId,
        refund: U128,
    },
    KeyReceived {
        round_id: U64,
        source: KeySource,
        key: String,
    },
    BidOpened {
        round_id: U64,
        bid_id: BidId,
        quantity: U128,
        price: U128,
        void: Option<VoidReason>,
    },
    RoundCleared {
        round_id: U64,
        price: U128,
        volume: U128,
        notional: U128,
        fee: U128,
        remaining_lock_secs: U64,
    },
    BidSettled {
        round_id: U64,
        bid_id: BidId,
        bidder: AccountId,
        fill_quantity: U128,
        cash: U128,
        refund: U128,
        bond_refunded: bool,
    },
    LienCreated {
        lien_id: U64,
        round_id: U64,
        class_id: ClassId,
        holder: AccountId,
        units: U128,
        claim_total: U128,
    },
    LienReleased {
        lien_id: U64,
        holder: AccountId,
        units: U128,
    },
    ClaimableTaken {
        class_id: ClassId,
        source: String,
        amount: U128,
    },
    BootstrapRequested,
    Bootstrapped {
        vault_base: String,
        vault_sol: String,
        gas_sol: String,
    },
    BootstrapFailed,
    DepositVerificationRequested {
        key: ReplayKey,
    },
    DepositVerificationFailed {
        key: ReplayKey,
    },
    /// The attested payload hash differs from the engine's recomputation.
    DepositMismatch {
        key: ReplayKey,
    },
    /// A genuine deposit the engine refused (returnable with `return_refused_deposit`).
    DepositRefused {
        key: ReplayKey,
        reason: String,
    },
    DepositRegistered {
        key: ReplayKey,
        chain: Chain,
        position_id: U64,
        class_id: ClassId,
        account: AccountId,
        units: U128,
        checkpoint: U128,
    },
    BaseCashRegistered {
        key: ReplayKey,
        account: AccountId,
        token: String,
        amount: U128,
        round_id: U64,
        accepted: bool,
    },
    SolDepositAttributed {
        metadata: String,
        account: AccountId,
        class_id: ClassId,
        deposit_address: String,
    },
    PayoutRequested {
        payout_id: U64,
        chain: Chain,
        requester: AccountId,
    },
    PayoutSigned {
        payout_id: U64,
    },
    PayoutAwaitingGasSignature {
        payout_id: U64,
    },
    PayoutFailed {
        payout_id: U64,
        reason: String,
    },
    PositionReleaseRequested {
        position_id: U64,
        payout_id: U64,
        account: AccountId,
    },
    /// A signed Solana payout or release proven executed on chain.
    PayoutLanded {
        payout_id: U64,
    },
    /// The authority signature of a Solana payout or release failed: the payout is cancelled
    /// by a transaction that only advances its nonce.
    PayoutCancelling {
        payout_id: U64,
    },
    /// `sync_sol_stream` booked `amount` that Streamflow withdrew from a vault stream outside
    /// any payout (its auto-claim of an ended stream) in the class's swept balance.
    SolStreamSwept {
        position_id: U64,
        class_id: ClassId,
        amount: U64,
    },
}

/// An event with its position in the history and its block context.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct StoredEvent {
    /// Sequence number, increasing from `0` over the whole life of the contract.
    pub seq: U64,
    pub block_height: U64,
    pub timestamp: U64,
    /// Account that called the method which produced the event.
    pub predecessor: AccountId,
    #[serde(flatten)]
    pub event: RoseEvent,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct EventLog<'a, T: Serialize> {
    standard: &'a str,
    version: &'a str,
    #[serde(flatten)]
    body: T,
}

/// Logs any NEP-297 event body under `standard` and `version`.
pub(crate) fn log_event<T: Serialize>(standard: &str, version: &str, body: T) {
    let log = EventLog {
        standard,
        version,
        body,
    };
    let json = near_sdk::serde_json::to_string(&log).expect("event serializes");
    env::log_str(&format!("EVENT_JSON:{json}"));
}

impl Contract {
    /// Logs a `rose` event and records it in the history.
    pub(crate) fn emit(&mut self, event: RoseEvent) {
        let event = event.bounded();
        log_event(EVENT_STANDARD, EVENT_VERSION, &event);
        self.record(event);
    }

    /// Records an event in the history without logging it (its log is a NEP-245 event).
    pub(crate) fn record(&mut self, event: RoseEvent) {
        let stored = StoredEvent {
            seq: U64(self.events_total),
            block_height: U64(env::block_height()),
            timestamp: U64(env::block_timestamp()),
            predecessor: env::predecessor_account_id(),
            event: event.bounded(),
        };
        push_ring(&mut self.events, self.events_total, stored);
        self.events_total += 1;
    }

    /// Events with `seq >= from`, at most `limit`, oldest first. Events older than the history
    /// capacity are gone; the result reports the oldest sequence still available.
    pub(crate) fn events_page(&self, from: u64, limit: u32) -> (Vec<StoredEvent>, u64) {
        let oldest = self.events_total.saturating_sub(u64::from(EVENT_CAPACITY));
        let start = from.max(oldest);
        let end = self
            .events_total
            .min(start.saturating_add(u64::from(limit)));
        let events = (start..end)
            .filter_map(|seq| self.events.get(slot(seq)).cloned())
            .collect();
        (events, oldest)
    }
}

impl RoseEvent {
    /// The event with its free texts cut at [`EVENT_TEXT_MAX_BYTES`].
    pub(crate) fn bounded(mut self) -> Self {
        match &mut self {
            Self::ClearingFailed { error: text, .. }
            | Self::ClaimableTaken { source: text, .. }
            | Self::DepositRefused { reason: text, .. }
            | Self::PayoutFailed { reason: text, .. }
                if text.len() > EVENT_TEXT_MAX_BYTES =>
            {
                let mut end = EVENT_TEXT_MAX_BYTES;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
            }
            _ => {}
        }
        self
    }
}

fn slot(seq: u64) -> u32 {
    (seq % u64::from(EVENT_CAPACITY)) as u32
}

fn push_ring(events: &mut Vector<StoredEvent>, total: u64, stored: StoredEvent) {
    if events.len() < EVENT_CAPACITY {
        events.push(stored);
    } else {
        events.set(slot(total), stored);
    }
}
