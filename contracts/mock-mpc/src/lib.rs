//! Mock of the NEAR MPC contract (`v1.signer-prod.testnet`) for the rose engine sandbox tests.
//!
//! It replays responses that the tests record beforehand: derived public keys per
//! `(path, predecessor, domain)`, CKD outputs per derivation path, `verify_foreign_transaction`
//! responses per transaction id and `sign` responses per `(domain, path)`. It enforces the live
//! contract's call floors (15 Tgas and 1 yoctoNEAR) so an engine that under-attaches fails here
//! too. `set_fail_next` makes the next replayed call panic (a `PromiseError` for the engine) and
//! `set_ckd_delay` stretches the next CKD answer over several blocks, so a late callback can be
//! raced against `cancel_no_key`. The same contract also acts as a NEP-245 receiver whose
//! `mt_on_transfer` refunds the amount named in `msg`.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};

/// Gas the live contract requires on `sign`, `request_app_private_key` and
/// `verify_foreign_transaction`.
const MIN_CALL_GAS: Gas = Gas::from_tgas(15);
/// Deposit the live contract requires on the same calls.
const MIN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Static gas of one hop of a delayed CKD answer.
const GAS_PER_HOP: Gas = Gas::from_tgas(3);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Derived,
    PublicKeys,
    Ckd,
    Foreign,
    Sign,
}

/// A recorded CKD output.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CkdResponse {
    pub big_y: String,
    pub big_c: String,
}

/// The part of a `request_app_private_key` request the mock reads (the other fields are
/// ignored).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CkdRequest {
    pub derivation_path: String,
}

/// The part of a `verify_foreign_transaction` request the mock reads.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VerifyRequest {
    pub request: ChainRequest,
    pub domain_id: u64,
}

/// Transaction id of a ForeignTx request (extractors and finality are ignored).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum ChainRequest {
    Base { tx_id: String },
    Solana { tx_id: String },
}

/// The part of a `sign` request the mock reads (the payload is ignored).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub domain_id: u64,
}

/// The mock.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    derived: LookupMap<String, String>,
    public_keys: LookupMap<u64, String>,
    ckd: LookupMap<String, CkdResponse>,
    foreign: LookupMap<String, String>,
    sign: LookupMap<String, String>,
    fail_next: bool,
    ckd_delay_hops: u8,
}

#[near]
impl MockMpc {
    /// Empty mock.
    #[init]
    pub fn new() -> Self {
        Self {
            derived: LookupMap::new(StorageKey::Derived),
            public_keys: LookupMap::new(StorageKey::PublicKeys),
            ckd: LookupMap::new(StorageKey::Ckd),
            foreign: LookupMap::new(StorageKey::Foreign),
            sign: LookupMap::new(StorageKey::Sign),
            fail_next: false,
            ckd_delay_hops: 0,
        }
    }

    /// Records the key `derived_public_key(path, predecessor, domain_id)` returns.
    pub fn set_derived_key(
        &mut self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
        key: String,
    ) {
        self.derived
            .insert(derived_key(&path, &predecessor, domain_id), key);
    }

