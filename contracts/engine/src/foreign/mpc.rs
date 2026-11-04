//! Mirror of the near/mpc contract interface used by the engine.
//!
//! Source of truth: `near/mpc` at tag `3.18.0` (commit `e691bdb98d68dcf74653da58d043453a6318765f`),
//! the version `v1.signer-prod.testnet` reports from its `version` view:
//!
//! - `crates/near-mpc-contract-interface/src/types/foreign_chain.rs`: `VerifyForeignTransactionRequestArgs`
//!   (line 101), `ForeignChainRpcRequest`, `EvmRpcRequest`, `SvmRpcRequest`, the extractor and
//!   finality enums, `ExtractedValue`, `ForeignTxSignPayload` and
//!   `VerifyForeignTransactionResponse` (line 151).
//! - `crates/near-mpc-crypto-types/src/sign.rs`: `SignRequestArgs` (line 30, `payload` is renamed
//!   `payload_v2` on the wire).
//! - `crates/near-mpc-crypto-types/src/primitives.rs`: `Payload` (line 89), `SignatureResponse`
//!   (line 167, externally tagged by `scheme`), `Ed25519Signature` (line 192, a plain array of 64
//!   numbers).
//! - `crates/near-mpc-contract-interface/src/snapshots/..._should_match_the_wire_format_catalog.snap`:
//!   the JSON of every call.
//!
//! Only the request shapes the engine sends are mirrored: Base with the `Log` extractor and Solana
//! with the `AccountState` extractor. The real enums have many more variants, so the borsh
//! discriminants of the mirrored variants are pinned explicitly to the values the real enums use:
//!
//! | real enum                | variant                 | borsh tag |
//! |--------------------------|-------------------------|-----------|
//! | `ForeignChainRpcRequest` | `Solana`                | 2         |
//! | `ForeignChainRpcRequest` | `Base`                  | 6         |
//! | `EvmFinality`            | `Latest/Safe/Finalized` | 0/1/2     |
//! | `EvmExtractor`           | `Log`                   | 1         |
//! | `SvmFinality`            | `Confirmed/Finalized`   | 0/1       |
//! | `SvmExtractor`           | `AccountState`          | 2         |
//! | `ExtractedValue`         | `EvmExtractedValue`     | 1         |
//! | `ExtractedValue`         | `SvmExtractedValue`     | 6         |
//! | `EvmExtractedValue`      | `Log`                   | 1         |
//! | `SvmExtractedValue`      | `AccountState`          | 1         |
//! | `ForeignTxSignPayload`   | `V1`                    | 0         |
//!
//! The equivalence was established in the day-1 spike against the real crate (1000 random cases,
//! identical borsh bytes and JSON both ways) and the integration tests replay ten live MPC
//! responses whose `payload_hash` this module reproduces.
//!
//! JSON conventions of the wire format: byte strings are lowercase hex without `0x`, enums are
//! externally tagged, `payload_version` is the number `1`, `expected_payload_hash` is omitted when
//! absent and an Ed25519 signature is an array of 64 numbers.

use borsh::BorshSerialize;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Domain whose derived keys are secp256k1 (`Ecdsa` payloads; RoseVault authorizations).
pub const DOMAIN_SECP256K1: u64 = 0;
/// Domain whose derived keys are Ed25519 (`Eddsa` payloads; Solana transactions).
pub const DOMAIN_ED25519: u64 = 1;
/// Domain whose purpose is `ForeignTx` on `v1.signer-prod.testnet`.
pub const DOMAIN_FOREIGN_TX: u64 = 3;
/// Method name of a signature request.
pub const METHOD_SIGN: &str = "sign";
/// Method name of a foreign transaction attestation request.
pub const METHOD_VERIFY_FOREIGN_TRANSACTION: &str = "verify_foreign_transaction";
/// Gas the MPC contract requires attached to `sign` and `verify_foreign_transaction`
/// (`sign_call_gas_attachment_requirement_tera_gas: 15` in the live `config` view; 14 Tgas is
/// rejected with `Provided gas is lower than required`).
pub const MIN_CALL_GAS: u64 = 15_000_000_000_000;
/// Deposit both methods require (excess is refunded).
pub const CALL_DEPOSIT_YOCTO: u128 = 1;
/// `ForeignTxPayloadVersion::V1`, serialized as the bare number `1`.
pub const PAYLOAD_VERSION_V1: u8 = 1;

