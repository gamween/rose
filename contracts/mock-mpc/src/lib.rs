//! Mock of the NEAR MPC contract (`v1.signer-prod.testnet`) for the rose engine sandbox tests.
//!
//! It signs what it is asked to sign. Every derived key comes from one fixed test seed:
//! `derived_public_key(path, predecessor, domain)` and `sign` (for the calling contract) use the
//! secret `sha256(seed || domain || predecessor || 0 || path)`, a secp256k1 key on domain 0 and an
//! Ed25519 key on domain 1, so the engine's bootstrapped addresses and every signature it stores
//! verify against each other exactly as with the live network. `verify_foreign_transaction`
//! signs, with the domain-3 test key, the payload hash the test registered for that exact
//! request (the nodes would compute it from their own RPC reads, which a sandbox has no access
//! to); a request nobody registered fails like a live request that times out.
//!
//! Replays of real recorded traffic stay possible and exact: a recorded derived key or CKD output
//! replaces the computed one, a recorded `sign` response is returned only for the very payload it
//! was recorded over, and a recorded ForeignTx response only for the transaction id it was
//! recorded for. It enforces the live contract's call floors (15 Tgas and 1 yoctoNEAR) so an
//! engine that under-attaches fails here too, and the request checks of `near/mpc` 3.18.0 that a
//! malformed engine request would meet live: a CKD request must name the CKD domain and carry an
//! `AppPublicKeyPV` whose `e(pk1, G2) == e(G1, pk2)` (`app_public_key_check`, the variant the
//! engine sends), a ForeignTx request payload version 1, and an `Eddsa` payload at most 1,232
//! bytes. `set_fail_next` makes the next call panic (a
//! `PromiseError` for the engine) and `set_ckd_delay` stretches the next CKD answer over several
//! blocks. The same contract also acts as a NEP-245 receiver whose `mt_on_transfer` refunds the
//! amount named in `msg`.
//!
//! It does not model the live network's timing: it answers `sign` and `verify_foreign_transaction`
//! in the same block, never lets a request time out after the 200-block yield, and never delivers
//! a late second response. The engine's handling of those (a `PromiseError` after a timeout, a
//! callback for a payout that moved on) is covered by the mocked-VM unit tests, not by the
//! sandbox.

use ed25519_dalek::Signer;
use k256::ecdsa::SigningKey as EcdsaKey;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};
use sha2::{Digest, Sha256};

