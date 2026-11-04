//! Read-only methods. Amounts are strings (`U128`, `U64`), counts are numbers.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId};

use crate::clearing;
use crate::events::StoredEvent;
use crate::rounds::round_pricing;
use crate::types::{
    BidId, CancelReason, Chain, ClaimSource, ClassId, Config, Holder, KeySource, LienId, Opened,
    Position, PricePoint, RoundId, RoundKind, RoundResult, RoundStatus, Side, Venue, VoidReason,
};
use crate::unlock::ClassSchedule;
use crate::{Contract, ContractExt};

/// Protocol statistics for the landing page.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stats {
    pub rounds_total: u64,
    pub rounds_settled: u64,
    /// Sum of settled notionals across every venue, in 6-decimal USDC-equivalent base units
    /// (every venue is a USDC: NEAR tUSDC, Base USDC or tUSDC).
    pub volume_settled_usdc: U128,
    pub classes: u64,
    pub positions: u64,
}

/// Normalized class schedule.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum ScheduleView {
    Linear {
        start: U64,
        cliff: U64,
        end: U64,
        granularity: U64,
        start_unlock: U128,
        cliff_unlock: U128,
        total: U128,
        min_deposit: U128,
    },
    Stepped {
        start: U64,
        end: U64,
        period: U64,
        cliff_amount: U128,
        amount_per_period: U128,
        total: U128,
    },
}

/// A class.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClassView {
    pub class_id: ClassId,
    pub chain: Chain,
    pub token: String,
    pub decimals: u8,
    pub schedule: ScheduleView,
    pub positions: u32,
    pub total_units: U128,
    /// `f(now)`, 1e18 fixed point.
    pub fraction_now: U128,
    pub created_at: U64,
}

/// A position with its id.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PositionView {
    pub position_id: U64,
    #[serde(flatten)]
    pub position: Position,
}

/// A round.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RoundView {
    pub round_id: U64,
    pub kind: RoundKind,
    pub class_id: ClassId,
    pub venue: Venue,
    pub creator: AccountId,
    pub status: RoundStatus,
    pub opens_at: U64,
    pub closes_at: U64,
    pub key_timeout: U64,
    pub reveal_window: U64,
    pub max_price: U128,
    pub reference_price: Option<U128>,
    /// Class fraction at `closes_at`.
    pub f_ts: U128,
    pub remaining_lock_secs: U64,
    /// Hex of the round's CKD `app_id`.
    pub app_id: String,
    /// Round key as `bls12381g1:<base58>`, once public.
    pub key: Option<String>,
    pub key_source: Option<KeySource>,
    pub close_requested_at: Option<U64>,
    pub key_received_at: Option<U64>,
    /// End of the reveal window, once the key arrived.
    pub reveal_ends_at: Option<U64>,
    pub bid_count: u32,
    pub opened_count: u32,
    pub settled_count: u32,
    pub budget: Option<U128>,
    pub issuer_escrow: Option<U128>,
    pub retire_to: Option<String>,
    pub advance_units: Option<U128>,
    pub advance_claim: Option<U128>,
    pub advance_min_fill: Option<U128>,
    pub lien_id: Option<U64>,
    pub cancel_reason: Option<CancelReason>,
    pub result: Option<RoundResult>,
    pub created_at: U64,
    pub ended_at: Option<U64>,
}

/// Largest number of round ids one `get_rounds` call examines.
pub const MAX_ROUND_SCAN: u32 = 200;

/// A page of rounds.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RoundsPage {
    pub rounds: Vec<RoundView>,
    /// Id to continue from, `None` when every round was examined.
    pub next: Option<U64>,
}

/// A page of a class's clearing price history.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PriceHistoryPage {
    pub points: Vec<PricePoint>,
    pub total: u32,
}

/// Filter of `get_rounds`; every field is optional.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default)]
pub struct RoundFilter {
    pub kind: Option<RoundKind>,
    pub class_id: Option<ClassId>,
    pub status: Option<RoundStatus>,
    pub creator: Option<AccountId>,
}

/// Status of one sealed order.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BidStatus {
    Sealed,
    Opened,
    Void,
    Settled,
}

/// A sealed order, live or settled.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BidView {
    pub round_id: U64,
    pub bid_id: BidId,
    pub bidder: AccountId,
    pub side: Side,
    pub status: BidStatus,
    /// Hex ciphertext while the bid is live.
    pub ciphertext_hex: Option<String>,
    pub escrow: U128,
    pub locked_units: U128,
    pub bond: U128,
    pub placed_at: Option<U64>,
    pub opened: Option<Opened>,
    pub void: Option<VoidReason>,
    pub fill_quantity: U128,
    pub cash: U128,
    pub fee: U128,
}

