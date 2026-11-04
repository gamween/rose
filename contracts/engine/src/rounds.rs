//! Round creation, cancellation before the first bid, and sealed orders.
//!
//! Prices are cash base units per whole locked token at the settlement time `ts = closes_at`
//! (per claimed token in an Advance). `max_price` bounds the price axis of every round: orders
//! priced above it are never filled (they are not void, their bond comes back).

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId};

use crate::clearing::{self, Pricing};
use crate::ledger::Lock;
use crate::math::{self, ONE};
use crate::types::{
    AdvanceTerms, Bid, BidId, CancelReason, Chain, ClassId, Holder, Phase, Round, RoundId,
    RoundKind, RoundStatus, RoundWindow, Side, TenderTerms, Venue,
};
use crate::unlock::ClassSchedule;
use crate::{
    secs_of, Contract, ContractExt, RoseEvent, BID_STORAGE_DEPOSIT, MAX_BIDS_PER_ROUND, ONE_USDC,
    ROUND_STORAGE_DEPOSIT,
};

/// Public parameters of a Tender.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TenderParams {
    pub class_id: ClassId,
    pub venue: Venue,
    /// Budget, cash base units. The issuer escrows `budget + fee(budget)`.
    pub budget: U128,
    /// Highest price per whole locked token the issuer pays.
    pub max_price: U128,
    /// Display-only reference price (spec section 4, "Clearing prices").
    pub reference_price: Option<U128>,
    /// Foreign address receiving the retired units' unlocked tokens (burn address allowed).
    pub retire_to: String,
    pub window: RoundWindow,
}

/// Public parameters of an Exit.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ExitParams {
    pub class_id: ClassId,
    pub venue: Venue,
    /// Price ceiling of the book, per whole locked token; also values seller bonds.
    pub max_price: U128,
    pub window: RoundWindow,
}

/// Public parameters of an Advance.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AdvanceParams {
    pub class_id: ClassId,
    pub venue: Venue,
    /// Units `X` to encumber.
    pub units: U128,
    /// Claim `K` on the first tokens unlocked by the units, `K <= X * (1 - f(ts))`.
    pub claim: U128,
    /// Smallest volume that crosses.
    pub min_fill: U128,
    /// Price ceiling per claimed token; also values the holder's bond.
    pub max_price: U128,
    pub window: RoundWindow,
}

#[near]
impl Contract {
    /// Creates a Tender: the caller is the issuer, escrows `budget + fee(budget)` of its cash
    /// in `venue` and attaches `ROUND_STORAGE_DEPOSIT`. Returns the round id.
    #[payable]
    pub fn create_tender(&mut self, params: TenderParams) -> U64 {
        require!(params.budget.0 > 0, "Budget must be positive");
        let chain = self.class(&params.class_id).chain;
        require!(
            foreign_address_valid(chain, &params.retire_to),
            "retire_to must be a lowercase 0x address (Base) or a 32-byte base58 key (Solana)"
        );
        require!(
            !self.is_engine_address(chain, &params.retire_to),
            "retire_to must not be RoseVault or one of the engine's own keys: tokens sent there would sit outside every record"
        );
        let fee =
            clearing::fee(params.budget.0).unwrap_or_else(|_| env::panic_str("Budget too large"));
        let escrow = params
            .budget
            .0
            .checked_add(fee)
            .unwrap_or_else(|| env::panic_str("Budget too large"));
        let creator = env::predecessor_account_id();
        let round_id = self.create_round(
            RoundKind::Tender,
            params.class_id,
            params.venue.clone(),
            params.max_price.0,
            params.reference_price.map(|p| p.0),
            params.window,
            Some(TenderTerms {
                budget: params.budget.0,
                escrow,
                retire_to: params.retire_to,
            }),
            None,
        );
        self.debit_cash(&creator, &params.venue, escrow);
        U64(round_id)
    }

    /// Creates an Exit round over `class_id`. Anyone; attaches `ROUND_STORAGE_DEPOSIT`. Returns
    /// the round id.
    #[payable]
    pub fn create_exit(&mut self, params: ExitParams) -> U64 {
        let round_id = self.create_round(
            RoundKind::Exit,
            params.class_id,
            params.venue,
            params.max_price.0,
            None,
            params.window,
            None,
            None,
        );
        U64(round_id)
    }