/// Gas the live contract requires on `sign`, `request_app_private_key` and
/// `verify_foreign_transaction`.
const MIN_CALL_GAS: Gas = Gas::from_tgas(15);
/// Deposit the live contract requires on the same calls.
const MIN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// Static gas of one hop of a delayed CKD answer.
const GAS_PER_HOP: Gas = Gas::from_tgas(3);
/// Domains of `v1.signer-prod.testnet`: secp256k1 signatures, Ed25519 signatures, CKD,
/// ForeignTx.
pub const DOMAIN_SECP256K1: u64 = 0;
pub const DOMAIN_ED25519: u64 = 1;
pub const DOMAIN_CKD: u64 = 2;
pub const DOMAIN_FOREIGN_TX: u64 = 3;
/// The only ForeignTx payload version (`ForeignTxPayloadVersion::V1`).
pub const FOREIGN_TX_PAYLOAD_VERSION: u8 = 1;
/// Largest `Eddsa` payload (`EDDSA_PAYLOAD_SIZE_UPPER_BOUND_BYTES`, one Solana packet).
pub const EDDSA_PAYLOAD_MAX_BYTES: usize = 1232;
/// Uncompressed G1 generator and negated G2 generator, as `crates/contract/src/primitives/ckd.rs`
/// of `near/mpc` 3.18.0 pairs them in `app_public_key_check`.
const G1_GENERATOR_UNCOMPRESSED: [u8; 96] = [
    23, 241, 211, 167, 49, 151, 215, 148, 38, 149, 99, 140, 79, 169, 172, 15, 195, 104, 140, 79,
    151, 116, 185, 5, 161, 78, 58, 63, 23, 27, 172, 88, 108, 85, 232, 63, 249, 122, 26, 239, 251,
    58, 240, 10, 219, 34, 198, 187, 8, 179, 244, 129, 227, 170, 160, 241, 160, 158, 48, 237, 116,
    29, 138, 228, 252, 245, 224, 149, 213, 208, 10, 246, 0, 219, 24, 203, 44, 4, 179, 237, 208, 60,
    199, 68, 162, 136, 138, 228, 12, 170, 35, 41, 70, 197, 231, 225,
];
const MINUS_G2_GENERATOR_UNCOMPRESSED: [u8; 192] = [
    19, 224, 43, 96, 82, 113, 159, 96, 125, 172, 211, 160, 136, 39, 79, 101, 89, 107, 208, 208,
    153, 32, 182, 26, 181, 218, 97, 187, 220, 127, 80, 73, 51, 76, 241, 18, 19, 148, 93, 87, 229,
    172, 125, 5, 93, 4, 43, 126, 2, 74, 162, 178, 240, 143, 10, 145, 38, 8, 5, 39, 45, 197, 16, 81,
    198, 228, 122, 212, 250, 64, 59, 2, 180, 81, 11, 100, 122, 227, 209, 119, 11, 172, 3, 38, 168,
    5, 187, 239, 212, 128, 86, 200, 193, 33, 189, 184, 19, 250, 77, 74, 10, 216, 177, 206, 24, 110,
    213, 6, 23, 137, 33, 61, 153, 57, 35, 6, 109, 221, 175, 16, 64, 188, 63, 245, 159, 130, 92,
    120, 223, 116, 242, 215, 84, 103, 226, 94, 15, 85, 248, 160, 15, 160, 48, 237, 13, 27, 60, 194,
    199, 2, 120, 136, 190, 81, 217, 239, 105, 29, 119, 188, 182, 121, 175, 218, 102, 199, 63, 23,
    249, 238, 56, 55, 165, 80, 36, 247, 140, 113, 54, 50, 117, 167, 93, 117, 216, 107, 171, 121,
    247, 71, 130, 170,
];
/// The secp256k1 group order `n`, big-endian: the live contract refuses ECDSA payloads >= n.
const SECP256K1_ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
/// Seed of every key the mock derives.
const TEST_SEED: &[u8] = b"rose mock mpc test key";
/// Predecessor of the ForeignTx key (the domain key itself, not a per-account derivation).
const FOREIGN_TX_ROOT: &str = "foreign-tx.mock";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Derived,
    PublicKeys,
    Ckd,
    Foreign,
    ForeignHashes,
    Sign,
}

/// A recorded CKD output.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CkdResponse {
    pub big_y: String,
    pub big_c: String,
}

/// A `request_app_private_key` request: the path, the key the response is encrypted to and the
/// domain.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CkdRequest {
    pub derivation_path: String,
    pub app_public_key: CkdAppPublicKey,
    pub domain_id: u64,
}

/// The `AppPublicKeyPV` variant of `CKDAppPublicKey`: `pk1 = a * G1` and `pk2 = a * G2`, as
/// `bls12381g1:<base58>` and `bls12381g2:<base58>`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum CkdAppPublicKey {
    AppPublicKeyPV { pk1: String, pk2: String },
}

/// A `verify_foreign_transaction` request: the foreign request as the engine sent it, the
/// domain and the payload version.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VerifyRequest {
    pub request: Value,
    pub domain_id: u64,
    pub payload_version: u8,
}

