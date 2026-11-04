//! Clearing, per-bid settlement, liens and the claimable-token API (spec section 5.4).
//!
//! `clear` runs once per round over at most `MAX_BIDS_PER_ROUND` orders and stores one outcome
//! per bid; `settle_bid` then applies one outcome at a time, in any order, usually when the
//! participant claims. Units and cash only move inside the ledger; foreign payouts pull from the
//! claimable balances through `take_claimable`.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::clearing::{self, AdvanceAsk, ClearingError, Fill, Order, Outcome};
use crate::ledger::Lien;
use crate::rounds::{remaining_lock_secs, reveal_deadline, round_pricing};
use crate::storage::LIEN_SHARE_ROW_BYTES;
use crate::types::{
    Bid, BidId, BidOutcome, CancelReason, ClaimReceipt, ClaimSource, Holder, LienId, LienRecord,
    LienShare, Phase, PricePoint, Round, RoundId, RoundKind, RoundResult, Side, VoidReason,
};
use crate::{Contract, ContractExt, RoseEvent};

#[near]
impl Contract {
    /// Clears a round once its reveal window is over. Anyone. Unopened orders are void (bond
    /// slashed at settlement); the clearing price and every fill are computed from the opened,
    /// valid orders and stored. The round becomes `Settled`, or `Cancelled` when nothing
    /// crosses. A Tender's issuer is refunded `escrow - charged - fee(charged)` here; an
    /// Advance's units move into a lien here.
    pub fn clear(&mut self, round_id: U64) {
        let round = self.round(round_id.0).clone();
        require!(round.phase == Phase::Revealing, "Round is not revealing");
        require!(
            env::block_timestamp() >= reveal_deadline(&round),
            "Reveal window is still open"
        );
        let bids: Vec<Bid> = (0..round.bid_count)
            .map(|bid_id| {
                self.bids
                    .get(&(round_id.0, bid_id))
                    .cloned()
                    .expect("every placed bid exists until settled")
            })
            .collect();
        let mut fills = outcomes(&bids, true);
        let (buys, sells) = valid_orders(&round, &bids);

        let cleared = match compute_clearing(&round, &mut fills, &buys, &sells) {
            Ok(cleared) => cleared,
            Err(error) => {
                self.emit(RoseEvent::ClearingFailed {
                    round_id,
                    error: error.to_string(),
                });
                None
            }
        };

        let Some((price, volume, notional, fee)) = cleared else {
            self.cancel(round_id.0, CancelReason::NoCrossing);
            return;
        };

        let (issuer_charged, issuer_refund) = match &round.tender {
            Some(terms) => {
                let refund = terms
                    .escrow
                    .checked_sub(notional)
                    .and_then(|rest| rest.checked_sub(fee))
                    .unwrap_or_else(|| {
                        env::panic_str("Internal clearing error: charge exceeds escrow")
                    });
                self.credit_cash(&round.creator, &round.venue, refund);
                self.credit_cash(&self.config.fee_recipient.clone(), &round.venue, fee);
                (notional, refund)
            }
            None => (0, 0),
        };
        if round.kind == RoundKind::Advance {
            self.create_lien(&round, volume);
        }

        let remaining = remaining_lock_secs(&round);
        let now = env::block_timestamp();
        {
            let stored = self.round_mut(round_id.0);
            stored.phase = Phase::Settled;
            stored.ended_at = Some(now);
            stored.result = Some(RoundResult {
                price: U128(price),
                volume: U128(volume),
                notional: U128(notional),
                fee: U128(fee),
                issuer_charged: U128(issuer_charged),
                issuer_refund: U128(issuer_refund),
                remaining_lock_secs: U64(remaining),
                fills,
            });
        }
        let history = self
            .price_history
            .entry(round.class_id.clone())
            .or_insert_with(|| {
                Vector::new(crate::StorageKey::PriceHistoryClass {
                    class_id: round.class_id.clone(),
                })
            });
        history.push(PricePoint {
            round_id: round_id.0,
            kind: round.kind,
            price: U128(price),
            remaining_lock_secs: U64(remaining),
            volume: U128(volume),
            settled_at: U64(round.closes_at),
        });
        self.rounds_settled += 1;
        self.volume_settled = self.volume_settled.saturating_add(notional);
        self.emit(RoseEvent::RoundCleared {
            round_id,
            price: U128(price),
            volume: U128(volume),
            notional: U128(notional),
            fee: U128(fee),
            remaining_lock_secs: U64(remaining),
        });
    }

