//! RoseVault logs, EIP-712 digests and the MPC signature mapping against recorded facts: the
//! Base Sepolia receipts of the vault spike, the viem known-answer digests asserted in the
//! Foundry suite, and a real domain-0 MPC signature.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use proptest::prelude::*;
use rose_engine::foreign::evm::{
    address_from_near_public_key, address_from_public_key, is_low_s, is_valid_ecdsa_payload,
    is_valid_near_account_id, keccak256, parse_address, parse_near_secp256k1, word_from_address,
    word_from_u128, CashDeposited, Eip712Domain, EvmSignature, KeyError, LogError, LogLocation,
    ReleaseAuthorization, SignatureError, StreamDeposited, TransferAuthorization, Word,
    BASE_SEPOLIA_CHAIN_ID, CASH_DEPOSITED_TOPIC, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH,
    EIP712_DOMAIN_TYPEHASH, RELEASE_TYPEHASH, SECP256K1_HALF_N, SECP256K1_N,
    STREAM_DEPOSITED_TOPIC, TRANSFER_TYPEHASH,
};
use rose_engine::foreign::mpc::{
    parse_hex, parse_hex_array, Bytes20, Bytes32, EvmLog, Secp256k1Signature,
};
use rose_engine::unlock::SablierLinearStream;
use serde_json::Value;

/// Three RoseVault logs recorded on Base Sepolia (2026-11-04) with their decoded fields.
const VAULT_LOGS: &str = include_str!("vectors/foreign/evm_vault_logs.json");
/// A real domain-0 MPC signature over a RoseVault `Transfer` digest.
const SIGN_FIXTURE: &str = include_str!("vectors/foreign/evm_mpc_sign_fixture.json");

fn word(text: &str) -> Word {
    parse_hex_array(text).expect("32 bytes of hex")
}

fn address(text: &str) -> [u8; 20] {
    parse_address(text).expect("20 bytes of hex")
}