    /// Creates an Advance: the caller encumbers `units` of its holding until the round ends and
    /// sells a senior claim on their first `claim` unlocked tokens. The caller places its sealed
    /// reserve with `place_ask(round, ciphertext, claim)`. Attaches `ROUND_STORAGE_DEPOSIT`.
    /// Returns the round id.
    #[payable]
    pub fn create_advance(&mut self, params: AdvanceParams) -> U64 {
        require!(params.units.0 > 0, "Units must be positive");
        require!(params.claim.0 > 0, "Claim must be positive");
        require!(
            params.min_fill.0 <= params.claim.0,
            "min_fill exceeds the claim"
        );
        let creator = env::predecessor_account_id();
        let f_now = self.fraction_now(&params.class_id);
        let round_id = self.create_round(
            RoundKind::Advance,
            params.class_id.clone(),
            params.venue,
            params.max_price.0,
            None,
            params.window,
            None,
            Some(AdvanceTerms {
                units: params.units.0,
                claim: params.claim.0,
                min_fill: params.min_fill.0,
                lock: Some(Lock::new(params.units.0, f_now)),
                ask_bid: None,
                lien_id: None,
            }),
        );
        let f_ts = self.round(round_id).f_ts;
        let max_claim = math::mul_div_floor(params.units.0, ONE - f_ts, ONE)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        require!(
            params.claim.0 <= max_claim,
            "Claim exceeds the tokens still locked at the close time"
        );
        self.debit_holding(
            &Holder::Account(creator.clone()),
            &params.class_id,
            params.units.0,
            f_now,
        );
        self.index_mut(&creator).advances.push(round_id);
        U64(round_id)
    }

    /// Cancels a round before its first bid. Only the creator, never after `closes_at`. Refunds
    /// the issuer escrow (Tender), returns the encumbered units (Advance) and the storage deposit.
    pub fn cancel_round(&mut self, round_id: U64) {
        let round = self.round(round_id.0).clone();
        require!(
            round.creator == env::predecessor_account_id(),
            "Only the creator can cancel"
        );
        require!(round.phase == Phase::Bidding, "Round is not open");
        require!(
            env::block_timestamp() < round.closes_at,
            "Round already closed"
        );
        require!(round.bid_count == 0, "Round already has bids");
        self.cancel(round_id.0, CancelReason::Creator);
    }

    /// Places a sealed bid (buy side) in an Exit or Advance round. `ciphertext_hex` is the
    /// 192-byte IBE ciphertext of `(quantity, limit_price, salt)` encrypted to the round
    /// identity and bound to `(round_id, caller, side = Buy)`. `escrow` cash base units are taken
    /// from the caller's cash in the round venue, plus the bond `max(1 USDC, 1% of escrow)`.
    /// Attaches `BID_STORAGE_DEPOSIT`, refunded when the bid settles. One bid per account per
    /// round. Returns the bid id.
    #[payable]
    pub fn place_bid(&mut self, round_id: U64, ciphertext_hex: String, escrow: U128) -> u32 {
        require!(escrow.0 > 0, "Escrow must be positive");
        let ciphertext = decode_ciphertext(&ciphertext_hex);
        let bidder = env::predecessor_account_id();
        let round = self.open_round_for_order(round_id.0, &bidder, Side::Buy);
        require!(
            round.kind != RoundKind::Tender,
            "A Tender has one buyer, the issuer"
        );
        if round.kind == RoundKind::Exit {
            require!(
                self.is_registered(&bidder),
                "Exit buyers receive units: call storage_deposit first"
            );
        }
        let bond = (escrow.0 / 100).max(ONE_USDC);
        let total = escrow
            .0
            .checked_add(bond)
            .unwrap_or_else(|| env::panic_str("Escrow too large"));
        self.debit_cash(&bidder, &round.venue, total);
        self.store_order(
            round_id.0,
            bidder,
            Side::Buy,
            ciphertext,
            escrow.0,
            None,
            bond,
        )
    }