/// A `sign` request: the path, the payload (`{"Ecdsa": hex}` or `{"Eddsa": hex}`) and the domain.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Value,
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
    foreign_hashes: LookupMap<String, String>,
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
            foreign_hashes: LookupMap::new(StorageKey::ForeignHashes),
            sign: LookupMap::new(StorageKey::Sign),
            fail_next: false,
            ckd_delay_hops: 0,
        }
    }

    /// Records the key `derived_public_key(path, predecessor, domain_id)` returns instead of the
    /// computed one (replays of a real account's keys).
    pub fn set_derived_key(
        &mut self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
        key: String,
    ) {
        self.derived
            .insert(derived_key(&path, predecessor.as_str(), domain_id), key);
    }

    /// The derived key of `(path, predecessor, domain_id)`, in the live view's format
    /// (`secp256k1:<base58 x||y>` or `ed25519:<base58>`).
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
    ) -> String {
        if let Some(recorded) =
            self.derived
                .get(&derived_key(&path, predecessor.as_str(), domain_id))
        {
            return recorded.clone();
        }
        let secret = derived_secret(domain_id, predecessor.as_str(), &path);
        match domain_id {
            DOMAIN_SECP256K1 => secp256k1_public_key(&secret),
            DOMAIN_ED25519 => format!(
                "ed25519:{}",
                bs58::encode(ed25519_key(&secret).verifying_key().to_bytes()).into_string()
            ),
            _ => env::panic_str("no key derivation on this domain"),
        }
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

    /// Makes the next CKD, ForeignTx or sign call panic.
    pub fn set_fail_next(&mut self) {
        self.fail_next = true;
    }

    /// Replays the recorded CKD output for the request's derivation path.
    #[payable]
    pub fn request_app_private_key(&mut self, request: CkdRequest) -> PromiseOrValue<CkdResponse> {
        self.check_floors();
        require!(request.domain_id == DOMAIN_CKD, "not the CKD domain");
        let CkdAppPublicKey::AppPublicKeyPV { pk1, pk2 } = &request.app_public_key;
        require!(
            app_public_key_check(pk1, pk2),
            "app public key check failed"
        );
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
    /// with or without `0x`): a real recorded response.
    pub fn set_foreign_response(&mut self, tx_id: String, response: String) {
        self.foreign.insert(normalize_hex(&tx_id), response);
    }

    /// Registers the payload hash (hex) the nodes would sign for `request` (the engine's foreign
    /// request, as JSON): the mock answers that request with this hash signed by the domain-3
    /// test key.
    pub fn set_foreign_payload(&mut self, request: Value, payload_hash: String) {
        self.foreign_hashes
            .insert(request_key(&request), normalize_hex(&payload_hash));
    }

    /// Answers a `verify_foreign_transaction`: the registered payload hash of this exact request
    /// signed by the domain-3 test key, else the response recorded for its transaction id.
    #[payable]
    pub fn verify_foreign_transaction(&mut self, request: VerifyRequest) {
        self.check_floors();
        require!(
            request.domain_id == DOMAIN_FOREIGN_TX,
            "not the ForeignTx domain"
        );
        require!(
            request.payload_version == FOREIGN_TX_PAYLOAD_VERSION,
            "unknown ForeignTx payload version"
        );
        let response = match self.foreign_hashes.get(&request_key(&request.request)) {
            Some(hash) => {
                let digest: [u8; 32] = hex::decode(hash)
                    .ok()
                    .and_then(|bytes| bytes.try_into().ok())
                    .unwrap_or_else(|| env::panic_str("registered hash is not 32 bytes"));
                let secret = derived_secret(DOMAIN_FOREIGN_TX, FOREIGN_TX_ROOT, "");
                json!({
                    "payload_hash": hash,
                    "signature": secp256k1_signature(&secret, &digest),
                })
                .to_string()
            }
            None => {
                let tx_id = request
                    .request
                    .as_object()
                    .and_then(|chain| chain.values().next())
                    .and_then(|body| body["tx_id"].as_str())
                    .map(normalize_hex)
                    .unwrap_or_default();
                self.foreign
                    .get(&tx_id)
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("no response for this request"))
            }
        };
        env::value_return(response.as_bytes());
    }

    /// Records the JSON response returned for `sign` on `(domain_id, path)` over exactly
    /// `payload` (hex): a real recorded response.
    pub fn set_sign_response(
        &mut self,
        domain_id: u64,
        path: String,
        payload: String,
        response: String,
    ) {
        self.sign.insert(
            sign_key(domain_id, &path, &normalize_hex(&payload)),
            response,
        );
    }

    /// Signs the payload with the key derived for the calling contract and `path` (a recorded
    /// response replaces it only when it was recorded over this very payload).
    #[payable]
    pub fn sign(&mut self, request: SignRequest) {
        self.check_floors();
        let (scheme, payload) = request
            .payload_v2
            .as_object()
            .and_then(|object| object.iter().next())
            .and_then(|(scheme, payload)| Some((scheme.clone(), payload.as_str()?.to_string())))
            .unwrap_or_else(|| env::panic_str("payload_v2 must be {\"Ecdsa\"|\"Eddsa\": hex}"));
        let payload = normalize_hex(&payload);
        require!(
            scheme != "Eddsa" || payload.len() <= 2 * EDDSA_PAYLOAD_MAX_BYTES,
            "Eddsa payload exceeds 1232 bytes"
        );
        if let Some(recorded) = self
            .sign
            .get(&sign_key(request.domain_id, &request.path, &payload))
        {
            env::value_return(recorded.as_bytes());
            return;
        }
        let bytes = hex::decode(&payload).unwrap_or_else(|_| env::panic_str("payload is not hex"));
        let secret = derived_secret(
            request.domain_id,
            env::predecessor_account_id().as_str(),
            &request.path,
        );
        let response = match (scheme.as_str(), request.domain_id) {
            ("Ecdsa", DOMAIN_SECP256K1) => {
                let digest: [u8; 32] = bytes
                    .try_into()
                    .unwrap_or_else(|_| env::panic_str("Ecdsa payload must be 32 bytes"));
                require!(
                    digest < SECP256K1_ORDER,
                    "Ecdsa payload must be below the secp256k1 group order"
                );
                secp256k1_signature(&secret, &digest)
            }
            ("Eddsa", DOMAIN_ED25519) => json!({
                "scheme": "Ed25519",
                "signature": ed25519_key(&secret).sign(&bytes).to_bytes().to_vec(),
            }),
            _ => env::panic_str("payload scheme does not match the domain"),
        };
        env::value_return(response.to_string().as_bytes());
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

/// `app_public_key_check` of `near/mpc` 3.18.0: `e(pk1, G2) == e(G1, pk2)` through the host, the
/// decompressions checking the curve and the pairing check the subgroups. A malformed point
/// panics as it does live.
fn app_public_key_check(pk1: &str, pk2: &str) -> bool {
    let pk1: [u8; 48] = bls_bytes(pk1, "bls12381g1:");
    let pk2: [u8; 96] = bls_bytes(pk2, "bls12381g2:");
    let pk1 = env::bls12381_p1_decompress(pk1)
        .unwrap_or_else(|| env::panic_str("malformed BLS12-381 G1 point"));
    let pk2 = env::bls12381_p2_decompress(pk2)
        .unwrap_or_else(|| env::panic_str("malformed BLS12-381 G2 point"));
    let input = [
        pk1.as_slice(),
        MINUS_G2_GENERATOR_UNCOMPRESSED.as_slice(),
        G1_GENERATOR_UNCOMPRESSED.as_slice(),
        pk2.as_slice(),
    ]
    .concat();
    env::bls12381_pairing_check(&input).unwrap_or(false)
}

/// The bytes of a `<prefix><base58>` BLS key of exactly `N` bytes.
fn bls_bytes<const N: usize>(key: &str, prefix: &str) -> [u8; N] {
    key.strip_prefix(prefix)
        .and_then(|encoded| bs58::decode(encoded).into_vec().ok())
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::panic_str(&format!("app public key is not a {prefix} key")))
}

/// The test secret of `(domain, predecessor, path)`.
pub fn derived_secret(domain_id: u64, predecessor: &str, path: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TEST_SEED);
    hasher.update(domain_id.to_le_bytes());
    hasher.update(predecessor.as_bytes());
    hasher.update([0u8]);
    hasher.update(path.as_bytes());
    hasher.finalize().into()
}

