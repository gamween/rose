//! NEP-297 events of the custody wiring, logged under the engine's `rose` standard.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

use super::types::ReplayKey;
use crate::events::{log_event, EVENT_STANDARD, EVENT_VERSION};
use crate::types::{Chain, ClassId};

/// A custody event. Serialized as `{"event": "<snake_case variant>", "data": {...}}`.
#[near(serializers = [json])]
#[serde(tag = "event", content = "data", rename_all = "snake_case")]
#[derive(Clone, Debug)]
pub enum CustodyEvent {
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
    DepositMismatch {
        key: ReplayKey,
    },
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
        round_id: u64,
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
}

/// Logs a custody event.
pub fn emit(event: CustodyEvent) {
    log_event(EVENT_STANDARD, EVENT_VERSION, &event);
}