/// An account's units of one class.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HoldingView {
    pub class_id: ClassId,
    /// Free units.
    pub balance: U128,
    /// Units locked in live rounds.
    pub locked_in_rounds: U128,
    /// Units encumbered by liens.
    pub encumbered: U128,
    /// Unlocked tokens claimable now, pending lien excess included.
    pub claimable: U128,
    pub checkpoint: U128,
}

/// A lien.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LienView {
    pub lien_id: U64,
    pub class_id: ClassId,
    pub round_id: U64,
    pub holder: AccountId,
    pub units: U128,
    pub claim_total: U128,
    /// Tokens delivered to the lien, accrued to now.
    pub delivered: U128,
    /// Excess accrual owed to the holder, not yet credited.
    pub pending_excess: U128,
    pub released: bool,
    pub created_at: U64,
}

/// A funder's share of a lien.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct LienShareView {
    pub lien_id: U64,
    pub class_id: ClassId,
    pub funder: AccountId,
    pub claim: U128,
    pub claimed: U128,
    /// Tokens the funder can claim now.
    pub claimable: U128,
}

/// Cash in one venue.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CashView {
    pub venue: Venue,
    pub amount: U128,
}

/// Everything an account holds.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PortfolioView {
    pub holdings: Vec<HoldingView>,
    pub bids: Vec<BidView>,
    pub liens_held: Vec<LienView>,
    pub lien_shares: Vec<LienShareView>,
    pub cash: Vec<CashView>,
}

/// Collateral preview of a bid.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BuyQuote {
    /// Cash charged at the limit price if fully filled (rounded up).
    pub charge: U128,
    /// Protocol fee on that charge.
    pub fee: U128,
    /// Smallest escrow that keeps the bid valid: `charge + fee`.
    pub escrow_required: U128,
    /// Bond for that escrow.
    pub bond: U128,
}

/// Collateral preview of an ask.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SellQuote {
    /// Units valued at the round's max price.
    pub valuation: U128,
    pub bond: U128,
}

/// A page of the event history.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EventsPage {
    pub events: Vec<StoredEvent>,
    /// Events recorded over the contract's life.
    pub total: U64,
    /// Oldest sequence number still in the history.
    pub oldest: U64,
}

#[near]
impl Contract {
    /// Protocol statistics.
    pub fn stats(&self) -> Stats {
        Stats {
            rounds_total: self.next_round_id,
            rounds_settled: self.rounds_settled,
            volume_settled_usdc: U128(self.volume_settled),
            classes: u64::from(self.classes.len()),
            positions: self.next_position_id,
        }
    }

    /// Contract configuration.
    pub fn get_config(&self) -> Config {
        self.config.clone()
    }

    /// Storage deposits and bounds, for the app.
    pub fn get_limits(&self) -> Limits {
        Limits {
            bid_storage_deposit: U128(crate::BID_STORAGE_DEPOSIT.as_yoctonear()),
            round_storage_deposit: U128(crate::ROUND_STORAGE_DEPOSIT.as_yoctonear()),
            max_bids_per_round: crate::MAX_BIDS_PER_ROUND,
            max_distribution_receivers: crate::MAX_DISTRIBUTION_RECEIVERS as u32,
            fee_bps: clearing::FEE_BPS as u32,
            bond_floor: U128(crate::ONE_USDC),
        }
    }

    /// A class, or `None`.
    pub fn get_class(&self, class_id: ClassId) -> Option<ClassView> {
        self.classes
            .get(&class_id)
            .map(|class| self.class_view(&class_id, class))
    }