/// Serde helpers for fixed-size byte arrays rendered as hex (lowercase without `0x` on output; any
/// case and an optional `0x` prefix on input).
pub mod hex_array {
    use serde::{Deserialize, Deserializer, Serializer};

    /// Serializes `bytes` as lowercase hex.
    pub fn serialize<S: Serializer, const N: usize>(
        bytes: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    /// Deserializes exactly `N` bytes of hex.
    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        let text = String::deserialize(deserializer)?;
        super::parse_hex_array(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("expected {N} bytes of hex")))
    }
}

/// Serde helpers for variable-length byte strings rendered as hex (same conventions as
/// [`hex_array`]).
pub mod hex_vec {
    use serde::{Deserialize, Deserializer, Serializer};

    /// Serializes `bytes` as lowercase hex.
    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    /// Deserializes any even-length hex string.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        super::parse_hex(&text).ok_or_else(|| serde::de::Error::custom("expected hex"))
    }
}

/// Serde helpers for a 64-byte array rendered as a JSON array of numbers, the encoding
/// `serde_with::serde_as(as = "[_; 64]")` gives `Ed25519Signature`.
pub mod byte_array_64 {
    use serde::{ser::SerializeTuple, Deserialize, Deserializer, Serializer};

    /// Serializes the 64 bytes as a tuple of numbers.
    pub fn serialize<S: Serializer>(bytes: &[u8; 64], serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(64)?;
        for byte in bytes {
            tuple.serialize_element(byte)?;
        }
        tuple.end()
    }

    /// Deserializes exactly 64 numbers.
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 64], D::Error> {
        let bytes = Vec::<u8>::deserialize(deserializer)?;
        bytes
            .try_into()
            .map_err(|_| serde::de::Error::custom("expected 64 bytes"))
    }
}

/// Decodes hex with an optional `0x` prefix, in any case.
pub fn parse_hex(text: &str) -> Option<Vec<u8>> {
    hex::decode(text.strip_prefix("0x").unwrap_or(text)).ok()
}

/// Decodes exactly `N` bytes of hex with an optional `0x` prefix, in any case.
pub fn parse_hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    parse_hex(text)?.try_into().ok()
}

/// 32-byte value (`Hash256`, `EvmTxId` and `SvmAddress` share this encoding).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize)]
pub struct Bytes32(#[serde(with = "hex_array")] pub [u8; 32]);

/// 20-byte EVM address (`Hash160`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize)]
pub struct Bytes20(#[serde(with = "hex_array")] pub [u8; 20]);

/// 64-byte Solana transaction signature (`SvmTxId`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, BorshSerialize)]
pub struct Bytes64(#[serde(with = "hex_array")] pub [u8; 64]);

/// Top-level JSON argument object of `verify_foreign_transaction`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyForeignTransactionCall {
    /// The request.
    pub request: VerifyForeignTransactionRequestArgs,
}

impl VerifyForeignTransactionCall {
    /// A ForeignTx request on [`DOMAIN_FOREIGN_TX`] with payload version 1 and no
    /// `expected_payload_hash`.
    ///
    /// The expected hash is deliberately omitted: a mismatch then yields a signed response over
    /// the real values in about 7 seconds, which the engine detects by recomputing the hash,
    /// whereas a request carrying a wrong expected hash is never answered and times out after
    /// 200 blocks (measured in the day-1 spike).
    pub fn new(request: ForeignChainRpcRequest) -> Self {
        Self {
            request: VerifyForeignTransactionRequestArgs {
                request,
                domain_id: DOMAIN_FOREIGN_TX,
                payload_version: PAYLOAD_VERSION_V1,
                expected_payload_hash: None,
            },
        }
    }
}

/// `VerifyForeignTransactionRequestArgs` (`foreign_chain.rs:101`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyForeignTransactionRequestArgs {
    /// Which chain, which transaction and what to extract from it.
    pub request: ForeignChainRpcRequest,
    /// MPC domain whose key signs the attestation.
    pub domain_id: u64,
    /// Version of the signed payload layout.
    pub payload_version: u8,
    /// Hash the nodes must reproduce before signing; the engine never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_payload_hash: Option<Bytes32>,
}

/// The mirrored variants of `ForeignChainRpcRequest`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum ForeignChainRpcRequest {
    /// Solana (devnet for this deployment: the chain is selected by the MPC configuration).
    Solana(SvmRpcRequest) = 2,
    /// Base (Sepolia for this deployment).
    Base(EvmRpcRequest) = 6,
}