    /// Applies one bid's outcome to the ledger: units to the buyer (or a lien share), cash to the
    /// seller, refund of the unused escrow, bond refund or slash, and the storage deposit back to
    /// the bidder. Anyone, once the round is `Settled` or `Cancelled`; each bid settles once.
    pub fn settle_bid(&mut self, round_id: U64, bid_id: u32) {
        let round = self.round(round_id.0).clone();
        require!(
            matches!(round.phase, Phase::Settled | Phase::Cancelled),
            "Round has not ended"
        );
        let bid = self
            .bids
            .get(&(round_id.0, bid_id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("Bid already settled or unknown"));
        let result = round.result.as_ref().expect("ended rounds have a result");
        let outcome = result.fills[bid_id as usize].clone();
        if bid.side == Side::Buy && round.kind == RoundKind::Exit && outcome.fill_quantity.0 > 0 {
            require!(
                self.is_registered(&bid.bidder),
                format!(
                    "Account {} is not registered: call storage_deposit first",
                    bid.bidder
                )
            );
        }
        self.bids.remove(&(round_id.0, bid_id));
        let venue = &round.venue;
        let treasury = self.config.fee_recipient.clone();
        let f_now = self.fraction_now(&round.class_id);
        let settled = round.phase == Phase::Settled;

        let mut share_bytes = 0u64;
        let bond_refunded = outcome.void.is_none();
        if bond_refunded {
            self.credit_cash(&bid.bidder, venue, bid.bond);
        } else {
            self.credit_cash(&treasury, venue, bid.bond);
        }

        let refund = match bid.side {
            Side::Buy => {
                let refund = bid
                    .escrow
                    .checked_sub(outcome.cash.0)
                    .and_then(|rest| rest.checked_sub(outcome.fee.0))
                    .unwrap_or_else(|| {
                        env::panic_str("Internal settlement error: charge exceeds escrow")
                    });
                self.credit_cash(&bid.bidder, venue, refund);
                self.credit_cash(&treasury, venue, outcome.fee.0);
                if outcome.fill_quantity.0 > 0 {
                    match round.kind {
                        RoundKind::Exit => self.credit_holding(
                            &Holder::Account(bid.bidder.clone()),
                            &round.class_id,
                            outcome.fill_quantity.0,
                            f_now,
                            round.f_ts,
                        ),
                        RoundKind::Advance => {
                            share_bytes =
                                self.add_lien_share(&round, &bid.bidder, outcome.fill_quantity.0);
                        }
                        RoundKind::Tender => {
                            env::panic_str("Internal settlement error: a Tender has no bids")
                        }
                    }
                }
                refund
            }
            Side::Sell => {
                self.credit_cash(&bid.bidder, venue, outcome.cash.0);
                if let Some(lock) = bid.lock {
                    let seller = Holder::Account(bid.bidder.clone());
                    if settled {
                        let sold = outcome.fill_quantity.0;
                        let unsold = lock.units.checked_sub(sold).unwrap_or_else(|| {
                            env::panic_str("Internal settlement error: fill exceeds lock")
                        });
                        self.add_claimable(
                            &seller,
                            &round.class_id,
                            lock.accrued_until(round.f_ts),
                        );
                        self.credit_holding(&seller, &round.class_id, unsold, f_now, round.f_ts);
                        if sold > 0 && round.kind == RoundKind::Tender {
                            self.credit_holding(
                                &Holder::Retired(round_id.0),
                                &round.class_id,
                                sold,
                                f_now,
                                round.f_ts,
                            );
                        }
                    } else {
                        self.credit_holding(
                            &seller,
                            &round.class_id,
                            lock.units,
                            f_now,
                            lock.checkpoint,
                        );
                    }
                }
                0
            }
        };

        self.orders
            .remove(&(round_id.0, bid.bidder.clone(), bid.side.ad_byte()));
        let index = self.index_mut(&bid.bidder);
        index.bids.retain(|entry| *entry != (round_id.0, bid_id));
        self.prune_index(&bid.bidder);
        {
            let stored = self.round_mut(round_id.0);
            stored.settled_count += 1;
            stored.result.as_mut().expect("result").fills[bid_id as usize].settled = true;
        }
        let kept_bytes =
            borsh::to_vec(&outcome).expect("outcome serializes").len() as u64 + share_bytes;
        let deposit_refund = bid
            .storage_deposit
            .saturating_sub(crate::storage::bytes_cost(kept_bytes));
        if deposit_refund > 0 {
            Promise::new(bid.bidder.clone())
                .transfer(NearToken::from_yoctonear(deposit_refund))
                .detach();
        }
        self.emit(RoseEvent::BidSettled {
            round_id,
            bid_id,
            bidder: bid.bidder,
            fill_quantity: outcome.fill_quantity,
            cash: outcome.cash,
            refund: U128(refund),
            bond_refunded,
        });
    }

    /// Accrues a lien and, once its claim is fully delivered, returns the encumbered units to
    /// the holder. Anyone. Excess accrual beyond the claim is credited to the holder's claimable
    /// balance on every call.
    pub fn release_lien(&mut self, lien_id: U64) {
        self.touch_lien(lien_id.0);
        let record = self
            .liens
            .get(&lien_id.0)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown lien"));
        require!(!record.released, "Lien already released");
        require!(
            record.lien.is_satisfied(),
            "Lien claim is not fully delivered yet"
        );
        let f_now = self.fraction_now(&record.class_id);
        self.credit_holding(
            &Holder::Account(record.holder.clone()),
            &record.class_id,
            record.lien.units,
            f_now,
            record.lien.checkpoint,
        );
        self.liens.get_mut(&lien_id.0).expect("lien").released = true;
        self.index_mut(&record.holder)
            .liens_held
            .retain(|id| *id != lien_id.0);
        self.prune_index(&record.holder);
        self.emit(RoseEvent::LienReleased {
            lien_id,
            holder: record.holder,
            units: U128(record.lien.units),
        });
    }
}

impl Contract {
    /// Outcomes of a round that ends without clearing (fills of zero). With `slash_unopened`
    /// (no crossing after a reveal window) unopened orders are void; without it (no key) nothing
    /// could be opened, so only orders already marked void stay void.
    pub(crate) fn outcomes_without_clearing(
        &self,
        round_id: RoundId,
        slash_unopened: bool,
    ) -> Vec<BidOutcome> {
        let round = self.round(round_id);
        let bids: Vec<Bid> = (0..round.bid_count)
            .map(|bid_id| {
                self.bids
                    .get(&(round_id, bid_id))
                    .cloned()
                    .expect("every placed bid exists until settled")
            })
            .collect();
        outcomes(&bids, slash_unopened)
    }

