//! RoseVault (Base Sepolia) byte layouts: deposit logs, EIP-712 authorizations and the MPC
//! secp256k1 signature mapping.
//!
//! Sources:
//!
//! - `contracts/evm/src/RoseVault.sol` in this repository: the `StreamDeposited` (line 119) and
//!   `CashDeposited` (line 163) events with their documented ABI layouts, the `TRANSFER_TYPEHASH`
//!   and `RELEASE_TYPEHASH` constants (lines 92-97), the `EIP712("RoseVault", "1")` domain
//!   (line 208), `executeTransfer` and `executeRelease` which require `v` in `{27, 28}`, a low `s`
//!   and the recovered address to equal the immutable signer.
//! - Solidity ABI encoding of events (`https://docs.soliditylang.org/en/v0.8.30/abi-spec.html`,
//!   "Events" and "Formal Specification of the Encoding"): indexed value types are one topic each,
//!   non-indexed values are ABI-encoded as a tuple in `data`; every static word is 32 bytes,
//!   big-endian, left-padded; a `string` is a head offset, then its byte length and its bytes
//!   right-padded to a multiple of 32.
//! - EIP-712 (`https://eips.ethereum.org/EIPS/eip-712`): digest = `keccak256(0x19 0x01 ||
//!   domainSeparator || hashStruct(message))`, with the domain type
//!   `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)` as
//!   OpenZeppelin `EIP712` v5.7.0 (`contracts/utils/cryptography/EIP712.sol`) builds it.
//! - near/mpc 3.18.0 `crates/contract/src/api/sign.rs:47-50`: an `Ecdsa` payload is converted
//!   with `k256::Scalar::from_repr`, so it must be below the group order `n` (a payload between
//!   `n` and the field size is rejected with `Ecdsa payload cannot be converted to Scalar`,
//!   measured live). `respond` verifies the nodes' signature with the malleability flag set, so a
//!   delivered `s` is always low (`crates/near-mpc-signature-verifier/src/lib.rs`).
//! - Ethereum address = last 20 bytes of `keccak256(x || y)` of the uncompressed public key
//!   (Yellow Paper, appendix F); NEAR renders secp256k1 keys as `secp256k1:<base58 of x || y>`.

use sha3::{Digest, Keccak256};

use super::mpc::{Bytes20, Bytes32, EvmLog, Secp256k1Signature};
use crate::unlock::SablierLinearParams;

/// 20-byte Ethereum address.
pub type Address = [u8; 20];
/// 32-byte ABI word, hash or topic.
pub type Word = [u8; 32];

/// Chain id of Base Sepolia.
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;

/// `keccak256("StreamDeposited(address,string,address,uint256,address,uint8,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)")`.
pub const STREAM_DEPOSITED_TOPIC: Word = [
    0x58, 0x8c, 0xe8, 0xdd, 0xd1, 0xa5, 0x5c, 0x33, 0x0c, 0xac, 0x56, 0xa0, 0x2e, 0xd1, 0x42, 0x35,
    0x86, 0xed, 0xfc, 0xc7, 0x62, 0xed, 0xb1, 0xdb, 0x1b, 0x1f, 0x25, 0x3d, 0xad, 0xe6, 0xa5, 0x99,
];

/// `keccak256("CashDeposited(address,address,uint64,string,uint128,uint40)")`.
pub const CASH_DEPOSITED_TOPIC: Word = [
    0xf2, 0x3a, 0x8d, 0x2e, 0x80, 0xa8, 0xa5, 0xa0, 0x5e, 0x52, 0xad, 0x90, 0xec, 0x55, 0x65, 0x05,
    0x23, 0xdd, 0xc1, 0x4c, 0x51, 0x1b, 0x18, 0xfb, 0x24, 0xdb, 0x60, 0x58, 0x9d, 0x76, 0x7f, 0xb4,
];

/// `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`.
pub const EIP712_DOMAIN_TYPEHASH: Word = [
    0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d, 0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
    0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca, 0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f,
];

/// `keccak256("RoseVault")`.
pub const DOMAIN_NAME_HASH: Word = [
    0x66, 0x9e, 0x42, 0x25, 0xc8, 0xb6, 0x70, 0x71, 0x40, 0x65, 0x77, 0xa1, 0x50, 0x92, 0x63, 0x3f,
    0xff, 0xfd, 0x2a, 0x3e, 0x7a, 0x18, 0x76, 0x36, 0x42, 0x08, 0x1b, 0x20, 0xea, 0x86, 0x6a, 0x7f,
];