fn u128_field(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

fn location(log: &Value) -> LogLocation {
    let number = |key: &str| {
        u64::from_str_radix(log[key].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    };
    LogLocation {
        transaction_hash: word(log["transactionHash"].as_str().unwrap()),
        transaction_index: number("transactionIndex"),
        block_hash: word(log["blockHash"].as_str().unwrap()),
        block_number: number("blockNumber"),
        log_index: number("logIndex"),
    }
}

fn observed_evm_log(log: &Value) -> EvmLog {
    let at = location(log);
    EvmLog {
        removed: log["removed"].as_bool().unwrap(),
        log_index: at.log_index,
        transaction_index: at.transaction_index,
        transaction_hash: Bytes32(at.transaction_hash),
        block_hash: Bytes32(at.block_hash),
        block_number: at.block_number,
        address: Bytes20(address(log["address"].as_str().unwrap())),
        data: log["data"].as_str().unwrap().to_string(),
        topics: log["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|topic| Bytes32(word(topic.as_str().unwrap())))
            .collect(),
    }
}

fn topics(log: &Value) -> Vec<Word> {
    log["topics"]
        .as_array()
        .unwrap()
        .iter()
        .map(|topic| word(topic.as_str().unwrap()))
        .collect()
}

#[test]
fn event_signatures_and_typehashes_are_keccak_of_their_strings() {
    assert_eq!(
        keccak256(StreamDeposited::SIGNATURE.as_bytes()),
        STREAM_DEPOSITED_TOPIC
    );
    assert_eq!(StreamDeposited::TOPIC, STREAM_DEPOSITED_TOPIC);
    assert_eq!(
        StreamDeposited::SIGNATURE,
        "StreamDeposited(address,string,address,uint256,address,uint8,uint128,uint128,uint40,uint40,uint40,uint40,uint128,uint128,bool,bool,uint40)"
    );
    assert_eq!(
        keccak256(CashDeposited::SIGNATURE.as_bytes()),
        CASH_DEPOSITED_TOPIC
    );
    assert_eq!(CashDeposited::TOPIC, CASH_DEPOSITED_TOPIC);
    assert_eq!(
        keccak256(b"Transfer(address token,address to,uint256 amount,uint256 id)"),
        TRANSFER_TYPEHASH
    );
    assert_eq!(
        keccak256(
            b"Release(address lockup,uint256 streamId,address to,bool vestedToRecipient,uint256 id)"
        ),
        RELEASE_TYPEHASH
    );
    assert_eq!(
        keccak256(
            b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        ),
        EIP712_DOMAIN_TYPEHASH
    );
    assert_eq!(keccak256(b"RoseVault"), DOMAIN_NAME_HASH);
    assert_eq!(keccak256(b"1"), DOMAIN_VERSION_HASH);
}

#[test]
fn live_stream_deposited_logs_are_rebuilt_byte_for_byte() {
    let vectors: Value = serde_json::from_str(VAULT_LOGS).unwrap();
    let vault = address(vectors["vault"].as_str().unwrap());
    let mut checked = 0;
    for entry in vectors["logs"].as_array().unwrap() {
        if entry["event"] != "StreamDeposited" {
            continue;
        }
        let log = &entry["log"];
        let fields = &entry["fields"];
        let expected = StreamDeposited {
            sender: address(fields["sender"].as_str().unwrap()),
            near_account: fields["near_account"].as_str().unwrap().to_string(),
            lockup: address(fields["lockup"].as_str().unwrap()),
            stream_id: fields["stream_id"].as_u64().unwrap(),
            token: address(fields["token"].as_str().unwrap()),
            decimals: fields["decimals"].as_u64().unwrap() as u8,
            deposited: u128_field(&fields["deposited"]),
            withdrawn: u128_field(&fields["withdrawn"]),
            start: fields["start"].as_u64().unwrap(),
            cliff: fields["cliff"].as_u64().unwrap(),
            end: fields["end"].as_u64().unwrap(),
            granularity: fields["granularity"].as_u64().unwrap(),
            start_unlock: u128_field(&fields["start_unlock"]),
            cliff_unlock: u128_field(&fields["cliff_unlock"]),
            cancelable: fields["cancelable"].as_bool().unwrap(),
            transferable: fields["transferable"].as_bool().unwrap(),
            timestamp: fields["timestamp"].as_u64().unwrap(),
        };
        let data = parse_hex(log["data"].as_str().unwrap()).unwrap();
        assert_eq!(expected.topics(), topics(log), "{}", entry["tx"]);
        assert_eq!(expected.data(), data, "{}", entry["tx"]);
        assert_eq!(
            StreamDeposited::decode(&topics(log), &data).unwrap(),
            expected
        );
        assert_eq!(
            expected.evm_log(vault, &location(log)),
            observed_evm_log(log)
        );
        let stream = SablierLinearStream::new(expected.sablier_params()).unwrap();
        assert_eq!(stream.params().deposited, expected.deposited);
        checked += 1;
    }
    assert_eq!(checked, 2);
}

#[test]
fn live_cash_deposited_log_is_rebuilt_byte_for_byte() {
    let vectors: Value = serde_json::from_str(VAULT_LOGS).unwrap();
    let vault = address(vectors["vault"].as_str().unwrap());
    let entry = vectors["logs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["event"] == "CashDeposited")
        .unwrap();
    let log = &entry["log"];
    let fields = &entry["fields"];
    let expected = CashDeposited {
        sender: address(fields["sender"].as_str().unwrap()),
        token: address(fields["token"].as_str().unwrap()),
        round_id: fields["round_id"].as_u64().unwrap(),
        near_account: fields["near_account"].as_str().unwrap().to_string(),
        amount: u128_field(&fields["amount"]),
        timestamp: fields["timestamp"].as_u64().unwrap(),
    };
    let data = parse_hex(log["data"].as_str().unwrap()).unwrap();
    assert_eq!(expected.topics(), topics(log));
    assert_eq!(expected.data(), data);
    assert_eq!(
        CashDeposited::decode(&topics(log), &data).unwrap(),
        expected
    );
    assert_eq!(
        expected.evm_log(vault, &location(log)),
        observed_evm_log(log)
    );
}

#[test]
fn decoding_rejects_every_deviation_from_the_layout() {
    let vectors: Value = serde_json::from_str(VAULT_LOGS).unwrap();
    let entry = &vectors["logs"][0];
    let log = &entry["log"];
    let topics = topics(log);
    let data = parse_hex(log["data"].as_str().unwrap()).unwrap();
    assert!(StreamDeposited::decode(&topics, &data).is_ok());

    assert_eq!(
        StreamDeposited::decode(&topics[..2], &data),
        Err(LogError::TopicCount)
    );
    let mut wrong_signature = topics.clone();
    wrong_signature[0] = CASH_DEPOSITED_TOPIC;
    assert_eq!(
        StreamDeposited::decode(&wrong_signature, &data),
        Err(LogError::Signature)
    );
    let mut dirty_sender = topics.clone();
    dirty_sender[1][0] = 1;
    assert_eq!(
        StreamDeposited::decode(&dirty_sender, &data),
        Err(LogError::Range)
    );

    assert_eq!(
        StreamDeposited::decode(&topics, &data[..data.len() - 32]),
        Err(LogError::Length)
    );
    assert_eq!(
        StreamDeposited::decode(&topics, &data[..data.len() - 1]),
        Err(LogError::Length)
    );
    let mut extra_word = data.clone();
    extra_word.extend_from_slice(&[0; 32]);
    assert_eq!(
        StreamDeposited::decode(&topics, &extra_word),
        Err(LogError::Length)
    );
    let mut dirty_padding = data.clone();
    *dirty_padding.last_mut().unwrap() = 1;
    assert_eq!(
        StreamDeposited::decode(&topics, &dirty_padding),
        Err(LogError::Length)
    );
    let mut wrong_offset = data.clone();
    wrong_offset[31] = 0xc0;
    assert_eq!(
        StreamDeposited::decode(&topics, &wrong_offset),
        Err(LogError::Offset)
    );
    let mut bool_two = data.clone();
    bool_two[12 * 32 + 31] = 2;
    assert_eq!(
        StreamDeposited::decode(&topics, &bool_two),
        Err(LogError::Bool)
    );
    let mut wide_uint8 = data.clone();
    wide_uint8[3 * 32 + 30] = 1;
    assert_eq!(
        StreamDeposited::decode(&topics, &wide_uint8),
        Err(LogError::Range)
    );
    let mut wide_uint40 = data.clone();
    wide_uint40[6 * 32 + 26] = 1;
    assert_eq!(
        StreamDeposited::decode(&topics, &wide_uint40),
        Err(LogError::Range)
    );
    let mut bad_account = data.clone();
    bad_account[16 * 32] = b'R';
    assert_eq!(
        StreamDeposited::decode(&topics, &bad_account),
        Err(LogError::NearAccount)
    );
    let mut long_account = data.clone();
    long_account[15 * 32 + 31] = 65;
    assert_eq!(
        StreamDeposited::decode(&topics, &long_account),
        Err(LogError::NearAccount)
    );
}

#[test]
fn near_account_ids_follow_the_nearcore_rule() {
    for valid in [
        "ab",
        "rose-app.testnet",
        "a_b-c.d",
        "0123456789",
        "engine.rose-app.testnet",
        &"a".repeat(64),
    ] {
        assert!(is_valid_near_account_id(valid), "{valid}");
    }
    for invalid in [
        "",
        "a",
        "A.testnet",
        "-ab",
        "ab-",
        "a--b",
        "a._b",
        "a..b",
        "a.b.",
        "ab c",
        "ab@c",
        &"a".repeat(65),
    ] {
        assert!(!is_valid_near_account_id(invalid), "{invalid}");
    }
}

#[test]
fn eip712_digests_match_the_known_answer_vectors() {
    let domain = Eip712Domain {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        verifying_contract: address("0x00000000000000000000000000000000000A11cE"),
    };
    let transfer = TransferAuthorization {
        token: address("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
        to: address("0x000000000000000000000000000000000000b0b0"),
        amount: 1_000_000,
        id: 7,
    };
    assert_eq!(
        transfer.digest(&domain),
        word("0x652ed7c219938bcc420b0786454c4e4a58b5baeed9dd1cfdf3ba8c4b1e08ac01")
    );
    let release = ReleaseAuthorization {
        lockup: address("0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e"),
        stream_id: 81,
        to: address("0x000000000000000000000000000000000000b0b0"),
        vested_to_recipient: false,
        id: 8,
    };
    assert_eq!(
        release.digest(&domain),
        word("0xab3684e318c5c016035a36f948f02e970040e271317ea09a327d2c59f6fef666")
    );
    let refused_return = ReleaseAuthorization {
        vested_to_recipient: true,
        ..release
    };
    assert_eq!(
        refused_return.digest(&domain),
        word("0x1aa2f755fbde4c0062a5437278478f1b0f3820980c2ef5560ac419d7dc5eafe3")
    );
    let deployed = Eip712Domain {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        verifying_contract: address("0x3985dDBBE8477Dd42bd5E19F8726Aae7a339b5e0"),
    };
    assert_eq!(
        deployed.separator(),
        word("0x312d1220ad1f3ce21f76e2cd3207868fd5acda7452d127a4242a54246997a816")
    );
}

#[test]
fn real_mpc_signature_recovers_the_derived_address() {
    let fixture: Value = serde_json::from_str(SIGN_FIXTURE).unwrap();
    let eip712 = &fixture["eip712"];
    let domain = Eip712Domain {
        chain_id: eip712["domain"]["chainId"].as_u64().unwrap(),
        verifying_contract: address(eip712["domain"]["verifyingContract"].as_str().unwrap()),
    };
    let message = &eip712["message"];
    let transfer = TransferAuthorization {
        token: address(message["token"].as_str().unwrap()),
        to: address(message["to"].as_str().unwrap()),
        amount: u128_field(&message["amount"]),
        id: message["id"].as_str().unwrap().parse().unwrap(),
    };
    assert_eq!(
        domain.separator(),
        word(eip712["domainSeparator"].as_str().unwrap())
    );
    assert_eq!(
        transfer.struct_hash(),
        word(eip712["structHash"].as_str().unwrap())
    );
    let digest = transfer.digest(&domain);
    assert_eq!(digest, word(fixture["digest"].as_str().unwrap()));
    assert!(is_valid_ecdsa_payload(&digest));

    let response: Secp256k1Signature =
        serde_json::from_value(fixture["mpcResponse"].clone()).unwrap();
    let signature = EvmSignature::from_mpc(&response).unwrap();
    assert_eq!(signature.r, word(fixture["r"].as_str().unwrap()));
    assert_eq!(signature.s, word(fixture["s"].as_str().unwrap()));
    assert_eq!(u64::from(signature.v), fixture["v"].as_u64().unwrap());
    assert_eq!(
        signature.to_bytes().to_vec(),
        parse_hex(fixture["signature"].as_str().unwrap()).unwrap()
    );
    assert!(is_low_s(&signature.s));

    let k256_signature = Signature::from_scalars(signature.r, signature.s).unwrap();
    let key = VerifyingKey::recover_from_prehash(
        &digest,
        &k256_signature,
        RecoveryId::from_byte(signature.v - 27).unwrap(),
    )
    .unwrap();
    let recovered: [u8; 64] = key.to_encoded_point(false).as_bytes()[1..]
        .try_into()
        .unwrap();
    let derived = parse_near_secp256k1(fixture["derivedPublicKey"].as_str().unwrap()).unwrap();
    assert_eq!(recovered, derived);
    assert_eq!(
        recovered.to_vec(),
        parse_hex(fixture["derivedPublicKeyHex"].as_str().unwrap()).unwrap()
    );
    let signer = address(fixture["signer"].as_str().unwrap());
    assert_eq!(address_from_public_key(&derived), signer);
    assert_eq!(
        address_from_near_public_key(fixture["derivedPublicKey"].as_str().unwrap()).unwrap(),
        signer
    );
}

/// `n - s` for a big-endian scalar.
fn n_minus(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut digit = i16::from(SECP256K1_N[i]) - i16::from(s[i]) - borrow;
        borrow = i16::from(digit < 0);
        if digit < 0 {
            digit += 256;
        }
        out[i] = digit as u8;
    }
    out
}

#[test]
fn signature_mapping_refuses_what_the_vault_refuses() {
    let fixture: Value = serde_json::from_str(SIGN_FIXTURE).unwrap();
    let good: Secp256k1Signature = serde_json::from_value(fixture["mpcResponse"].clone()).unwrap();

    let low = EvmSignature::from_mpc(&good).unwrap();
    let mut high_s = good.clone();
    high_s.s.scalar = n_minus(&good.s.scalar);
    high_s.recovery_id ^= 1;
    assert_eq!(
        EvmSignature::from_mpc(&high_s),
        Ok(low),
        "a high s is normalized to the same low-s signature, recovery id flipped back"
    );
    let mut s_at_n = good.clone();
    s_at_n.s.scalar = SECP256K1_N;
    assert_eq!(
        EvmSignature::from_mpc(&s_at_n),
        Err(SignatureError::ZeroOrOutOfRange)
    );
    let mut boundary = good.clone();
    boundary.s.scalar = SECP256K1_HALF_N;
    assert!(EvmSignature::from_mpc(&boundary).is_ok());

    let mut recovery = good.clone();
    recovery.recovery_id = 2;
    assert_eq!(
        EvmSignature::from_mpc(&recovery),
        Err(SignatureError::RecoveryId)
    );
    recovery.recovery_id = 1;
    assert_eq!(EvmSignature::from_mpc(&recovery).unwrap().v, 28);

    let mut prefix = good.clone();
    prefix.big_r.affine_point[0] = 0x04;
    assert_eq!(
        EvmSignature::from_mpc(&prefix),
        Err(SignatureError::BigRPrefix)
    );

    let mut zero_s = good.clone();
    zero_s.s.scalar = [0; 32];
    assert_eq!(
        EvmSignature::from_mpc(&zero_s),
        Err(SignatureError::ZeroOrOutOfRange)
    );
    let mut big_r_out_of_range = good;
    big_r_out_of_range.big_r.affine_point[1..].copy_from_slice(&SECP256K1_N);
    assert_eq!(
        EvmSignature::from_mpc(&big_r_out_of_range),
        Err(SignatureError::ZeroOrOutOfRange)
    );
}

#[test]
fn ecdsa_payload_bound_is_the_group_order() {
    let mut n_plus_1 = SECP256K1_N;
    n_plus_1[31] += 1;
    assert!(!is_valid_ecdsa_payload(&n_plus_1));
    assert!(!is_valid_ecdsa_payload(&SECP256K1_N));
    let mut n_minus_1 = SECP256K1_N;
    n_minus_1[31] -= 1;
    assert!(is_valid_ecdsa_payload(&n_minus_1));
    assert!(is_valid_ecdsa_payload(&[0; 32]));
}

#[test]
fn near_secp256k1_keys_parse_strictly() {
    assert_eq!(
        parse_near_secp256k1("ed25519:ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL"),
        Err(KeyError::Prefix)
    );
    assert_eq!(
        parse_near_secp256k1("secp256k1:ERKmrj6yveQaKExLsfuiJZW19MYnwFhUUwdLBPniG6GL"),
        Err(KeyError::Encoding)
    );
    assert_eq!(
        parse_near_secp256k1("secp256k1:0OIl"),
        Err(KeyError::Encoding)
    );
}

#[test]
fn vault_spike_release_and_transfer_signatures_recover_the_spike_signer() {
    let signer = address("0xFa76B8f304d2A87FCAee0c258A76118368d0d671");
    let domain = Eip712Domain {
        chain_id: BASE_SEPOLIA_CHAIN_ID,
        verifying_contract: address("0x3985dDBBE8477Dd42bd5E19F8726Aae7a339b5e0"),
    };
    // The spike vault predates `vestedToRecipient`: its release digest uses the four-field type.
    let spike_release_typehash =
        keccak256(b"Release(address lockup,uint256 streamId,address to,uint256 id)");
    let mut spike_release = Vec::with_capacity(5 * 32);
    spike_release.extend_from_slice(&spike_release_typehash);
    spike_release.extend_from_slice(&word_from_address(&address(
        "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e",
    )));
    spike_release.extend_from_slice(&word_from_u128(83));
    spike_release.extend_from_slice(&word_from_address(&signer));
    spike_release.extend_from_slice(&word_from_u128(1));
    let release_digest = domain.digest(&keccak256(&spike_release));
    let transfer = TransferAuthorization {
        token: address("0x17E75069DD837EDA977AbEDF7a455aDda42868A9"),
        to: signer,
        amount: 9_703_196_347_031_964,
        id: 2,
    };
    let cases = [
        (
            release_digest,
            "0xe25bf93a17740ebde1054daaac8fde302fbaab819e01b917c92f6066aeaf3d74",
            "0xc6fc6fd56b93fec5a1fd7cc0634db7f068bb4b8f4da7e4b509dc3c462f216da1",
            "0x7e9ee972d847a7ba2d827f4091f9e81051856615fee4f6d8be9e4dcfbedd4f52",
        ),
        (
            transfer.digest(&domain),
            "0xb04bf2a1307055113f5a3f8a5b2b6914618867c0fff11710846c19874d996243",
            "0xaa74e3b4d80f55a3248cc30306f314160c58c328472883e6c316803d51ddccff",
            "0x0cea94d0381b6a9ef8657230edcb7c0bfb0092067a6aeae09a1c16f73158c16d",
        ),
    ];
    for (digest, expected_digest, r, s) in cases {
        assert_eq!(digest, word(expected_digest));
        let signature = Signature::from_scalars(word(r), word(s)).unwrap();
        let key = VerifyingKey::recover_from_prehash(
            &digest,
            &signature,
            RecoveryId::from_byte(0).unwrap(),
        )
        .unwrap();
        let public_key: [u8; 64] = key.to_encoded_point(false).as_bytes()[1..]
            .try_into()
            .unwrap();
        assert_eq!(address_from_public_key(&public_key), signer);
    }
}

fn near_account_strategy() -> impl Strategy<Value = String> {
    "[a-z0-9]{1,20}(\\.[a-z0-9]{1,20}){0,2}"
        .prop_filter("nearcore rule", |text| is_valid_near_account_id(text))
}

proptest! {
    #[test]
    fn stream_deposited_round_trips(
        sender in any::<[u8; 20]>(),
        near_account in near_account_strategy(),
        lockup in any::<[u8; 20]>(),
        stream_id in any::<u64>(),
        token in any::<[u8; 20]>(),
        decimals in any::<u8>(),
        deposited in any::<u128>(),
        withdrawn in any::<u128>(),
        start in 0u64..(1 << 40),
        cliff in 0u64..(1 << 40),
        end in 0u64..(1 << 40),
        granularity in 0u64..(1 << 40),
        start_unlock in any::<u128>(),
        cliff_unlock in any::<u128>(),
        cancelable in any::<bool>(),
        transferable in any::<bool>(),
        timestamp in 0u64..(1 << 40),
    ) {
        let event = StreamDeposited {
            sender, near_account, lockup, stream_id, token, decimals, deposited, withdrawn, start, cliff, end,
            granularity, start_unlock, cliff_unlock, cancelable, transferable, timestamp,
        };
        let data = event.data();
        prop_assert_eq!(data.len(), 16 * 32 + event.near_account.len().div_ceil(32) * 32);
        prop_assert_eq!(StreamDeposited::decode(&event.topics(), &data).unwrap(), event);
    }

    #[test]
    fn cash_deposited_round_trips(
        sender in any::<[u8; 20]>(),
        token in any::<[u8; 20]>(),
        round_id in any::<u64>(),
        near_account in near_account_strategy(),
        amount in any::<u128>(),
        timestamp in 0u64..(1 << 40),
    ) {
        let event = CashDeposited { sender, token, round_id, near_account, amount, timestamp };
        prop_assert_eq!(CashDeposited::decode(&event.topics(), &event.data()).unwrap(), event);
    }
}