    /// Takes `amount` unlocked tokens out of `source` for a payout, after accruing it. Internal
    /// API for the payout wiring: debit before the proof or sign promise, `refund_claimable` only
    /// when the proof failed or a signed Solana transaction was proven not to have executed
    /// (never on a failed signature request). Panics with "Not enough claimable tokens" when the
    /// source is short. The receipt names the class, chain and token, and the foreign address a
    /// retired lot restricts the payout to.
    pub fn take_claimable(&mut self, source: &ClaimSource, amount: u128) -> ClaimReceipt {
        require!(amount > 0, "Amount must be positive");
        let class_id = self.claim_class(source);
        let f_now = self.fraction_now(&class_id);
        let restricted_to = match source {
            ClaimSource::Holding { account, class_id } => {
                for lien_id in self.liens_held_by(account) {
                    if self
                        .liens
                        .get(&lien_id)
                        .is_some_and(|l| &l.class_id == class_id)
                    {
                        self.touch_lien(lien_id);
                    }
                }
                self.take_from_holding(&Holder::Account(account.clone()), class_id, f_now, amount);
                None
            }
            ClaimSource::Retired { round_id } => {
                let round = self.round(*round_id);
                let retire_to = round
                    .tender
                    .as_ref()
                    .expect("retired lots belong to Tenders")
                    .retire_to
                    .clone();
                self.take_from_holding(&Holder::Retired(*round_id), &class_id, f_now, amount);
                Some(retire_to)
            }
            ClaimSource::LienShare { lien_id, funder } => {
                self.touch_lien(*lien_id);
                let lien = self.liens.get(lien_id).expect("lien").lien;
                let key = (*lien_id, funder.clone());
                let share = self.lien_shares.get(&key).copied().unwrap_or_default();
                let available = lien.entitlement(share.claim).saturating_sub(share.claimed);
                require!(available >= amount, "Not enough claimable tokens");
                self.lien_shares.insert(
                    key,
                    LienShare {
                        claim: share.claim,
                        claimed: share.claimed + amount,
                    },
                );
                None
            }
        };
        let class = self.class(&class_id).clone();
        self.emit(RoseEvent::ClaimableTaken {
            class_id: class_id.clone(),
            source: describe_source(source),
            amount: U128(amount),
        });
        ClaimReceipt {
            class_id,
            chain: class.chain,
            token: class.token,
            restricted_to,
        }
    }