/// `keccak256("1")`.
pub const DOMAIN_VERSION_HASH: Word = [
    0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c, 0x7a, 0xdf, 0x61, 0x28, 0x82, 0xdf, 0x09, 0x50,
    0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd, 0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6,
];

/// `keccak256("Transfer(address token,address to,uint256 amount,uint256 id)")`.
pub const TRANSFER_TYPEHASH: Word = [
    0xad, 0xef, 0x71, 0xea, 0x6e, 0x9e, 0xff, 0x3d, 0xab, 0x77, 0xcb, 0xc9, 0xc5, 0xaa, 0x76, 0xb0,
    0xb8, 0x4e, 0xeb, 0x1a, 0xac, 0xc5, 0x3a, 0x08, 0xe3, 0x4d, 0x36, 0x89, 0xf9, 0x92, 0x5e, 0x51,
];

/// `keccak256("Release(address lockup,uint256 streamId,address to,uint256 id)")`.
pub const RELEASE_TYPEHASH: Word = [
    0x83, 0x09, 0xfb, 0xd7, 0x02, 0x4d, 0xfe, 0x91, 0x29, 0x3e, 0x3c, 0xb9, 0xab, 0x5d, 0x73, 0xdb,
    0x26, 0xf8, 0xf3, 0xfa, 0x42, 0x30, 0xd5, 0x29, 0x1f, 0xad, 0x1a, 0x14, 0x3e, 0xb6, 0x9b, 0x0b,
];

/// secp256k1 group order `n`, big-endian.
pub const SECP256K1_N: Word = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];

/// `floor(n / 2)`, big-endian. A signature is low-s when `s <= n / 2`.
pub const SECP256K1_HALF_N: Word = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// Longest NEAR account id (nearcore `AccountId::MAX_LEN`).
pub const NEAR_ACCOUNT_MAX_LEN: usize = 64;

/// Keccak-256.
pub fn keccak256(data: &[u8]) -> Word {
    Keccak256::digest(data).into()
}

/// Parses `0x`-prefixed or bare hex into an address, in any case.
pub fn parse_address(text: &str) -> Option<Address> {
    super::mpc::parse_hex_array(text)
}

/// `0x` followed by lowercase hex, the form the engine stores and compares.
pub fn format_address(address: &Address) -> String {
    format!("0x{}", hex::encode(address))
}

/// Where a log sits in the chain: the receipt fields the MPC nodes include in the attested
/// [`EvmLog`] besides the event itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogLocation {
    /// Transaction hash.
    pub transaction_hash: Word,
    /// Position of the transaction in its block.
    pub transaction_index: u64,
    /// Hash of the block.
    pub block_hash: Word,
    /// Number of the block.
    pub block_number: u64,
    /// Block-level log index (the receipt's `logIndex`).
    pub log_index: u64,
}

impl LogLocation {
    /// The attested log for an event emitted by `emitter` with these topics and data.
    pub fn evm_log(&self, emitter: Address, topics: Vec<Word>, data: &[u8]) -> EvmLog {
        EvmLog {
            removed: false,
            log_index: self.log_index,
            transaction_index: self.transaction_index,
            transaction_hash: Bytes32(self.transaction_hash),
            block_hash: Bytes32(self.block_hash),
            block_number: self.block_number,
            address: Bytes20(emitter),
            data: EvmLog::data_string(data),
            topics: topics.into_iter().map(Bytes32).collect(),
        }
    }
}

/// Why a log does not decode as the expected RoseVault event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogError {
    /// Wrong number of topics.
    TopicCount,
    /// `topics[0]` is not the event signature.
    Signature,
    /// `data` has a length the layout cannot produce.
    Length,
    /// A word carries bits above its declared type (non-canonical encoding).
    Range,
    /// A `bool` word is neither 0 nor 1.
    Bool,
    /// The string head offset is not the fixed offset the layout produces.
    Offset,
    /// The string bytes are not a valid NEAR account id.
    NearAccount,
}

/// A Solidity value type as one ABI word.
pub trait AbiType {
    /// The Rust value.
    type Value;
    /// Big-endian, left-padded word.
    fn encode(value: &Self::Value) -> Word;
    /// Strict decoding: every bit above the type's width must be zero.
    fn decode(word: &Word) -> Result<Self::Value, LogError>;
}