    /// Places a sealed ask (sell side). Tender or Exit: locks `units` of the caller's holding
    /// into the round (they keep accruing to the caller until `closes_at`); the sealed quantity
    /// must not exceed them. Advance: only the creator, `units` must equal the claim, and the
    /// sealed quantity must equal the claim. The bond `max(1 USDC, 1% of the units valued at
    /// max_price)` is taken from the caller's cash in the round venue. Attaches
    /// `BID_STORAGE_DEPOSIT`, refunded when the bid settles. One ask per account per round.
    /// Returns the bid id.
    #[payable]
    pub fn place_ask(&mut self, round_id: U64, ciphertext_hex: String, units: U128) -> u32 {
        require!(units.0 > 0, "Units must be positive");
        let ciphertext = decode_ciphertext(&ciphertext_hex);
        let seller = env::predecessor_account_id();
        let round = self.open_round_for_order(round_id.0, &seller, Side::Sell);
        let pricing = round_pricing(&round);
        let valuation = pricing
            .charge(units.0, round.max_price)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        let bond = (valuation / 100).max(ONE_USDC);
        let lock = match round.kind {
            RoundKind::Advance => {
                require!(
                    seller == round.creator,
                    "Only the Advance holder can place its reserve"
                );
                let terms = round.advance.as_ref().expect("advance terms");
                require!(
                    units.0 == terms.claim,
                    "An Advance ask covers exactly the claim"
                );
                None
            }
            RoundKind::Tender | RoundKind::Exit => {
                require!(
                    seller != round.creator || round.kind == RoundKind::Exit,
                    "The issuer cannot ask in its own Tender"
                );
                let f_now = self.fraction_now(&round.class_id);
                self.debit_holding(
                    &Holder::Account(seller.clone()),
                    &round.class_id,
                    units.0,
                    f_now,
                );
                Some(Lock::new(units.0, f_now))
            }
        };
        self.debit_cash(&seller, &round.venue, bond);
        let bid_id = self.store_order(round_id.0, seller, Side::Sell, ciphertext, 0, lock, bond);
        if round.kind == RoundKind::Advance {
            let terms = self
                .round_mut(round_id.0)
                .advance
                .as_mut()
                .expect("advance terms");
            terms.ask_bid = Some(bid_id);
        }
        bid_id
    }
}

impl Contract {
    /// Shared creation path: validates the window, the class and the venue, stores the round
    /// and takes the storage deposit.
    #[allow(clippy::too_many_arguments)]
    fn create_round(
        &mut self,
        kind: RoundKind,
        class_id: ClassId,
        venue: Venue,
        max_price: u128,
        reference_price: Option<u128>,
        window: RoundWindow,
        tender: Option<TenderTerms>,
        advance: Option<AdvanceTerms>,
    ) -> RoundId {
        require!(
            env::attached_deposit() >= ROUND_STORAGE_DEPOSIT,
            "Attach the round storage deposit (0.05 NEAR)"
        );
        require!(max_price > 0, "max_price must be positive");
        require!(self.venue_accepted(&venue), "Unsupported cash venue");
        let now = env::block_timestamp();
        let opens_at = window.opens_at.map_or(now, |t| t.0);
        let closes_at = window.closes_at.0;
        require!(closes_at > now, "closes_at must be in the future");
        require!(closes_at > opens_at, "closes_at must be after opens_at");
        let key_timeout = window
            .key_timeout
            .unwrap_or(self.config.default_key_timeout)
            .0;
        let reveal_window = window
            .reveal_window
            .unwrap_or(self.config.default_reveal_window)
            .0;
        require!(key_timeout > 0, "key_timeout must be positive");
        require!(reveal_window > 0, "reveal_window must be positive");
        let class = self.class(&class_id);
        let f_ts = class.schedule.fraction(secs_of(closes_at));
        require!(
            f_ts < ONE,
            "Class is fully unlocked at the close time: nothing locked to price"
        );
        let token_decimals = class.decimals;
        let schedule_end_secs = schedule_end(&class.schedule);
        let creator = env::predecessor_account_id();
        let round_id = self.next_round_id;
        self.next_round_id += 1;
        let round = Round {
            id: round_id,
            kind,
            class_id: class_id.clone(),
            venue: venue.clone(),
            creator: creator.clone(),
            opens_at,
            closes_at,
            key_timeout,
            reveal_window,
            max_price,
            reference_price,
            f_ts,
            schedule_end_secs,
            token_decimals,
            phase: Phase::Bidding,
            key: None,
            key_source: None,
            close_requested_at: None,
            close_requested_block: None,
            key_received_at: None,
            bid_count: 0,
            opened_count: 0,
            settled_count: 0,
            tender,
            advance,
            result: None,
            cancel_reason: None,
            storage_deposit: env::attached_deposit().as_yoctonear(),
            created_at: now,
            ended_at: None,
        };
        self.rounds.insert(round_id, round);
        self.emit(RoseEvent::RoundCreated {
            round_id: U64(round_id),
            kind,
            class_id,
            venue,
            creator,
            opens_at: U64(opens_at),
            closes_at: U64(closes_at),
            max_price: U128(max_price),
        });
        round_id
    }