    /// Classes in creation order, paginated.
    pub fn get_classes(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ClassView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50) as usize;
        self.classes
            .iter()
            .skip(from)
            .take(limit)
            .map(|(class_id, class)| self.class_view(class_id, class))
            .collect()
    }

    /// A position, or `None`.
    pub fn get_position(&self, position_id: U64) -> Option<PositionView> {
        self.positions
            .get(&position_id.0)
            .map(|position| PositionView {
                position_id,
                position: position.clone(),
            })
    }

    /// Positions by id, paginated.
    pub fn get_positions(&self, from_index: Option<U64>, limit: Option<u32>) -> Vec<PositionView> {
        let from = from_index.map_or(0, |f| f.0);
        let end = self
            .next_position_id
            .min(from.saturating_add(u64::from(limit.unwrap_or(50))));
        (from..end)
            .filter_map(|id| self.get_position(U64(id)))
            .collect()
    }

    /// A round, or `None`.
    pub fn get_round(&self, round_id: U64) -> Option<RoundView> {
        self.rounds
            .get(&round_id.0)
            .map(|round| self.round_view(round))
    }

    /// Rounds matching `filter`, scanning ids from `from_index` until `limit` matches (default
    /// 20) or `MAX_ROUND_SCAN` ids were examined. `next` is the id to continue from, `None` when
    /// every round was examined.
    pub fn get_rounds(
        &self,
        filter: Option<RoundFilter>,
        from_index: Option<U64>,
        limit: Option<u32>,
    ) -> RoundsPage {
        let filter = filter.unwrap_or_default();
        let limit = limit.unwrap_or(20).max(1) as usize;
        let from = from_index.map_or(0, |f| f.0);
        let scan_end = self
            .next_round_id
            .min(from.saturating_add(u64::from(MAX_ROUND_SCAN)));
        let mut rounds = Vec::new();
        let mut next = None;
        for id in from..scan_end {
            if rounds.len() == limit {
                next = Some(U64(id));
                break;
            }
            let Some(round) = self.rounds.get(&id) else {
                continue;
            };
            let view = self.round_view(round);
            let matches = filter.kind.is_none_or(|k| k == view.kind)
                && filter.class_id.as_ref().is_none_or(|c| *c == view.class_id)
                && filter.status.is_none_or(|s| s == view.status)
                && filter.creator.as_ref().is_none_or(|c| *c == view.creator);
            if matches {
                rounds.push(view);
            }
        }
        if next.is_none() && scan_end < self.next_round_id {
            next = Some(U64(scan_end));
        }
        RoundsPage { rounds, next }
    }

    /// The sealed book of a round: every order with its public collateral, and after clearing
    /// its opened values and fill.
    pub fn get_bids(&self, round_id: U64) -> Vec<BidView> {
        let Some(round) = self.rounds.get(&round_id.0) else {
            return Vec::new();
        };
        (0..round.bid_count)
            .filter_map(|bid_id| self.bid_view(round_id.0, bid_id))
            .collect()
    }

    /// One order of a round.
    pub fn get_bid(&self, round_id: U64, bid_id: u32) -> Option<BidView> {
        self.bid_view(round_id.0, bid_id)
    }

    /// The id of `account`'s order on `side` of a live round, if any.
    pub fn get_order_id(&self, round_id: U64, account: AccountId, side: Side) -> Option<u32> {
        self.orders
            .get(&(round_id.0, account, side.ad_byte()))
            .copied()
    }

    /// The result of an ended round, or `None`.
    pub fn get_round_result(&self, round_id: U64) -> Option<RoundResult> {
        self.rounds
            .get(&round_id.0)
            .and_then(|round| round.result.clone())
    }

    /// An account's holding of a class, accrued to now.
    pub fn get_holding(&self, account: AccountId, class_id: ClassId) -> HoldingView {
        self.holding_view(&account, &class_id)
    }

    /// The retired lot of a Tender: units bought back and their claimable tokens, payable only
    /// to the Tender's `retire_to` address.
    pub fn get_retired_lot(&self, round_id: U64) -> Option<RetiredLotView> {
        let round = self.rounds.get(&round_id.0)?;
        let terms = round.tender.as_ref()?;
        let holding = self.holding(&Holder::Retired(round_id.0), &round.class_id);
        let f_now = self.fraction_now(&round.class_id);
        Some(RetiredLotView {
            round_id,
            class_id: round.class_id.clone(),
            retire_to: terms.retire_to.clone(),
            units: U128(holding.balance),
            claimable: U128(holding.claimable_at(f_now)),
        })
    }

    /// Everything `account` holds: units per class, live orders, liens, cash.
    pub fn get_portfolio(&self, account: AccountId) -> PortfolioView {
        let holdings = self
            .classes
            .keys()
            .map(|class_id| self.holding_view(&account, class_id))
            .filter(|view| {
                view.balance.0 > 0
                    || view.claimable.0 > 0
                    || view.locked_in_rounds.0 > 0
                    || view.encumbered.0 > 0
            })
            .collect();
        let index = self
            .account_index
            .get(&account)
            .cloned()
            .unwrap_or_default();
        let bids = index
            .bids
            .iter()
            .filter_map(|(round_id, bid_id)| self.bid_view(*round_id, *bid_id))
            .collect();
        let liens_held = index
            .liens_held
            .iter()
            .filter_map(|lien_id| self.lien_view(*lien_id))
            .collect();
        let lien_shares = index
            .lien_shares
            .iter()
            .filter_map(|lien_id| self.lien_share_view(*lien_id, &account))
            .collect();
        PortfolioView {
            holdings,
            bids,
            liens_held,
            lien_shares,
            cash: self.get_cash(account),
        }
    }

    /// Free cash of `account` in every venue.
    pub fn get_cash(&self, account: AccountId) -> Vec<CashView> {
        let mut venues = vec![Venue::Near];
        venues.extend(
            self.config
                .base_cash_tokens
                .iter()
                .map(|token| Venue::Base {
                    token: token.clone(),
                }),
        );
        venues
            .into_iter()
            .map(|venue| CashView {
                amount: U128(self.cash_of(&account, &venue)),
                venue,
            })
            .collect()
    }

    /// Liens where `account` is the holder, and its lien shares as a funder.
    pub fn get_liens(&self, account: AccountId) -> (Vec<LienView>, Vec<LienShareView>) {
        let index = self
            .account_index
            .get(&account)
            .cloned()
            .unwrap_or_default();
        (
            index
                .liens_held
                .iter()
                .filter_map(|lien_id| self.lien_view(*lien_id))
                .collect(),
            index
                .lien_shares
                .iter()
                .filter_map(|lien_id| self.lien_share_view(*lien_id, &account))
                .collect(),
        )
    }

    /// A lien, or `None`.
    pub fn get_lien(&self, lien_id: U64) -> Option<LienView> {
        self.lien_view(lien_id.0)
    }

    /// Clearing price history of a class, oldest first, from `from_index` (default 0), at most
    /// `limit` points (default 50).
    pub fn get_price_history(
        &self,
        class_id: ClassId,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> PriceHistoryPage {
        let Some(history) = self.price_history.get(&class_id) else {
            return PriceHistoryPage {
                points: Vec::new(),
                total: 0,
            };
        };
        let from = from_index.unwrap_or(0);
        let end = history.len().min(from.saturating_add(limit.unwrap_or(50)));
        PriceHistoryPage {
            points: (from..end)
                .filter_map(|i| history.get(i).cloned())
                .collect(),
            total: history.len(),
        }
    }

    /// Events with `seq >= from_seq` (default: the oldest available), at most `limit`
    /// (default 100), oldest first.
    pub fn get_events(&self, from_seq: Option<U64>, limit: Option<u32>) -> EventsPage {
        let (events, oldest) = self.events_page(from_seq.map_or(0, |f| f.0), limit.unwrap_or(100));
        EventsPage {
            events,
            total: U64(self.events_total),
            oldest: U64(oldest),
        }
    }

    /// Collateral a buyer needs for `quantity` at `limit_price` in `round_id`.
    pub fn quote_buy(&self, round_id: U64, quantity: U128, limit_price: U128) -> BuyQuote {
        let round = self.round(round_id.0);
        let charge = round_pricing(round)
            .charge(quantity.0, limit_price.0)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        let fee = clearing::fee(charge).unwrap_or_else(|e| env::panic_str(&e.to_string()));
        let escrow = charge
            .checked_add(fee)
            .unwrap_or_else(|| env::panic_str("Amount overflow"));
        BuyQuote {
            charge: U128(charge),
            fee: U128(fee),
            escrow_required: U128(escrow),
            bond: U128((escrow / 100).max(crate::ONE_USDC)),
        }
    }

    /// Bond a seller posts to lock `units` in `round_id`.
    pub fn quote_sell(&self, round_id: U64, units: U128) -> SellQuote {
        let round = self.round(round_id.0);
        let valuation = round_pricing(round)
            .charge(units.0, round.max_price)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        SellQuote {
            valuation: U128(valuation),
            bond: U128((valuation / 100).max(crate::ONE_USDC)),
        }
    }

    /// Unlocked tokens `account` can claim from `class_id` now.
    pub fn get_claimable(&self, account: AccountId, class_id: ClassId) -> U128 {
        U128(self.claimable_of(&ClaimSource::Holding { account, class_id }))
    }
}