/// The Ed25519 key of a test secret.
pub fn ed25519_key(secret: &[u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(secret)
}

/// The secp256k1 key of a test secret (a SHA-256 output is a valid scalar except with
/// probability about `2^-128`).
pub fn secp256k1_key(secret: &[u8; 32]) -> EcdsaKey {
    EcdsaKey::from_bytes(secret.into()).unwrap_or_else(|_| env::panic_str("invalid test scalar"))
}

/// `secp256k1:<base58 of the uncompressed x || y>` of a test secret.
pub fn secp256k1_public_key(secret: &[u8; 32]) -> String {
    let point = secp256k1_key(secret)
        .verifying_key()
        .to_encoded_point(false);
    format!(
        "secp256k1:{}",
        bs58::encode(&point.as_bytes()[1..]).into_string()
    )
}

/// A secp256k1 signature of `digest` in the live response format: low `s`, `big_r` compressed,
/// the recovery id.
pub fn secp256k1_signature(secret: &[u8; 32], digest: &[u8; 32]) -> Value {
    let (signature, recovery) = secp256k1_key(secret)
        .sign_prehash_recoverable(digest)
        .unwrap_or_else(|_| env::panic_str("signing failed"));
    let bytes = signature.to_bytes();
    let mut big_r = vec![0x02 | u8::from(recovery.is_y_odd())];
    big_r.extend_from_slice(&bytes[..32]);
    json!({
        "scheme": "Secp256k1",
        "big_r": { "affine_point": hex::encode(big_r) },
        "s": { "scalar": hex::encode(&bytes[32..]) },
        "recovery_id": recovery.to_byte(),
    })
}

/// The key of a foreign request: the hex SHA-256 of its JSON with sorted keys.
pub fn request_key(request: &Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_string(&sorted(request))
            .unwrap_or_default()
            .as_bytes(),
    ))
}