    /// Gives back tokens taken by `take_claimable` when the payout's proof failed or its signed
    /// Solana transaction was proven not to have executed. Internal API for payout callbacks.
    pub fn refund_claimable(&mut self, source: &ClaimSource, amount: u128) {
        match source {
            ClaimSource::Holding { account, class_id } => {
                self.add_claimable(&Holder::Account(account.clone()), class_id, amount);
            }
            ClaimSource::Retired { round_id } => {
                let class_id = self.round(*round_id).class_id.clone();
                self.add_claimable(&Holder::Retired(*round_id), &class_id, amount);
            }
            ClaimSource::LienShare { lien_id, funder } => {
                let key = (*lien_id, funder.clone());
                let share = self.lien_shares.get(&key).copied().unwrap_or_default();
                self.lien_shares.insert(
                    key,
                    LienShare {
                        claim: share.claim,
                        claimed: share.claimed.saturating_sub(amount),
                    },
                );
            }
        }
    }

    /// Tokens `source` could claim now, without mutating state (accrued to the block time,
    /// pending lien excess included for holdings).
    pub fn claimable_of(&self, source: &ClaimSource) -> u128 {
        if let ClaimSource::LienShare { lien_id, .. } = source {
            if !self.liens.contains_key(lien_id) {
                return 0;
            }
        }
        let class_id = self.claim_class(source);
        let f_now = self.fraction_now(&class_id);
        match source {
            ClaimSource::Holding { account, class_id } => {
                let excess: u128 = self
                    .liens_held_by(account)
                    .into_iter()
                    .filter_map(|id| self.liens.get(&id))
                    .filter(|record| &record.class_id == class_id && !record.released)
                    .map(|record| record.lien.preview(f_now).1)
                    .sum();
                self.holding(&Holder::Account(account.clone()), class_id)
                    .claimable_at(f_now)
                    .saturating_add(excess)
            }
            ClaimSource::Retired { round_id } => self
                .holding(&Holder::Retired(*round_id), &class_id)
                .claimable_at(f_now),
            ClaimSource::LienShare { lien_id, funder } => {
                let record = self.liens.get(lien_id).expect("checked above");
                let share = self
                    .lien_shares
                    .get(&(*lien_id, funder.clone()))
                    .copied()
                    .unwrap_or_default();
                let mut lien = record.lien;
                lien.accrue(f_now);
                lien.entitlement(share.claim).saturating_sub(share.claimed)
            }
        }
    }

    /// Accrues a lien up to now, crediting the excess to the holder.
    pub(crate) fn touch_lien(&mut self, lien_id: LienId) {
        let Some(record) = self.liens.get(&lien_id).cloned() else {
            return;
        };
        if record.released {
            return;
        }
        let f_now = self.fraction_now(&record.class_id);
        let mut lien = record.lien;
        let excess = lien.accrue(f_now);
        self.liens.get_mut(&lien_id).expect("lien").lien = lien;
        self.add_claimable(&Holder::Account(record.holder), &record.class_id, excess);
    }