/// Storage deposits and bounds.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Limits {
    pub bid_storage_deposit: U128,
    pub round_storage_deposit: U128,
    pub max_bids_per_round: u32,
    pub max_distribution_receivers: u32,
    pub fee_bps: u32,
    pub bond_floor: U128,
}

/// The retired lot of a Tender.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RetiredLotView {
    pub round_id: U64,
    pub class_id: ClassId,
    pub retire_to: String,
    pub units: U128,
    pub claimable: U128,
}

impl Contract {
    fn class_view(&self, class_id: &ClassId, class: &crate::types::Class) -> ClassView {
        ClassView {
            class_id: class_id.clone(),
            chain: class.chain,
            token: class.token.clone(),
            decimals: class.decimals,
            schedule: schedule_view(&class.schedule),
            positions: class.positions,
            total_units: U128(class.total_units),
            fraction_now: U128(class.schedule.fraction(crate::now_secs())),
            created_at: U64(class.created_at),
        }
    }

    fn round_view(&self, round: &crate::types::Round) -> RoundView {
        let now = env::block_timestamp();
        RoundView {
            round_id: U64(round.id),
            kind: round.kind,
            class_id: round.class_id.clone(),
            venue: round.venue.clone(),
            creator: round.creator.clone(),
            status: Self::status_of(round, now),
            opens_at: U64(round.opens_at),
            closes_at: U64(round.closes_at),
            key_timeout: U64(round.key_timeout),
            reveal_window: U64(round.reveal_window),
            max_price: U128(round.max_price),
            reference_price: round.reference_price.map(U128),
            f_ts: U128(round.f_ts),
            remaining_lock_secs: U64(crate::rounds::remaining_lock_secs(round)),
            app_id: hex::encode(rose_ibe::round_app_id(
                env::current_account_id().as_str(),
                round.id,
            )),
            key: round.key.map(|k| rose_ibe::format_near_g1_bytes(&k)),
            key_source: round.key_source,
            close_requested_at: round.close_requested_at.map(U64),
            key_received_at: round.key_received_at.map(U64),
            reveal_ends_at: round
                .key_received_at
                .map(|t| U64(t.saturating_add(round.reveal_window))),
            bid_count: round.bid_count,
            opened_count: round.opened_count,
            settled_count: round.settled_count,
            budget: round.tender.as_ref().map(|t| U128(t.budget)),
            issuer_escrow: round.tender.as_ref().map(|t| U128(t.escrow)),
            retire_to: round.tender.as_ref().map(|t| t.retire_to.clone()),
            advance_units: round.advance.as_ref().map(|a| U128(a.units)),
            advance_claim: round.advance.as_ref().map(|a| U128(a.claim)),
            advance_min_fill: round.advance.as_ref().map(|a| U128(a.min_fill)),
            lien_id: round.advance.as_ref().and_then(|a| a.lien_id).map(U64),
            cancel_reason: round.cancel_reason,
            result: round.result.clone(),
            created_at: U64(round.created_at),
            ended_at: round.ended_at.map(U64),
        }
    }