/// `value` with every object's keys sorted, so the key does not depend on field order.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn derived_key(path: &str, predecessor: &str, domain_id: u64) -> String {
    format!("{domain_id}:{predecessor}:{path}")
}

fn sign_key(domain_id: u64, path: &str, payload: &str) -> String {
    format!(
        "{domain_id}:{path}:{}",
        hex::encode(Sha256::digest(payload.as_bytes()))
    )
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
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    #[test]
    fn reads_the_engine_request_shapes() {
        // The engine sends `{"request": <value>}`: the method parameter `request` receives the
        // value.
        let foreign = r#"{"request":{"Base":{"tx_id":"ab","extractors":[{"Log":{"log_index":2}}],"finality":"Safe"}},"domain_id":3,"payload_version":1}"#;
        let request: VerifyRequest = serde_json::from_str(foreign).unwrap();
        assert_eq!(request.request["Base"]["tx_id"], "ab");
        assert_eq!(request.domain_id, 3);
        let sign = r#"{"path":"vault/base","payload_v2":{"Ecdsa":"00"},"domain_id":0}"#;
        let request: SignRequest = serde_json::from_str(sign).unwrap();
        assert_eq!(request.path, "vault/base");
        assert_eq!(request.payload_v2["Ecdsa"], "00");
        let ckd = r#"{"derivation_path":"round/1","app_public_key":{"AppPublicKeyPV":{"pk1":"a","pk2":"b"}},"domain_id":2}"#;
        let request: CkdRequest = serde_json::from_str(ckd).unwrap();
        assert_eq!(request.derivation_path, "round/1");
    }

    #[test]
    fn signatures_verify_against_the_derived_keys() {
        testing_env!(VMContextBuilder::new().build());
        let engine: AccountId = "engine.test.near".parse().unwrap();
        let mock = MockMpc::new();
        let secret = derived_secret(DOMAIN_ED25519, engine.as_str(), "vault/sol");
        let message = b"a solana message";
        let signature = ed25519_key(&secret).sign(message);
        let key = mock.derived_public_key("vault/sol".into(), engine.clone(), DOMAIN_ED25519);
        let public: [u8; 32] = bs58::decode(key.strip_prefix("ed25519:").unwrap())
            .into_vec()
            .unwrap()
            .try_into()
            .unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&public)
            .unwrap()
            .verify_strict(message, &signature)
            .unwrap();

        let secret = derived_secret(DOMAIN_SECP256K1, engine.as_str(), "vault/base");
        let digest = [7u8; 32];
        let response = secp256k1_signature(&secret, &digest);
        let r = hex::decode(&response["big_r"]["affine_point"].as_str().unwrap()[2..]).unwrap();
        let s = hex::decode(response["s"]["scalar"].as_str().unwrap()).unwrap();
        let signature = k256::ecdsa::Signature::from_slice(&[r, s].concat()).unwrap();
        assert!(signature.normalize_s().is_none(), "low s");
        let recovery =
            k256::ecdsa::RecoveryId::from_byte(response["recovery_id"].as_u64().unwrap() as u8)
                .unwrap();
        let recovered =
            k256::ecdsa::VerifyingKey::recover_from_prehash(&digest, &signature, recovery).unwrap();
        let expected = mock.derived_public_key("vault/base".into(), engine, DOMAIN_SECP256K1);
        let point = recovered.to_encoded_point(false);
        assert_eq!(
            expected,
            format!(
                "secp256k1:{}",
                bs58::encode(&point.as_bytes()[1..]).into_string()
            )
        );
    }

    /// A mocked call with the live floors met (15 Tgas, 1 yoctoNEAR).
    fn call_env() {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id("engine.test.near".parse().unwrap())
            .attached_deposit(MIN_DEPOSIT)
            .prepaid_gas(Gas::from_tgas(25))
            .build());
    }

    /// A CKD request of the engine's shape for `round/1`, its `AppPublicKeyPV` from the scalars
    /// of rounds `a` (`pk1`) and `b` (`pk2`).
    fn ckd_request(domain_id: u64, a: u64, b: u64) -> CkdRequest {
        let (pk1, _) = rose_ibe::app_public_key_pv(&rose_ibe::app_scalar("engine.test.near", a));
        let (_, pk2) = rose_ibe::app_public_key_pv(&rose_ibe::app_scalar("engine.test.near", b));
        CkdRequest {
            derivation_path: "round/1".into(),
            app_public_key: CkdAppPublicKey::AppPublicKeyPV {
                pk1: rose_ibe::format_near_g1(&pk1),
                pk2: rose_ibe::format_near_g2(&pk2),
            },
            domain_id,
        }
    }

    fn mock_with_ckd_response() -> MockMpc {
        call_env();
        let mut mock = MockMpc::new();
        mock.set_ckd_response("round/1".into(), "y".into(), "c".into());
        mock
    }

    #[test]
    fn the_pairing_constants_are_the_generators() {
        use ark_ec::AffineRepr;
        testing_env!(VMContextBuilder::new().build());
        let g1 = rose_ibe::g1_to_bytes(&rose_ibe::G1Affine::generator());
        let minus_g2 = rose_ibe::g2_to_bytes(&-rose_ibe::G2Affine::generator());
        assert_eq!(
            env::bls12381_p1_decompress(g1).unwrap(),
            G1_GENERATOR_UNCOMPRESSED
        );
        assert_eq!(
            env::bls12381_p2_decompress(minus_g2).unwrap(),
            MINUS_G2_GENERATOR_UNCOMPRESSED
        );
    }

    #[test]
    fn a_ckd_request_with_a_consistent_app_key_on_the_ckd_domain_is_answered() {
        let mut mock = mock_with_ckd_response();
        match mock.request_app_private_key(ckd_request(DOMAIN_CKD, 1, 1)) {
            PromiseOrValue::Value(response) => assert_eq!(response.big_y, "y"),
            PromiseOrValue::Promise(_) => panic!("no delay was set"),
        }
    }

    #[test]
    #[should_panic(expected = "not the CKD domain")]
    fn a_ckd_request_on_another_domain_is_refused() {
        mock_with_ckd_response()
            .request_app_private_key(ckd_request(DOMAIN_SECP256K1, 1, 1))
            .detach();
    }

    #[test]
    #[should_panic(expected = "app public key check failed")]
    fn a_ckd_request_whose_pk1_and_pk2_disagree_is_refused() {
        mock_with_ckd_response()
            .request_app_private_key(ckd_request(DOMAIN_CKD, 1, 2))
            .detach();
    }

    #[test]
    #[should_panic(expected = "malformed BLS12-381 G1 point")]
    fn a_ckd_request_with_a_point_off_the_curve_is_refused() {
        let mut request = ckd_request(DOMAIN_CKD, 1, 1);
        let CkdAppPublicKey::AppPublicKeyPV { pk2, .. } = request.app_public_key;
        request.app_public_key = CkdAppPublicKey::AppPublicKeyPV {
            pk1: format!("bls12381g1:{}", bs58::encode([0xffu8; 48]).into_string()),
            pk2,
        };
        mock_with_ckd_response()
            .request_app_private_key(request)
            .detach();
    }

    #[test]
    #[should_panic(expected = "unknown ForeignTx payload version")]
    fn a_foreign_request_with_another_payload_version_is_refused() {
        call_env();
        let foreign = r#"{"request":{"Base":{"tx_id":"ab","extractors":[{"Log":{"log_index":2}}],"finality":"Safe"}},"domain_id":3,"payload_version":2}"#;
        MockMpc::new().verify_foreign_transaction(serde_json::from_str(foreign).unwrap());
    }

    #[test]
    fn eddsa_payloads_are_capped_at_one_solana_packet() {
        let sign = |bytes: usize| {
            call_env();
            MockMpc::new().sign(SignRequest {
                path: "vault/sol".into(),
                payload_v2: json!({ "Eddsa": hex::encode(vec![7u8; bytes]) }),
                domain_id: DOMAIN_ED25519,
            })
        };
        sign(EDDSA_PAYLOAD_MAX_BYTES);
        let refused = std::panic::catch_unwind(|| sign(EDDSA_PAYLOAD_MAX_BYTES + 1)).unwrap_err();
        assert_eq!(
            refused.downcast_ref::<String>().map(String::as_str),
            Some("Eddsa payload exceeds 1232 bytes")
        );
    }

    #[test]
    fn request_keys_ignore_field_order() {
        let a: Value =
            serde_json::from_str(r#"{"Solana":{"tx_id":"ab","finality":"Finalized"}}"#).unwrap();
        let b: Value =
            serde_json::from_str(r#"{"Solana":{"finality":"Finalized","tx_id":"ab"}}"#).unwrap();
        assert_eq!(request_key(&a), request_key(&b));
    }
}