    /// Liens where `account` is the encumbered holder.
    pub(crate) fn liens_held_by(&self, account: &AccountId) -> Vec<LienId> {
        self.account_index
            .get(account)
            .map(|index| index.liens_held.clone())
            .unwrap_or_default()
    }

    pub(crate) fn claim_class(&self, source: &ClaimSource) -> crate::types::ClassId {
        match source {
            ClaimSource::Holding { class_id, .. } => class_id.clone(),
            ClaimSource::Retired { round_id } => self.round(*round_id).class_id.clone(),
            ClaimSource::LienShare { lien_id, .. } => self
                .liens
                .get(lien_id)
                .unwrap_or_else(|| env::panic_str("Unknown lien"))
                .class_id
                .clone(),
        }
    }

    fn take_from_holding(
        &mut self,
        holder: &Holder,
        class_id: &crate::types::ClassId,
        f_now: u128,
        amount: u128,
    ) {
        let mut holding = self.holding(holder, class_id);
        holding
            .take_claimable(f_now, amount)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.put_holding(holder, class_id, holding);
    }

    /// Moves the Advance units from their lock into a lien of `claim_total` tokens starting at
    /// the settlement fraction; the lock's accrual until then goes to the holder.
    fn create_lien(&mut self, round: &Round, claim_total: u128) {
        let terms = round.advance.as_ref().expect("advance terms");
        let lock = terms.lock.expect("units are locked until clearing");
        let holder = Holder::Account(round.creator.clone());
        self.add_claimable(&holder, &round.class_id, lock.accrued_until(round.f_ts));
        let lien_id = self.next_lien_id;
        self.next_lien_id += 1;
        self.liens.insert(
            lien_id,
            LienRecord {
                class_id: round.class_id.clone(),
                round_id: round.id,
                holder: round.creator.clone(),
                lien: Lien::new(lock.units, round.f_ts, claim_total),
                released: false,
                created_at: env::block_timestamp(),
            },
        );
        {
            let stored = self
                .round_mut(round.id)
                .advance
                .as_mut()
                .expect("advance terms");
            stored.lock = None;
            stored.lien_id = Some(lien_id);
        }
        self.forget_advance(&round.creator, round.id);
        self.index_mut(&round.creator).liens_held.push(lien_id);
        self.emit(RoseEvent::LienCreated {
            lien_id: U64(lien_id),
            round_id: U64(round.id),
            class_id: round.class_id.clone(),
            holder: round.creator.clone(),
            units: U128(lock.units),
            claim_total: U128(claim_total),
        });
    }