    fn bid_view(&self, round_id: RoundId, bid_id: BidId) -> Option<BidView> {
        let round = self.rounds.get(&round_id)?;
        let outcome = round
            .result
            .as_ref()
            .and_then(|result| result.fills.get(bid_id as usize));
        if let Some(bid) = self.bids.get(&(round_id, bid_id)) {
            let void = outcome.and_then(|o| o.void).or(bid.void);
            let status = if void.is_some() {
                BidStatus::Void
            } else if bid.opened.is_some() {
                BidStatus::Opened
            } else {
                BidStatus::Sealed
            };
            return Some(BidView {
                round_id: U64(round_id),
                bid_id,
                bidder: bid.bidder.clone(),
                side: bid.side,
                status,
                ciphertext_hex: Some(hex::encode(&bid.ciphertext)),
                escrow: U128(bid.escrow),
                locked_units: U128(bid.lock.map_or(0, |l| l.units)),
                bond: U128(bid.bond),
                placed_at: Some(U64(bid.placed_at)),
                opened: bid.opened,
                void,
                fill_quantity: outcome.map_or(U128(0), |o| o.fill_quantity),
                cash: outcome.map_or(U128(0), |o| o.cash),
                fee: outcome.map_or(U128(0), |o| o.fee),
            });
        }
        let outcome = outcome?;
        Some(BidView {
            round_id: U64(round_id),
            bid_id,
            bidder: outcome.bidder.clone(),
            side: outcome.side,
            status: BidStatus::Settled,
            ciphertext_hex: None,
            escrow: outcome.escrow,
            locked_units: outcome.locked_units,
            bond: outcome.bond,
            placed_at: None,
            opened: outcome.opened,
            void: outcome.void,
            fill_quantity: outcome.fill_quantity,
            cash: outcome.cash,
            fee: outcome.fee,
        })
    }

