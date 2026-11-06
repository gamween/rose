//! Key release and verified openings (spec sections 5.1 and 5.2).
//!
//! The round key is the CKD identity key of `round/<id>` under the engine account. Exactly one
//! method requests it, `close`, guarded by `now >= closes_at`; its callback and the open
//! `submit_key` both check the key with one pairing check before storing it. Every opening is
//! fully verified on chain (`rose_ibe::host::verify_opening_host`, about 124 Tgas), so a
//! malformed ciphertext can be opened by nobody and is void after the window.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::{env, near, require, Gas, NearToken, Promise, PromiseError};
use rose_ibe::{AssociatedData, Plaintext, PLAINTEXT_LEN, SIGMA_LEN};

use crate::clearing;
use crate::rounds::{reveal_deadline, round_pricing};
use crate::types::{CancelReason, KeySource, Opened, Phase, RoundId, RoundKind, Side, VoidReason};
use crate::{Contract, ContractExt, RoseEvent};

/// Tgas attached to `request_app_private_key` (19 Tgas is the measured minimum).
const TGAS_CKD_REQUEST: u64 = 25;
/// Static Tgas of the CKD callback: 12.4 Tgas measured (unwrap plus pairing check), 20 Tgas
/// attached so a slower host never starves the callback that stores the key.
const TGAS_CKD_CALLBACK: u64 = 20;
/// Tgas `close` must still have when it creates the request and its callback: what both attach
/// and the fees of both receipts.
const TGAS_CKD_ROUND_TRIP: u64 =
    TGAS_CKD_REQUEST + TGAS_CKD_CALLBACK + 2 * crate::custody::TGAS_CALL_FEES;