/// Solidity `address`.
pub struct AbiAddress;
/// Solidity `bool`.
pub struct AbiBool;
/// Solidity `uint8`.
pub struct AbiUint8;
/// Solidity `uint40`.
pub struct AbiUint40;
/// Solidity `uint64`.
pub struct AbiUint64;
/// Solidity `uint128`.
pub struct AbiUint128;
/// Solidity `uint256` holding a counter the engine stores as `u64` (Sablier stream ids and
/// authorization ids); larger values are refused as non-canonical.
pub struct AbiUint256AsU64;

impl AbiType for AbiAddress {
    type Value = Address;
    fn encode(value: &Address) -> Word {
        word_from_address(value)
    }
    fn decode(word: &Word) -> Result<Address, LogError> {
        if word[..12].iter().any(|byte| *byte != 0) {
            return Err(LogError::Range);
        }
        Ok(word[12..].try_into().expect("20 bytes"))
    }
}

impl AbiType for AbiBool {
    type Value = bool;
    fn encode(value: &bool) -> Word {
        word_from_bool(*value)
    }
    fn decode(word: &Word) -> Result<bool, LogError> {
        match uint_from_word(word, 1) {
            Ok(0) => Ok(false),
            Ok(_) => Ok(true),
            Err(_) => Err(LogError::Bool),
        }
    }
}

macro_rules! abi_uint {
    ($abi:ident, $value:ty, $bits:expr) => {
        impl AbiType for $abi {
            type Value = $value;
            fn encode(value: &$value) -> Word {
                word_from_u128(u128::from(*value))
            }
            fn decode(word: &Word) -> Result<$value, LogError> {
                uint_from_word(word, $bits).map(|value| value as $value)
            }
        }
    };
}

abi_uint!(AbiUint8, u8, 8);
abi_uint!(AbiUint40, u64, 40);
abi_uint!(AbiUint64, u64, 64);
abi_uint!(AbiUint128, u128, 128);
abi_uint!(AbiUint256AsU64, u64, 64);