/// `EvmRpcRequest`: field order is `tx_id, extractors, finality`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
pub struct EvmRpcRequest {
    /// Transaction hash.
    pub tx_id: Bytes32,
    /// What to extract from the receipt.
    pub extractors: Vec<EvmExtractor>,
    /// Finality the transaction's block must have reached.
    pub finality: EvmFinality,
}

/// `EvmFinality`, mapped by the nodes to the `latest`, `safe` and `finalized` block tags.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum EvmFinality {
    /// Head of the chain.
    Latest = 0,
    /// Safe head (about 3 minutes behind on Base Sepolia).
    Safe = 1,
    /// Finalized head (about 16 minutes behind on Base Sepolia).
    Finalized = 2,
}

/// The mirrored variant of `EvmExtractor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum EvmExtractor {
    /// One receipt log. `log_index` is the block-level `logIndex` of the log as returned by
    /// `eth_getTransactionReceipt`, not its position inside the transaction
    /// (`crates/foreign-chain-inspector/src/evm/inspector.rs:221-227`).
    Log {
        /// Block-level log index.
        log_index: u64,
    } = 1,
}

/// `SvmRpcRequest`: field order is `tx_id, finality, extractors` (differs from the EVM request).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
pub struct SvmRpcRequest {
    /// Transaction signature.
    pub tx_id: Bytes64,
    /// Commitment the transaction must have reached.
    pub finality: SvmFinality,
    /// What to extract.
    pub extractors: Vec<SvmExtractor>,
}

/// `SvmFinality`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum SvmFinality {
    /// Confirmed commitment.
    Confirmed = 0,
    /// Finalized commitment.
    Finalized = 1,
}

/// The mirrored variant of `SvmExtractor`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum SvmExtractor {
    /// The account's current state, read with `getAccountInfo` at the request's commitment at a
    /// slot not older than the transaction's. The transaction is only an anchor: the account does
    /// not have to appear in it, and the state is the one in force when the nodes read it.
    AccountState {
        /// Account to read.
        pubkey: Bytes32,
    } = 2,
}

/// The mirrored variants of `ExtractedValue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum ExtractedValue {
    /// A value extracted from an EVM chain.
    EvmExtractedValue(EvmExtractedValue) = 1,
    /// A value extracted from an SVM chain.
    SvmExtractedValue(SvmExtractedValue) = 6,
}

impl ExtractedValue {
    /// The value of a `Log` extractor.
    pub fn log(log: EvmLog) -> Self {
        Self::EvmExtractedValue(EvmExtractedValue::Log(log))
    }

    /// The value of an `AccountState` extractor.
    pub fn account(account: SvmAccount) -> Self {
        Self::SvmExtractedValue(SvmExtractedValue::AccountState(account))
    }
}