    /// Adds `claim` to the funder's share of the round's lien; returns the bytes of the row when
    /// it was created (charged to the funder's bid deposit).
    fn add_lien_share(&mut self, round: &Round, funder: &AccountId, claim: u128) -> u64 {
        let lien_id = round
            .advance
            .as_ref()
            .and_then(|terms| terms.lien_id)
            .expect("settled Advances have a lien");
        let key = (lien_id, funder.clone());
        let existing = self.lien_shares.get(&key).copied();
        let share = existing.unwrap_or_default();
        self.lien_shares.insert(
            key,
            LienShare {
                claim: share.claim + claim,
                claimed: share.claimed,
            },
        );
        let index = self.index_mut(funder);
        if !index.lien_shares.contains(&lien_id) {
            index.lien_shares.push(lien_id);
        }
        if existing.is_none() {
            LIEN_SHARE_ROW_BYTES
        } else {
            0
        }
    }
}

/// `(price, volume, notional, fee)` of a cleared book, `None` when nothing crosses. Fills are
/// written into `fills`. A `ClearingError` can only come from inconsistent inputs, which the
/// opening checks exclude; the caller cancels the round so everything stays refundable.
fn compute_clearing(
    round: &Round,
    fills: &mut [BidOutcome],
    buys: &[Order],
    sells: &[Order],
) -> Result<Option<(u128, u128, u128, u128)>, ClearingError> {
    let cleared = match round.kind {
        RoundKind::Tender => {
            let terms = round.tender.as_ref().expect("tender terms");
            match clearing::tender(sells, terms.budget, round.max_price, round_pricing(round))? {
                Outcome::NoCrossing => None,
                Outcome::Cleared(result) => {
                    apply_fills(fills, &result.asks, false)?;
                    let fee = clearing::fee(result.charged)?;
                    Some((result.price, result.volume, result.charged, fee))
                }
            }
        }
        RoundKind::Exit => match clearing::exit(buys, sells, round_pricing(round))? {
            Outcome::NoCrossing => None,
            Outcome::Cleared(result) => {
                apply_fills(fills, &result.bids, true)?;
                apply_fills(fills, &result.asks, false)?;
                Some((
                    result.price,
                    result.volume,
                    result.notional,
                    total_fee(fills),
                ))
            }
        },
        RoundKind::Advance => {
            let terms = round.advance.as_ref().expect("advance terms");
            let Some(ask) = terms
                .ask_bid
                .and_then(|id| sells.iter().find(|order| order.id == u64::from(id)))
                .map(|order| AdvanceAsk {
                    id: order.id,
                    claim: terms.claim,
                    reserve: order.price,
                    min_fill: terms.min_fill,
                })
            else {
                return Ok(None);
            };
            match clearing::advance(ask, buys, round.token_decimals)? {
                Outcome::NoCrossing => None,
                Outcome::Cleared(result) => {
                    apply_fills(fills, &result.bids, true)?;
                    apply_fills(fills, &result.asks, false)?;
                    Some((
                        result.price,
                        result.volume,
                        result.notional,
                        total_fee(fills),
                    ))
                }
            }
        }
    };
    Ok(cleared)
}

/// Base outcomes of every bid before (or without) clearing.
fn outcomes(bids: &[Bid], slash_unopened: bool) -> Vec<BidOutcome> {
    bids.iter()
        .enumerate()
        .map(|(bid_id, bid)| BidOutcome {
            bid_id: bid_id as BidId,
            bidder: bid.bidder.clone(),
            side: bid.side,
            escrow: U128(bid.escrow),
            locked_units: U128(bid.lock.map_or(0, |l| l.units)),
            bond: U128(bid.bond),
            opened: bid.opened,
            void: bid.void.or_else(|| {
                (slash_unopened && bid.opened.is_none()).then_some(VoidReason::Unopened)
            }),
            fill_quantity: U128(0),
            cash: U128(0),
            fee: U128(0),
            settled: false,
        })
        .collect()
}

/// Opened, non-void orders priced within the book, as `(buys, sells)` with the bid id as order
/// id. Collateral checks happened at opening; `max_price` bounds the price axis.
fn valid_orders(round: &Round, bids: &[Bid]) -> (Vec<Order>, Vec<Order>) {
    let mut buys = Vec::new();
    let mut sells = Vec::new();
    for (bid_id, bid) in bids.iter().enumerate() {
        let Some(opened) = bid.opened else { continue };
        if bid.void.is_some() || opened.price.0 > round.max_price {
            continue;
        }
        let order = Order {
            id: bid_id as u64,
            qty: opened.quantity.0,
            price: opened.price.0,
        };
        match bid.side {
            Side::Buy => buys.push(order),
            Side::Sell => sells.push(order),
        }
    }
    (buys, sells)
}

fn apply_fills(
    outcomes: &mut [BidOutcome],
    fills: &[Fill],
    buyers: bool,
) -> Result<(), ClearingError> {
    for fill in fills {
        let outcome = &mut outcomes[fill.id as usize];
        outcome.fill_quantity = U128(fill.qty);
        outcome.cash = U128(fill.cash);
        if buyers {
            outcome.fee = U128(clearing::fee(fill.cash)?);
        }
    }
    Ok(())
}

fn total_fee(outcomes: &[BidOutcome]) -> u128 {
    outcomes.iter().fold(0u128, |sum, outcome| {
        sum.checked_add(outcome.fee.0)
            .unwrap_or_else(|| env::panic_str("Internal clearing error: fee overflow"))
    })
}

fn describe_source(source: &ClaimSource) -> String {
    match source {
        ClaimSource::Holding { account, .. } => format!("holding:{account}"),
        ClaimSource::Retired { round_id } => format!("retired:{round_id}"),
        ClaimSource::LienShare { lien_id, funder } => format!("lien:{lien_id}:{funder}"),
    }
}