/// Defines a RoseVault event whose only dynamic parameter is a `string` NEAR account id declared
/// as the first non-indexed parameter: the struct, `topics()`, `data()` and the strict `decode()`
/// all come from the single field list given here.
///
/// Layout: `topics` = signature then the indexed values in order; `data` = word 0 the offset of
/// the string (`32 * (1 + number of static data fields)`), then the static fields in order, then
/// the string's byte length and its bytes right-padded to a multiple of 32.
macro_rules! vault_event {
    (
        $(#[$doc:meta])*
        $name:ident {
            signature: $signature:expr,
            topic: $topic:expr,
            topics: [ $( $(#[$topic_doc:meta])* $topic_field:ident : $topic_abi:ty ),* $(,)? ],
            string: $(#[$string_doc:meta])* $string_field:ident,
            data: [ $( $(#[$data_doc:meta])* $data_field:ident : $data_abi:ty ),* $(,)? ] $(,)?
        }
    ) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq)]
        pub struct $name {
            $( $(#[$topic_doc])* pub $topic_field: <$topic_abi as AbiType>::Value, )*
            $(#[$string_doc])* pub $string_field: String,
            $( $(#[$data_doc])* pub $data_field: <$data_abi as AbiType>::Value, )*
        }

        impl $name {
            /// The event signature `topics[0]` is the keccak-256 of.
            pub const SIGNATURE: &'static str = $signature;
            /// `keccak256(SIGNATURE)`.
            pub const TOPIC: Word = $topic;
            const TOPIC_COUNT: usize = 1 + [$(stringify!($topic_field)),*].len();
            const HEAD_WORDS: usize = 1 + [$(stringify!($data_field)),*].len();

            /// The topics: signature, then the indexed fields.
            pub fn topics(&self) -> Vec<Word> {
                vec![Self::TOPIC $(, <$topic_abi as AbiType>::encode(&self.$topic_field))*]
            }

            /// The ABI-encoded data.
            pub fn data(&self) -> Vec<u8> {
                let mut out = Vec::with_capacity((Self::HEAD_WORDS + 4) * 32);
                out.extend_from_slice(&word_from_u128((Self::HEAD_WORDS * 32) as u128));
                $( out.extend_from_slice(&<$data_abi as AbiType>::encode(&self.$data_field)); )*
                push_string(&mut out, &self.$string_field);
                out
            }

            /// The attested log, as the MPC nodes hash it.
            pub fn evm_log(&self, emitter: Address, location: &LogLocation) -> EvmLog {
                location.evm_log(emitter, self.topics(), &self.data())
            }

            /// Strict decoding: succeeds only on bytes [`Self::data`] and [`Self::topics`]
            /// reproduce.
            pub fn decode(topics: &[Word], data: &[u8]) -> Result<Self, LogError> {
                if topics.len() != Self::TOPIC_COUNT {
                    return Err(LogError::TopicCount);
                }
                if topics[0] != Self::TOPIC {
                    return Err(LogError::Signature);
                }
                let mut topics = topics[1..].iter();
                let mut words = Words::new(data, Self::HEAD_WORDS + 1)?;
                let $string_field = decode_string(data, &mut words, Self::HEAD_WORDS)?;
                Ok(Self {
                    $( $topic_field: <$topic_abi as AbiType>::decode(
                        topics.next().expect("topic count checked"),
                    )?, )*
                    $string_field,
                    $( $data_field: <$data_abi as AbiType>::decode(words.next())?, )*
                })
            }
        }
    };
}

vault_event! {
    /// `StreamDeposited(address indexed sender, string nearAccount, address lockup, uint256
    /// indexed streamId, address token, uint8 decimals, uint128 deposited, uint128 withdrawn,
    /// uint40 start, uint40 cliff, uint40 end, uint40 granularity, uint128 startUnlock, uint128
    /// cliffUnlock, bool cancelable, bool transferable, uint40 timestamp)`.
    ///
    /// Data: word 0 is `15 * 32` (the offset of `nearAccount`), words 1 to 14 the static fields,
    /// word 15 the byte length of `nearAccount`, then its padded bytes.
    StreamDeposited {
        signature: "StreamDeposited(address,string,address,uint256,address,uint8,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)",
        topic: STREAM_DEPOSITED_TOPIC,
        topics: [
            /// Depositor (the stream owner at deposit time).
            sender: AbiAddress,
            /// Stream id.
            stream_id: AbiUint256AsU64,
        ],
        string:
            /// NEAR account credited with the units.
            near_account,
        data: [
            /// Sablier Lockup contract.
            lockup: AbiAddress,
            /// Streamed token.
            token: AbiAddress,
            /// `IERC20Metadata.decimals()` of the token, read by the vault at deposit time.
            decimals: AbiUint8,
            /// Deposited amount: the allocation the engine mints as units.
            deposited: AbiUint128,
            /// Withdrawn amount, including what this deposit withdrew to `sender`.
            withdrawn: AbiUint128,
            /// Start time.
            start: AbiUint40,
            /// Cliff time, `0` without cliff.
            cliff: AbiUint40,
            /// End time.
            end: AbiUint40,
            /// Unlock granularity in seconds.
            granularity: AbiUint40,
            /// Amount unlocked at start.
            start_unlock: AbiUint128,
            /// Amount unlocked at cliff.
            cliff_unlock: AbiUint128,
            /// Always `false`: the vault refuses cancelable streams.
            cancelable: AbiBool,
            /// Always `true`: the vault refuses non-transferable streams.
            transferable: AbiBool,
            /// Block timestamp of the deposit; the units' checkpoint is `f(timestamp)`.
            timestamp: AbiUint40,
        ],
    }
}

impl StreamDeposited {
    /// The stream schedule as [`crate::unlock::SablierLinearStream`] validates it.
    pub fn sablier_params(&self) -> SablierLinearParams {
        SablierLinearParams {
            start: self.start,
            cliff: self.cliff,
            end: self.end,
            granularity: self.granularity,
            start_unlock: self.start_unlock,
            cliff_unlock: self.cliff_unlock,
            deposited: self.deposited,
        }
    }
}

vault_event! {
    /// `CashDeposited(address indexed sender, address indexed token, uint64 indexed roundId,
    /// string nearAccount, uint128 amount, uint40 timestamp)`.
    ///
    /// Data: word 0 is `3 * 32`, then `amount`, `timestamp`, the byte length of `nearAccount` and
    /// its padded bytes.
    CashDeposited {
        signature: "CashDeposited(address,address,uint64,string,uint128,uint40)",
        topic: CASH_DEPOSITED_TOPIC,
        topics: [
            /// Depositor.
            sender: AbiAddress,
            /// ERC-20 token.
            token: AbiAddress,
            /// Round the cash is intended for (`0` for a plain balance top-up).
            round_id: AbiUint64,
        ],
        string:
            /// NEAR account credited.
            near_account,
        data: [
            /// Amount received by the vault.
            amount: AbiUint128,
            /// Block timestamp of the deposit.
            timestamp: AbiUint40,
        ],
    }
}

/// Sequential reader over the head words of ABI data.
struct Words<'a> {
    data: &'a [u8],
    next: usize,
}

impl<'a> Words<'a> {
    /// Requires at least `min_words` whole words.
    fn new(data: &'a [u8], min_words: usize) -> Result<Self, LogError> {
        if !data.len().is_multiple_of(32) || data.len() < min_words * 32 {
            return Err(LogError::Length);
        }
        Ok(Self { data, next: 0 })
    }

    fn next(&mut self) -> &'a Word {
        let word = self.data[self.next * 32..(self.next + 1) * 32]
            .try_into()
            .expect("a 32-byte slice is a word");
        self.next += 1;
        word
    }
}

/// Reads the string head (offset word) and its tail (length word and padded bytes), requiring
/// the tail to be the only content after the head.
fn decode_string(
    data: &[u8],
    words: &mut Words<'_>,
    head_words: usize,
) -> Result<String, LogError> {
    let offset = uint_from_word(words.next(), 64)? as usize;
    if offset != head_words * 32 {
        return Err(LogError::Offset);
    }
    let length_word: &Word = data[offset..offset + 32]
        .try_into()
        .expect("a 32-byte slice is a word");
    let length = uint_from_word(length_word, 64)? as usize;
    if length > NEAR_ACCOUNT_MAX_LEN {
        return Err(LogError::NearAccount);
    }
    let tail_start = offset + 32;
    if data.len() != tail_start + length.div_ceil(32) * 32 {
        return Err(LogError::Length);
    }
    let bytes = &data[tail_start..tail_start + length];
    if data[tail_start + length..].iter().any(|byte| *byte != 0) {
        return Err(LogError::Length);
    }
    let text = core::str::from_utf8(bytes).map_err(|_| LogError::NearAccount)?;
    if !is_valid_near_account_id(text) {
        return Err(LogError::NearAccount);
    }
    Ok(text.to_string())
}

/// Appends an ABI string tail: length word, then bytes right-padded to a multiple of 32.
fn push_string(out: &mut Vec<u8>, text: &str) {
    let bytes = text.as_bytes();
    out.extend_from_slice(&word_from_u128(bytes.len() as u128));
    out.extend_from_slice(bytes);
    out.resize(out.len() + (32 - bytes.len() % 32) % 32, 0);
}

/// Big-endian, left-padded word of an unsigned integer.
pub fn word_from_u128(value: u128) -> Word {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// Left-padded word of an address.
pub fn word_from_address(address: &Address) -> Word {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

/// `1` or `0`.
pub fn word_from_bool(value: bool) -> Word {
    word_from_u128(u128::from(value))
}

/// Reads an unsigned integer of `bits` bits (at most 128), rejecting bits above that width.
fn uint_from_word(word: &Word, bits: u32) -> Result<u128, LogError> {
    if word[..16].iter().any(|byte| *byte != 0) {
        return Err(LogError::Range);
    }
    let value = u128::from_be_bytes(word[16..].try_into().expect("16 bytes"));
    if bits < 128 && value >> bits != 0 {
        return Err(LogError::Range);
    }
    Ok(value)
}

/// nearcore's account id rule, which RoseVault enforces on chain (`libraries/NearAccountId.sol`):
/// 2 to 64 bytes matching `^(([a-z\d]+[\-_])*[a-z\d]+\.)*([a-z\d]+[\-_])*[a-z\d]+$`.
pub fn is_valid_near_account_id(text: &str) -> bool {
    if text.len() < 2 || text.len() > NEAR_ACCOUNT_MAX_LEN {
        return false;
    }
    let mut previous_is_separator = true;
    for byte in text.bytes() {
        let is_separator = matches!(byte, b'-' | b'_' | b'.');
        let is_alnum = byte.is_ascii_lowercase() || byte.is_ascii_digit();
        if !is_separator && !is_alnum {
            return false;
        }
        if is_separator && previous_is_separator {
            return false;
        }
        previous_is_separator = is_separator;
    }
    !previous_is_separator
}

/// EIP-712 domain of a RoseVault deployment: name `RoseVault`, version `1`, no salt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Eip712Domain {
    /// Chain id ([`BASE_SEPOLIA_CHAIN_ID`] for this deployment).
    pub chain_id: u64,
    /// The RoseVault address.
    pub verifying_contract: Address,
}

impl Eip712Domain {
    /// `keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(name), keccak256(version),
    /// chainId, verifyingContract))`.
    pub fn separator(&self) -> Word {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&EIP712_DOMAIN_TYPEHASH);
        encoded.extend_from_slice(&DOMAIN_NAME_HASH);
        encoded.extend_from_slice(&DOMAIN_VERSION_HASH);
        encoded.extend_from_slice(&word_from_u128(u128::from(self.chain_id)));
        encoded.extend_from_slice(&word_from_address(&self.verifying_contract));
        keccak256(&encoded)
    }

    /// `keccak256(0x19 0x01 || separator || struct_hash)`.
    pub fn digest(&self, struct_hash: &Word) -> Word {
        let mut message = Vec::with_capacity(2 + 64);
        message.extend_from_slice(&[0x19, 0x01]);
        message.extend_from_slice(&self.separator());
        message.extend_from_slice(struct_hash);
        keccak256(&message)
    }
}

/// `Transfer(address token,address to,uint256 amount,uint256 id)`: an ERC-20 transfer out of the
/// vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferAuthorization {
    /// Token to transfer.
    pub token: Address,
    /// Recipient.
    pub to: Address,
    /// Amount in token base units.
    pub amount: u128,
    /// Authorization id, unique across transfers and releases (the vault's replay bitmap).
    pub id: u64,
}

impl TransferAuthorization {
    /// `keccak256(abi.encode(TRANSFER_TYPEHASH, token, to, amount, id))`.
    pub fn struct_hash(&self) -> Word {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&TRANSFER_TYPEHASH);
        encoded.extend_from_slice(&word_from_address(&self.token));
        encoded.extend_from_slice(&word_from_address(&self.to));
        encoded.extend_from_slice(&word_from_u128(self.amount));
        encoded.extend_from_slice(&word_from_u128(u128::from(self.id)));
        keccak256(&encoded)
    }

    /// The digest `executeTransfer` recovers the signer from.
    pub fn digest(&self, domain: &Eip712Domain) -> Word {
        domain.digest(&self.struct_hash())
    }
}

/// `Release(address lockup,uint256 streamId,address to,uint256 id)`: a stream NFT leaving the
/// vault after its withdrawable balance was moved into the vault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseAuthorization {
    /// Sablier Lockup contract.
    pub lockup: Address,
    /// Stream id.
    pub stream_id: u64,
    /// New owner of the stream.
    pub to: Address,
    /// Authorization id, unique across transfers and releases.
    pub id: u64,
}

impl ReleaseAuthorization {
    /// `keccak256(abi.encode(RELEASE_TYPEHASH, lockup, streamId, to, id))`.
    pub fn struct_hash(&self) -> Word {
        let mut encoded = Vec::with_capacity(5 * 32);
        encoded.extend_from_slice(&RELEASE_TYPEHASH);
        encoded.extend_from_slice(&word_from_address(&self.lockup));
        encoded.extend_from_slice(&word_from_u128(u128::from(self.stream_id)));
        encoded.extend_from_slice(&word_from_address(&self.to));
        encoded.extend_from_slice(&word_from_u128(u128::from(self.id)));
        keccak256(&encoded)
    }

    /// The digest `executeRelease` recovers the signer from.
    pub fn digest(&self, domain: &Eip712Domain) -> Word {
        domain.digest(&self.struct_hash())
    }
}

/// `true` when the digest is a canonical secp256k1 scalar (strictly below `n`), the condition
/// the MPC `sign` method enforces on `Ecdsa` payloads. A keccak digest fails this with
/// probability about `2^-128`; the engine must refuse to request such a signature.
pub fn is_valid_ecdsa_payload(digest: &Word) -> bool {
    digest < &SECP256K1_N
}

/// `a - b` for big-endian words with `a >= b`.
fn sub_words(a: &Word, b: &Word) -> Word {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut digit = i16::from(a[i]) - i16::from(b[i]) - borrow;
        borrow = i16::from(digit < 0);
        if digit < 0 {
            digit += 256;
        }
        out[i] = digit as u8;
    }
    out
}

/// `true` when `s <= n / 2` (EIP-2, enforced by OpenZeppelin `ECDSA` and RoseVault).
pub fn is_low_s(s: &Word) -> bool {
    s <= &SECP256K1_HALF_N
}

/// Why an MPC response cannot be turned into an Ethereum signature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignatureError {
    /// `big_r` is not a compressed point (prefix `02` or `03`).
    BigRPrefix,
    /// `r` or `s` is zero, or not below `n`.
    ZeroOrOutOfRange,
    /// `recovery_id > 1` cannot be expressed as `v` in `{27, 28}`.
    RecoveryId,
}

/// An Ethereum signature in the form `executeTransfer` and `executeRelease` take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EvmSignature {
    /// `r`, the x coordinate of `big_r`.
    pub r: Word,
    /// `s`, low.
    pub s: Word,
    /// `27 + recovery_id`.
    pub v: u8,
}

impl EvmSignature {
    /// Maps an MPC secp256k1 response to `(r, s, v)` with `v = 27 + recovery_id`.
    ///
    /// `recovery_id` is taken from the response and never derived from the prefix of `big_r`:
    /// across live signatures all four prefix and id combinations occur, because the nodes
    /// normalize `s` to its low form, which flips the id. A high `s` (which the live contract
    /// never returns) is normalized the same way, `s' = n - s` with the recovery id flipped,
    /// since the vault only accepts low-s signatures and both forms prove the same signer.
    pub fn from_mpc(signature: &Secp256k1Signature) -> Result<Self, SignatureError> {
        let big_r = signature.big_r.affine_point;
        if big_r[0] != 0x02 && big_r[0] != 0x03 {
            return Err(SignatureError::BigRPrefix);
        }
        let r: Word = big_r[1..].try_into().expect("32 bytes after the prefix");
        Self::from_parts(r, signature.s.scalar, signature.recovery_id)
    }

    /// `(r, s, recovery_id)` checked and normalized to low `s` (see [`Self::from_mpc`]).
    pub fn from_parts(r: Word, s: Word, recovery_id: u8) -> Result<Self, SignatureError> {
        if r == [0; 32] || s == [0; 32] || r >= SECP256K1_N || s >= SECP256K1_N {
            return Err(SignatureError::ZeroOrOutOfRange);
        }
        if recovery_id > 1 {
            return Err(SignatureError::RecoveryId);
        }
        let (s, recovery_id) = if is_low_s(&s) {
            (s, recovery_id)
        } else {
            (sub_words(&SECP256K1_N, &s), recovery_id ^ 1)
        };
        Ok(Self {
            r,
            s,
            v: 27 + recovery_id,
        })
    }

    /// 65-byte `r || s || v`, the layout of OpenZeppelin `ECDSA.recover(hash, bytes)`.
    pub fn to_bytes(&self) -> [u8; 65] {
        let mut out = [0u8; 65];
        out[..32].copy_from_slice(&self.r);
        out[32..64].copy_from_slice(&self.s);
        out[64] = self.v;
        out
    }
}

/// Why a NEAR-rendered secp256k1 key does not parse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The key does not start with `secp256k1:`.
    Prefix,
    /// The base58 payload is malformed or is not 64 bytes.
    Encoding,
}

/// `"secp256k1:<base58 of the 64-byte x || y>"`, the form `derived_public_key` and `public_key`
/// return on domain 0, to the raw public key.
pub fn parse_near_secp256k1(key: &str) -> Result<[u8; 64], KeyError> {
    let encoded = key.strip_prefix("secp256k1:").ok_or(KeyError::Prefix)?;
    let mut bytes = [0u8; 64];
    match bs58::decode(encoded).onto(&mut bytes) {
        Ok(64) => Ok(bytes),
        _ => Err(KeyError::Encoding),
    }
}

/// Ethereum address of an uncompressed public key: last 20 bytes of `keccak256(x || y)`.
pub fn address_from_public_key(public_key: &[u8; 64]) -> Address {
    keccak256(public_key)[12..].try_into().expect("20 bytes")
}

/// Ethereum address of a NEAR-rendered secp256k1 key.
pub fn address_from_near_public_key(key: &str) -> Result<Address, KeyError> {
    parse_near_secp256k1(key).map(|public_key| address_from_public_key(&public_key))
}