/// The mirrored variant of `EvmExtractedValue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum EvmExtractedValue {
    /// One receipt log.
    Log(EvmLog) = 1,
}

/// The mirrored variant of `SvmExtractedValue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
#[repr(u8)]
#[borsh(use_discriminant = true)]
pub enum SvmExtractedValue {
    /// One account's state.
    AccountState(SvmAccount) = 1,
}

/// One receipt log exactly as the nodes read it from `eth_getTransactionReceipt`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
pub struct EvmLog {
    /// Always `false` for a log in a canonical block.
    pub removed: bool,
    /// Block-level log index.
    pub log_index: u64,
    /// Position of the transaction in its block.
    pub transaction_index: u64,
    /// Transaction hash.
    pub transaction_hash: Bytes32,
    /// Hash of the block that contains the transaction.
    pub block_hash: Bytes32,
    /// Number of that block.
    pub block_number: u64,
    /// Emitting contract.
    pub address: Bytes20,
    /// The RPC `data` string verbatim: `0x` followed by lowercase hex, `"0x"` when empty.
    pub data: String,
    /// Indexed topics, `topics[0]` being the event signature.
    pub topics: Vec<Bytes32>,
}

impl EvmLog {
    /// Canonical RPC rendering of log data.
    pub fn data_string(data: &[u8]) -> String {
        format!("0x{}", hex::encode(data))
    }

    /// Raw log data, or `None` when `data` is not canonical (`0x` + lowercase hex).
    pub fn data_bytes(&self) -> Option<Vec<u8>> {
        let digits = self.data.strip_prefix("0x")?;
        if digits.bytes().any(|c| c.is_ascii_uppercase()) {
            return None;
        }
        hex::decode(digits).ok()
    }
}

/// Current state of an account: its owner program and raw data.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, BorshSerialize)]
pub struct SvmAccount {
    /// Owner program.
    pub owner: Bytes32,
    /// Account data.
    #[serde(with = "hex_vec")]
    pub data: Vec<u8>,
}

/// `ForeignTxSignPayload::V1`: the request and the extracted values, in that order.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize)]
pub struct ForeignTxSignPayloadV1 {
    /// The request as sent, without `domain_id`, `payload_version` and `expected_payload_hash`.
    pub request: ForeignChainRpcRequest,
    /// One value per extractor, in extractor order.
    pub values: Vec<ExtractedValue>,
}

/// The payload the MPC nodes hash and sign.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize)]
pub enum ForeignTxSignPayload {
    /// Version 1.
    V1(ForeignTxSignPayloadV1),
}

impl ForeignTxSignPayload {
    /// A version 1 payload.
    pub fn v1(request: ForeignChainRpcRequest, values: Vec<ExtractedValue>) -> Self {
        Self::V1(ForeignTxSignPayloadV1 { request, values })
    }

    /// Borsh bytes that the nodes hash.
    pub fn payload_bytes(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("borsh serialization into a Vec cannot fail")
    }

    /// `sha256(borsh(self))`: the `payload_hash` returned by the MPC contract.
    pub fn payload_hash(&self) -> [u8; 32] {
        Sha256::digest(self.payload_bytes()).into()
    }
}

/// `sha256(borsh(ForeignTxSignPayload::V1 { request, values }))` in one call.
pub fn payload_hash(request: ForeignChainRpcRequest, values: Vec<ExtractedValue>) -> [u8; 32] {
    ForeignTxSignPayload::v1(request, values).payload_hash()
}

/// Successful result of `verify_foreign_transaction`, as delivered to the caller's callback.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyForeignTransactionResponse {
    /// Hash the nodes signed; the engine compares it with its own recomputation.
    pub payload_hash: Bytes32,
    /// Signature over `payload_hash` by the domain's key, already verified by the MPC contract.
    pub signature: SignatureResponse,
}