    /// Checks that `round_id` accepts a new order by `bidder` on `side` and returns a copy of it.
    fn open_round_for_order(&self, round_id: RoundId, bidder: &AccountId, side: Side) -> Round {
        require!(
            env::attached_deposit() >= BID_STORAGE_DEPOSIT,
            "Attach the bid storage deposit (0.02 NEAR)"
        );
        let round = self.round(round_id).clone();
        let now = env::block_timestamp();
        require!(round.phase == Phase::Bidding, "Round is not open");
        require!(now >= round.opens_at, "Round has not opened yet");
        require!(now < round.closes_at, "Round is closed");
        require!(
            round.bid_count < MAX_BIDS_PER_ROUND,
            "Round is full (64 sealed orders)"
        );
        require!(
            !self
                .orders
                .contains_key(&(round_id, bidder.clone(), side.ad_byte())),
            "One sealed order per account and side per round"
        );
        round
    }

    #[allow(clippy::too_many_arguments)]
    fn store_order(
        &mut self,
        round_id: RoundId,
        bidder: AccountId,
        side: Side,
        ciphertext: Vec<u8>,
        escrow: u128,
        lock: Option<Lock>,
        bond: u128,
    ) -> BidId {
        let round = self.round_mut(round_id);
        let bid_id = round.bid_count;
        round.bid_count += 1;
        let locked_units = lock.map_or(0, |l| l.units);
        self.bids.insert(
            (round_id, bid_id),
            Bid {
                bidder: bidder.clone(),
                side,
                ciphertext,
                escrow,
                lock,
                bond,
                storage_deposit: env::attached_deposit().as_yoctonear(),
                opened: None,
                void: None,
                placed_at: env::block_timestamp(),
            },
        );
        self.orders
            .insert((round_id, bidder.clone(), side.ad_byte()), bid_id);
        self.index_mut(&bidder).bids.push((round_id, bid_id));
        self.emit(RoseEvent::BidPlaced {
            round_id: U64(round_id),
            bid_id,
            bidder,
            side,
            escrow: U128(escrow),
            locked_units: U128(locked_units),
            bond: U128(bond),
        });
        bid_id
    }

    /// Moves a live round to `Cancelled`: refunds the issuer escrow, returns the Advance units
    /// with their accrual and stores an empty result so every bid can be settled (refunded)
    /// individually. The round deposit stays with the record.
    pub(crate) fn cancel(&mut self, round_id: RoundId, reason: CancelReason) {
        let round = self.round(round_id).clone();
        if let Some(terms) = &round.tender {
            self.credit_cash(&round.creator, &round.venue, terms.escrow);
        }
        self.return_advance_units(round_id);
        let fills = self.outcomes_without_clearing(round_id, reason == CancelReason::NoCrossing);
        let round = self.round_mut(round_id);
        round.phase = Phase::Cancelled;
        round.cancel_reason = Some(reason);
        round.ended_at = Some(env::block_timestamp());
        round.result = Some(crate::types::RoundResult {
            price: U128(0),
            volume: U128(0),
            notional: U128(0),
            fee: U128(0),
            issuer_charged: U128(0),
            issuer_refund: U128(round.tender.as_ref().map_or(0, |t| t.escrow)),
            remaining_lock_secs: U64(remaining_lock_secs(round)),
            fills,
        });
        self.emit(RoseEvent::RoundCancelled {
            round_id: U64(round_id),
            reason,
        });
    }