const GAS_FOR_CKD_REQUEST: Gas = Gas::from_tgas(TGAS_CKD_REQUEST);
const GAS_FOR_CKD_CALLBACK: Gas = Gas::from_tgas(TGAS_CKD_CALLBACK);
/// Blocks a CKD request may stay in flight: the MPC yield times out after 200 blocks and the
/// callback runs right after. `cancel_no_key` waits for them, so the engine can never store a
/// key, nor open or clear anything, for a round already cancelled. The key itself may still
/// become public afterwards (a late MPC response is readable in its failed transaction): spec
/// 5.6 states this privacy-only consequence.
pub const KEY_REQUEST_FLIGHT_BLOCKS: u64 = 250;

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CkdArgs {
    request: CkdRequest,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct CkdRequest {
    derivation_path: String,
    app_public_key: AppPublicKey,
    domain_id: u64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
enum AppPublicKey {
    AppPublicKeyPV { pk1: String, pk2: String },
}

/// CKD output of the MPC contract.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CkdResponse {
    pub big_y: String,
    pub big_c: String,
}

#[near]
impl Contract {
    /// Requests the round key from the MPC (CKD, `AppPublicKeyPV` with the round's public
    /// scalar, 1 yoctoNEAR paid by the engine). Anyone, once `now >= closes_at`; callable again
    /// while no key has arrived (the key is deterministic) until `closes_at + key_timeout`, when
    /// the round becomes cancellable instead. A round without any sealed order is cancelled
    /// instead: there is nothing to reveal. Attach 80 Tgas: a call with less than 60 Tgas left
    /// for the request and its callback is refused before anything changes.
    pub fn close(&mut self, round_id: U64) -> Option<Promise> {
        let round = self.round(round_id.0).clone();
        require!(
            matches!(round.phase, Phase::Bidding | Phase::KeyRequested),
            "Round is not closable"
        );
        require!(
            env::block_timestamp() >= round.closes_at,
            "Round is still open"
        );
        require!(
            round.bid_count == 0
                || env::block_timestamp() < round.closes_at.saturating_add(round.key_timeout),
            "Key timeout reached: the round can only be cancelled (cancel_no_key)"
        );
        if round.bid_count == 0 {
            self.cancel(round_id.0, CancelReason::Empty);
            return None;
        }
        Self::require_mpc_reserve();
        let engine = env::current_account_id();
        let scalar = rose_ibe::app_scalar(engine.as_str(), round_id.0);
        let (pk1, pk2) = rose_ibe::host::app_public_key_pv_host(&scalar);
        let args = CkdArgs {
            request: CkdRequest {
                derivation_path: rose_ibe::round_path(round_id.0),
                app_public_key: AppPublicKey::AppPublicKeyPV {
                    pk1: rose_ibe::format_near_g1(&pk1),
                    pk2: rose_ibe::format_near_g2(&pk2),
                },
                domain_id: self.config.ckd_domain,
            },
        };
        crate::custody::require_gas_left(TGAS_CKD_ROUND_TRIP);
        {
            let round = self.round_mut(round_id.0);
            round.phase = Phase::KeyRequested;
            round.close_requested_at = Some(env::block_timestamp());
            round.close_requested_block = Some(env::block_height());
        }
        self.emit(RoseEvent::KeyRequested { round_id });
        Some(
            Promise::new(self.config.mpc_account.clone())
                .function_call(
                    "request_app_private_key".to_string(),
                    near_sdk::serde_json::to_vec(&args).expect("CKD args serialize"),
                    NearToken::from_yoctonear(1),
                    GAS_FOR_CKD_REQUEST,
                )
                .then(
                    Self::ext(engine)
                        .with_static_gas(GAS_FOR_CKD_CALLBACK)
                        .on_round_key(round_id),
                ),
        )
    }

    /// CKD callback: unwraps `(Y, C)` with the public scalar, verifies the key with one pairing
    /// check and starts the reveal window. Called by the contract itself. A failed or invalid
    /// response leaves the round in `KeyRequested` so `close` can be retried. A response that
    /// arrives once the round no longer waits for a key (cancelled by `cancel_no_key`, or a key
    /// already stored) is ignored.
    #[private]
    pub fn on_round_key(
        &mut self,
        round_id: U64,
        #[callback_result] result: Result<CkdResponse, PromiseError>,
    ) -> bool {
        if !self.expects_key(round_id.0) {
            self.emit(RoseEvent::KeyIgnored { round_id });
            return false;
        }
        let Ok(response) = result else {
            self.emit(RoseEvent::KeyRequestFailed { round_id });
            return false;
        };
        let engine = env::current_account_id();
        let scalar = rose_ibe::app_scalar(engine.as_str(), round_id.0);
        let unwrapped = rose_ibe::parse_near_g1_bytes(&response.big_y)
            .ok()
            .zip(rose_ibe::parse_near_g1_bytes(&response.big_c).ok())
            .and_then(|(y, c)| rose_ibe::host::ckd_unwrap_host(&scalar, &y, &c));
        match unwrapped {
            Some(key) if self.key_verifies(round_id.0, &key) => {
                self.store_key(round_id.0, key, KeySource::Callback);
                true
            }
            _ => {
                self.emit(RoseEvent::KeyRequestFailed { round_id });
                false
            }
        }
    }

    /// Stores the round key submitted by anyone (for example unwrapped off chain from the public
    /// MPC response after a lost callback), after one pairing check. Anyone, while the round is
    /// `KeyRequested` (a key can only exist once `close` asked the MPC for it).
    pub fn submit_key(&mut self, round_id: U64, key: String) {
        require!(
            self.expects_key(round_id.0),
            "Round does not expect a key: it must be closed and without a key"
        );
        let key = rose_ibe::parse_near_g1_bytes(&key)
            .unwrap_or_else(|_| env::panic_str("Key must be a bls12381g1:<base58> string"));
        require!(
            self.key_verifies(round_id.0, &key),
            "Key does not verify for this round"
        );
        self.store_key(round_id.0, key, KeySource::Submitted);
    }

    /// Cancels a round whose key has not arrived by `closes_at + key_timeout`, once no key
    /// request is in flight ([`KEY_REQUEST_FLIGHT_BLOCKS`] after the last `close`). Anyone.
    /// Every escrow, bond and locked unit becomes refundable through `settle_bid`.
    pub fn cancel_no_key(&mut self, round_id: U64) {
        let round = self.round(round_id.0).clone();
        require!(
            matches!(round.phase, Phase::Bidding | Phase::KeyRequested),
            "Round is not waiting for a key"
        );
        require!(round.key.is_none(), "Key already received");
        require!(
            env::block_timestamp() >= round.closes_at.saturating_add(round.key_timeout),
            "Key timeout not reached"
        );
        require!(
            round.close_requested_block.is_none_or(|block| {
                env::block_height() >= block.saturating_add(KEY_REQUEST_FLIGHT_BLOCKS)
            }),
            "A key request is in flight: cancel once it has resolved"
        );
        self.cancel(round_id.0, CancelReason::NoKey);
    }

    /// Opens a sealed order with its `(plaintext, sigma)` opening (48 and 32 bytes, hex). Anyone,
    /// during the reveal window. The identity, bidder and side come from the stored bid, never
    /// from the caller. The opening is fully verified; a valid opening whose values break the
    /// bid's collateral marks it void. Costs about 124 to 132 Tgas: attach 200 Tgas.
    pub fn open_bid(
        &mut self,
        round_id: U64,
        bid_id: u32,
        plaintext_hex: String,
        sigma_hex: String,
    ) {
        let round = self.round(round_id.0).clone();
        require!(round.phase == Phase::Revealing, "Round is not revealing");
        require!(
            env::block_timestamp() < reveal_deadline(&round),
            "Reveal window is over"
        );
        let key = round.key.expect("revealing rounds have a key");
        let bid = self
            .bids
            .get(&(round_id.0, bid_id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("Unknown bid"));
        require!(bid.opened.is_none(), "Bid already opened");
        let plaintext = decode_fixed::<PLAINTEXT_LEN>(&plaintext_hex, "plaintext");
        let sigma = decode_fixed::<SIGMA_LEN>(&sigma_hex, "sigma");
        let plaintext = Plaintext::from_bytes(&plaintext);
        let ad = AssociatedData {
            round_id: round_id.0,
            bidder: bid.bidder.as_str(),
            side: bid.side.ad_byte(),
        };
        let app_id = rose_ibe::round_app_id(env::current_account_id().as_str(), round_id.0);
        require!(
            rose_ibe::host::verify_opening_host(
                &app_id,
                &rose_ibe::host::VerifiedKey::from_stored(key),
                &bid.ciphertext,
                &ad,
                &plaintext,
                &sigma
            ),
            "Opening does not match the ciphertext"
        );
        let pricing = round_pricing(&round);
        let void = match bid.side {
            Side::Buy => {
                let supply = round
                    .max_buy_quantity
                    .expect("rounds taking buy orders fix their maximum quantity");
                let covered = pricing
                    .charge(plaintext.quantity, plaintext.limit_price)
                    .ok()
                    .and_then(|charge| clearing::fee(charge).ok().map(|fee| (charge, fee)))
                    .and_then(|(charge, fee)| charge.checked_add(fee))
                    .is_some_and(|total| total <= bid.escrow);
                if plaintext.quantity > supply {
                    Some(VoidReason::QuantityAboveSupply)
                } else if !covered {
                    Some(VoidReason::EscrowTooSmall)
                } else {
                    None
                }
            }
            Side::Sell if round.kind == RoundKind::Advance => {
                let claim = round.advance.as_ref().expect("advance terms").claim;
                (plaintext.quantity != claim).then_some(VoidReason::ClaimMismatch)
            }
            Side::Sell => {
                let locked = bid.lock.map_or(0, |l| l.units);
                (plaintext.quantity > locked).then_some(VoidReason::QuantityAboveLocked)
            }
        };
        let stored = self
            .bids
            .get_mut(&(round_id.0, bid_id))
            .expect("bid exists");
        stored.opened = Some(Opened {
            quantity: U128(plaintext.quantity),
            price: U128(plaintext.limit_price),
        });
        stored.void = void;
        self.round_mut(round_id.0).opened_count += 1;
        self.emit(RoseEvent::BidOpened {
            round_id,
            bid_id,
            quantity: U128(plaintext.quantity),
            price: U128(plaintext.limit_price),
            void,
        });
    }
}

impl Contract {
    fn key_verifies(&self, round_id: RoundId, key: &[u8; 48]) -> bool {
        let app_id = rose_ibe::round_app_id(env::current_account_id().as_str(), round_id);
        rose_ibe::host::verify_key_host(&self.ckd_public_key(), &app_id, key).is_some()
    }

    /// True while the round waits for its key: `KeyRequested` and no key stored.
    fn expects_key(&self, round_id: RoundId) -> bool {
        let round = self.round(round_id);
        round.phase == Phase::KeyRequested && round.key.is_none()
    }

    fn store_key(&mut self, round_id: RoundId, key: [u8; 48], source: KeySource) {
        require!(
            self.expects_key(round_id),
            "Round does not expect a key: it must be closed and without a key"
        );
        let round = self.round_mut(round_id);
        round.key = Some(key);
        round.key_source = Some(source);
        round.key_received_at = Some(env::block_timestamp());
        round.phase = Phase::Revealing;
        self.emit(RoseEvent::KeyReceived {
            round_id: U64(round_id),
            source,
            key: rose_ibe::format_near_g1_bytes(&key),
        });
    }
}

fn decode_fixed<const N: usize>(hex_value: &str, what: &str) -> [u8; N] {
    hex::decode(hex_value)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("{what} must be {N} bytes of hex")))
}