    /// The recorded derived key, as the live contract's view returns it.
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
    ) -> String {
        self.derived
            .get(&derived_key(&path, &predecessor, domain_id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recorded derived key"))
    }

    /// Records the master public key of a domain.
    pub fn set_public_key(&mut self, domain_id: u64, key: String) {
        self.public_keys.insert(domain_id, key);
    }

    /// The recorded master public key of a domain.
    pub fn public_key(&self, domain_id: u64) -> String {
        self.public_keys
            .get(&domain_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recorded public key"))
    }

    /// Records the CKD output returned for `path`.
    pub fn set_ckd_response(&mut self, path: String, big_y: String, big_c: String) {
        self.ckd.insert(path, CkdResponse { big_y, big_c });
    }

    /// Makes the next CKD answer travel through `hops` extra receipts (one block each).
    pub fn set_ckd_delay(&mut self, hops: u8) {
        self.ckd_delay_hops = hops;
    }

    /// Makes the next replayed call (CKD, ForeignTx or sign) panic.
    pub fn set_fail_next(&mut self) {
        self.fail_next = true;
    }

    /// Replays the recorded CKD output for the request's derivation path.
    #[payable]
    pub fn request_app_private_key(&mut self, request: CkdRequest) -> PromiseOrValue<CkdResponse> {
        self.check_floors();
        let response = self
            .ckd
            .get(&request.derivation_path)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recorded response"));
        let hops = self.ckd_delay_hops;
        self.ckd_delay_hops = 0;
        if hops == 0 {
            PromiseOrValue::Value(response)
        } else {
            PromiseOrValue::Promise(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_PER_HOP)
                    .ckd_hop(hops - 1, response),
            )
        }
    }

    /// One hop of a delayed CKD answer.
    #[private]
    pub fn ckd_hop(&mut self, remaining: u8, response: CkdResponse) -> PromiseOrValue<CkdResponse> {
        if remaining == 0 {
            PromiseOrValue::Value(response)
        } else {
            PromiseOrValue::Promise(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_PER_HOP)
                    .ckd_hop(remaining - 1, response),
            )
        }
    }

    /// Records the JSON response returned for a ForeignTx request on `tx_id` (hex, any case,
    /// with or without `0x`).
    pub fn set_foreign_response(&mut self, tx_id: String, response: String) {
        self.foreign.insert(normalize_hex(&tx_id), response);
    }

    /// Replays the recorded `verify_foreign_transaction` response, returned as raw JSON.
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: VerifyRequest) {
        self.check_floors();
        let tx_id = match &request.request {
            ChainRequest::Base { tx_id } | ChainRequest::Solana { tx_id } => tx_id,
        };
        let response = self
            .foreign
            .get(&normalize_hex(tx_id))
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recorded response"));
        env::value_return(response.as_bytes());
    }

    /// Records the JSON response returned for `sign` requests on `(domain_id, path)`.
    pub fn set_sign_response(&mut self, domain_id: u64, path: String, response: String) {
        self.sign.insert(sign_key(domain_id, &path), response);
    }

    /// Replays the recorded `sign` response, returned as raw JSON.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) {
        self.check_floors();
        let response = self
            .sign
            .get(&sign_key(request.domain_id, &request.path))
            .cloned()
            .unwrap_or_else(|| env::panic_str("no recorded response"));
        env::value_return(response.as_bytes());
    }

    /// NEP-245 receiver: refunds the amount named in `msg` as `refund:<amount>` for every token,
    /// nothing otherwise.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        require!(
            previous_owner_ids.len() == token_ids.len() && amounts.len() == token_ids.len(),
            "Mismatched batch"
        );
        env::log_str(&format!("mt_on_transfer from {sender_id}: {msg}"));
        let refund = msg
            .strip_prefix("refund:")
            .map(|amount| amount.parse::<u128>().unwrap_or_default())
            .unwrap_or(0);
        PromiseOrValue::Value(
            amounts
                .iter()
                .map(|amount| U128(refund.min(amount.0)))
                .collect(),
        )
    }
}

impl MockMpc {
    /// The live contract's floors, then the one-shot failure.
    fn check_floors(&mut self) {
        require!(
            env::prepaid_gas() >= MIN_CALL_GAS,
            format!(
                "Provided gas is lower than required. Provided: {}, required: {}",
                env::prepaid_gas().as_gas(),
                MIN_CALL_GAS.as_gas()
            )
        );
        require!(
            env::attached_deposit() >= MIN_DEPOSIT,
            "Attached deposit is lower than required"
        );
        if self.fail_next {
            self.fail_next = false;
            env::panic_str("Request has timed out.");
        }
    }
}

fn derived_key(path: &str, predecessor: &AccountId, domain_id: u64) -> String {
    format!("{domain_id}:{predecessor}:{path}")
}

fn sign_key(domain_id: u64, path: &str) -> String {
    format!("{domain_id}:{path}")
}

fn normalize_hex(value: &str) -> String {
    value
        .strip_prefix("0x")
        .unwrap_or(value)
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_engine_request_shapes() {
        // The engine sends `{"request": <value>}`: the method parameter `request` receives the
        // value, whose extra fields are ignored.
        let foreign = r#"{"request":{"Base":{"tx_id":"ab","extractors":[{"Log":{"log_index":2}}],"finality":"Safe"}},"domain_id":3,"payload_version":1}"#;
        let request: VerifyRequest = near_sdk::serde_json::from_str(foreign).unwrap();
        assert!(matches!(request.request, ChainRequest::Base { ref tx_id } if tx_id == "ab"));
        assert_eq!(request.domain_id, 3);
        let sign = r#"{"path":"vault/base","payload_v2":{"Ecdsa":"00"},"domain_id":0}"#;
        let request: SignRequest = near_sdk::serde_json::from_str(sign).unwrap();
        assert_eq!(request.path, "vault/base");
        let ckd = r#"{"derivation_path":"round/1","app_public_key":{"AppPublicKeyPV":{"pk1":"a","pk2":"b"}},"domain_id":2}"#;
        let request: CkdRequest = near_sdk::serde_json::from_str(ckd).unwrap();
        assert_eq!(request.derivation_path, "round/1");
    }
}