    fn holding_view(&self, account: &AccountId, class_id: &ClassId) -> HoldingView {
        let holding = self.holding(&Holder::Account(account.clone()), class_id);
        let index = self.account_index.get(account).cloned().unwrap_or_default();
        let locked_in_rounds = index
            .bids
            .iter()
            .filter(|(round_id, _)| {
                self.rounds
                    .get(round_id)
                    .is_some_and(|r| r.class_id == *class_id)
            })
            .filter_map(|key| self.bids.get(key))
            .map(|bid| bid.lock.map_or(0, |l| l.units))
            .sum::<u128>()
            .saturating_add(self.advance_locks(&index, class_id));
        let encumbered = index
            .liens_held
            .iter()
            .filter_map(|id| self.liens.get(id))
            .filter(|record| record.class_id == *class_id && !record.released)
            .map(|record| record.lien.units)
            .sum();
        HoldingView {
            class_id: class_id.clone(),
            balance: U128(holding.balance),
            locked_in_rounds: U128(locked_in_rounds),
            encumbered: U128(encumbered),
            claimable: U128(self.claimable_of(&ClaimSource::Holding {
                account: account.clone(),
                class_id: class_id.clone(),
            })),
            checkpoint: U128(holding.checkpoint),
        }
    }

    /// Units of `class_id` locked by `account` as the holder of live Advances (they sit on the
    /// round, not on a bid).
    fn advance_locks(&self, index: &crate::types::AccountIndex, class_id: &ClassId) -> u128 {
        index
            .advances
            .iter()
            .filter_map(|round_id| self.rounds.get(round_id))
            .filter(|round| round.class_id == *class_id)
            .filter_map(|round| round.advance.as_ref().and_then(|a| a.lock))
            .map(|lock| lock.units)
            .sum()
    }

    fn lien_view(&self, lien_id: LienId) -> Option<LienView> {
        let record = self.liens.get(&lien_id)?;
        let f_now = self.fraction_now(&record.class_id);
        let (delivered, pending_excess) = if record.released {
            (record.lien.delivered, 0)
        } else {
            record.lien.preview(f_now)
        };
        Some(LienView {
            lien_id: U64(lien_id),
            class_id: record.class_id.clone(),
            round_id: U64(record.round_id),
            holder: record.holder.clone(),
            units: U128(record.lien.units),
            claim_total: U128(record.lien.claim_total),
            delivered: U128(delivered),
            pending_excess: U128(pending_excess),
            released: record.released,
            created_at: U64(record.created_at),
        })
    }

    fn lien_share_view(&self, lien_id: LienId, funder: &AccountId) -> Option<LienShareView> {
        let record = self.liens.get(&lien_id)?;
        let share = self
            .lien_shares
            .get(&(lien_id, funder.clone()))
            .copied()
            .unwrap_or_default();
        Some(LienShareView {
            lien_id: U64(lien_id),
            class_id: record.class_id.clone(),
            funder: funder.clone(),
            claim: U128(share.claim),
            claimed: U128(share.claimed),
            claimable: U128(self.claimable_of(&ClaimSource::LienShare {
                lien_id,
                funder: funder.clone(),
            })),
        })
    }
}

fn schedule_view(schedule: &ClassSchedule) -> ScheduleView {
    match schedule {
        ClassSchedule::Linear(class) => ScheduleView::Linear {
            start: U64(class.start()),
            cliff: U64(class.cliff()),
            end: U64(class.end()),
            granularity: U64(class.granularity()),
            start_unlock: U128(class.start_unlock()),
            cliff_unlock: U128(class.cliff_unlock()),
            total: U128(class.total()),
            min_deposit: U128(class.min_deposit()),
        },
        ClassSchedule::Stepped(class) => ScheduleView::Stepped {
            start: U64(class.start()),
            end: U64(class.end()),
            period: U64(class.period()),
            cliff_amount: U128(class.cliff_amount()),
            amount_per_period: U128(class.amount_per_period()),
            total: U128(class.total()),
        },
    }
}