    /// Returns the encumbered units of an Advance to its holder with their full accrual.
    pub(crate) fn return_advance_units(&mut self, round_id: RoundId) {
        let round = self.round(round_id).clone();
        let Some(lock) = round.advance.as_ref().and_then(|t| t.lock) else {
            return;
        };
        let f_now = self.fraction_now(&round.class_id);
        self.credit_holding(
            &Holder::Account(round.creator.clone()),
            &round.class_id,
            lock.units,
            f_now,
            lock.checkpoint,
        );
        let terms = self
            .round_mut(round_id)
            .advance
            .as_mut()
            .expect("advance terms");
        terms.lock = None;
        self.forget_advance(&round.creator, round_id);
    }

    /// Drops a round from its creator's list of live Advances.
    pub(crate) fn forget_advance(&mut self, creator: &AccountId, round_id: RoundId) {
        self.index_mut(creator)
            .advances
            .retain(|id| *id != round_id);
        self.prune_index(creator);
    }

    /// Status shown to users, derived from the stored phase and the block time.
    pub(crate) fn status_of(round: &Round, now: u64) -> RoundStatus {
        match round.phase {
            Phase::Bidding if now < round.opens_at => RoundStatus::Scheduled,
            Phase::Bidding => RoundStatus::Open,
            Phase::KeyRequested => RoundStatus::KeyRequested,
            Phase::Revealing if now < reveal_deadline(round) => RoundStatus::Revealing,
            Phase::Revealing => RoundStatus::Clearing,
            Phase::Settled => RoundStatus::Settled,
            Phase::Cancelled => RoundStatus::Cancelled,
        }
    }
}

/// Pricing of a round at its settlement time.
pub(crate) fn round_pricing(round: &Round) -> Pricing {
    match round.kind {
        RoundKind::Advance => Pricing::per_claimed_token(round.token_decimals),
        RoundKind::Tender | RoundKind::Exit => Pricing {
            locked_fraction_e18: ONE - round.f_ts,
            token_decimals: round.token_decimals,
        },
    }
}

/// End of the reveal window; `u64::MAX` while no key has arrived.
pub(crate) fn reveal_deadline(round: &Round) -> u64 {
    round
        .key_received_at
        .map_or(u64::MAX, |t| t.saturating_add(round.reveal_window))
}

/// Seconds between the settlement time and the end of the class schedule.
pub(crate) fn remaining_lock_secs(round: &Round) -> u64 {
    round
        .schedule_end_secs
        .saturating_sub(secs_of(round.closes_at))
}

/// True when `address` is a valid payout address on `chain`: a lowercase `0x` address on Base,
/// a base58 32-byte key on Solana.
impl Contract {
    /// True when `address` is RoseVault or one of the engine's derived foreign keys on `chain`.
    fn is_engine_address(&self, chain: Chain, address: &str) -> bool {
        let derived = self.config.derived_addresses.as_ref();
        match chain {
            Chain::Base => {
                address == self.config.rose_vault
                    || derived.is_some_and(|keys| keys.vault_base == address)
            }
            Chain::Solana => {
                derived.is_some_and(|keys| keys.vault_sol == address || keys.gas_sol == address)
            }
        }
    }
}

fn foreign_address_valid(chain: Chain, address: &str) -> bool {
    match chain {
        Chain::Base => crate::is_evm_address(address),
        Chain::Solana => bs58::decode(address)
            .into_vec()
            .is_ok_and(|bytes| bytes.len() == 32),
    }
}

/// The 192-byte ciphertext of a sealed order.
fn decode_ciphertext(ciphertext_hex: &str) -> Vec<u8> {
    let ciphertext =
        hex::decode(ciphertext_hex).unwrap_or_else(|_| env::panic_str("ciphertext_hex is not hex"));
    require!(
        ciphertext.len() == rose_ibe::CIPHERTEXT_LEN,
        "Ciphertext must be 192 bytes"
    );
    ciphertext
}

/// End of a class schedule, Unix seconds.
pub(crate) fn schedule_end(schedule: &ClassSchedule) -> u64 {
    match schedule {
        ClassSchedule::Linear(class) => class.end(),
        ClassSchedule::Stepped(class) => class.end(),
    }
}