/// Top-level JSON argument object of `sign`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignCall {
    /// The request.
    pub request: SignRequestArgs,
}

impl SignCall {
    /// An ECDSA request on [`DOMAIN_SECP256K1`] over a 32-byte digest. The digest must be below
    /// the secp256k1 group order (`crate::foreign::evm::is_valid_ecdsa_payload`).
    pub fn ecdsa(path: impl Into<String>, digest: [u8; 32]) -> Self {
        Self {
            request: SignRequestArgs {
                path: path.into(),
                payload_v2: SignPayload::Ecdsa(digest),
                domain_id: DOMAIN_SECP256K1,
            },
        }
    }

    /// An EdDSA request on [`DOMAIN_ED25519`] over an arbitrary message (a Solana legacy message
    /// for the engine).
    pub fn eddsa(path: impl Into<String>, message: Vec<u8>) -> Self {
        Self {
            request: SignRequestArgs {
                path: path.into(),
                payload_v2: SignPayload::Eddsa(message),
                domain_id: DOMAIN_ED25519,
            },
        }
    }
}

/// `SignRequestArgs` (`sign.rs:30`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignRequestArgs {
    /// Derivation path; the key is determined by the caller's account id and this path.
    pub path: String,
    /// What to sign.
    pub payload_v2: SignPayload,
    /// Domain whose distributed key derives the signing key.
    pub domain_id: u64,
}

/// `Payload` (`primitives.rs:89`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SignPayload {
    /// A 32-byte secp256k1 scalar.
    Ecdsa(#[serde(with = "hex_array")] [u8; 32]),
    /// Any message of at most 1232 bytes.
    Eddsa(#[serde(with = "hex_vec")] Vec<u8>),
}

/// `SignatureResponse` (`primitives.rs:167`): the value of a resolved `sign` promise and the
/// `signature` of a [`VerifyForeignTransactionResponse`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "scheme")]
pub enum SignatureResponse {
    /// A secp256k1 signature (domains 0 and 3).
    Secp256k1(Secp256k1Signature),
    /// An Ed25519 signature (domain 1).
    Ed25519 {
        /// The 64-byte signature.
        signature: Ed25519Signature,
    },
}

impl SignatureResponse {
    /// The secp256k1 signature, if that is the scheme.
    pub fn as_secp256k1(&self) -> Option<&Secp256k1Signature> {
        match self {
            Self::Secp256k1(signature) => Some(signature),
            Self::Ed25519 { .. } => None,
        }
    }

    /// The Ed25519 signature bytes, if that is the scheme.
    pub fn as_ed25519(&self) -> Option<&[u8; 64]> {
        match self {
            Self::Ed25519 { signature } => Some(&signature.0),
            Self::Secp256k1(_) => None,
        }
    }
}

/// `k256Signature`: `big_r` is the compressed point `R`, `s` the scalar, `recovery_id` the id
/// that recovers the derived key. The MPC contract only accepts low-s signatures from the nodes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Secp256k1Signature {
    /// Compressed SEC1 point `R`; `r` is its x coordinate.
    pub big_r: AffinePoint,
    /// Scalar `s`.
    pub s: Scalar,
    /// Recovery id; not implied by the prefix of `big_r`, since low-s normalization flips it.
    pub recovery_id: u8,
}

/// `{"affine_point": "<33-byte hex>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AffinePoint {
    /// Compressed SEC1 encoding (prefix `02` or `03`, then x).
    #[serde(with = "hex_array")]
    pub affine_point: [u8; 33],
}

/// `{"scalar": "<32-byte hex>"}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scalar {
    /// Big-endian scalar.
    #[serde(with = "hex_array")]
    pub scalar: [u8; 32],
}

/// `Ed25519Signature` (`primitives.rs:192`): 64 bytes as a JSON array of numbers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ed25519Signature(#[serde(with = "byte_array_64")] pub [u8; 64]);
