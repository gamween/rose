//! The MPC mirror against live `v1.signer-prod.testnet` (3.18.0) responses and the wire-format
//! catalog of `near-mpc-contract-interface`.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use proptest::prelude::*;
use rose_engine::foreign::evm::parse_near_secp256k1;
use rose_engine::foreign::mpc::{
    parse_hex, parse_hex_array, payload_hash, Bytes20, Bytes32, Ed25519Signature, EvmExtractor,
    EvmFinality, EvmLog, EvmRpcRequest, ExtractedValue, ForeignChainRpcRequest,
    ForeignTxSignPayload, SignCall, SignPayload, SignatureResponse, SvmAccount, SvmExtractor,
    SvmFinality, SvmRpcRequest, VerifyForeignTransactionCall, VerifyForeignTransactionResponse,
    DOMAIN_ED25519, DOMAIN_FOREIGN_TX, DOMAIN_SECP256K1, PAYLOAD_VERSION_V1,
};
use serde_json::{json, Value};

/// Ten live `verify_foreign_transaction` round trips recorded in the day-1 spike: the exact
/// request JSON, the RPC logs or account bytes the nodes read, and the MPC response.
const LIVE_VECTORS: &str = include_str!("vectors/foreign/mpc_live_vectors.json");

/// `public_key {"domain_id": 3}` on `v1.signer-prod.testnet`.
const DOMAIN_3_PUBLIC_KEY: &str =
    "secp256k1:2KGCoy2pZt7n85QfJnQzCT1eHySuNpquUfNc8ySpRbr15F5kqU7agJYjfo5RkrzNd4tZimDFv2wAZri7RRZ32qj1";

fn bytes32(text: &str) -> Bytes32 {
    Bytes32(parse_hex_array(text).expect("32 bytes of hex"))
}

fn rpc_log(value: &Value) -> EvmLog {
    let number = |key: &str| {
        u64::from_str_radix(value[key].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    };
    EvmLog {
        removed: value["removed"].as_bool().unwrap(),
        log_index: number("logIndex"),
        transaction_index: number("transactionIndex"),
        transaction_hash: bytes32(value["transactionHash"].as_str().unwrap()),
        block_hash: bytes32(value["blockHash"].as_str().unwrap()),
        block_number: number("blockNumber"),
        address: Bytes20(parse_hex_array(value["address"].as_str().unwrap()).unwrap()),
        data: value["data"].as_str().unwrap().to_string(),
        topics: value["topics"]
            .as_array()
            .unwrap()
            .iter()
            .map(|topic| bytes32(topic.as_str().unwrap()))
            .collect(),
    }
}

/// The request and the values of one live vector.
fn request_and_values(vector: &Value) -> (ForeignChainRpcRequest, Vec<ExtractedValue>) {
    let request = &vector["args"]["request"]["request"];
    if let Some(base) = request.get("Base") {
        let request: EvmRpcRequest = serde_json::from_value(base.clone()).unwrap();
        let values = vector["rpc_logs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|log| ExtractedValue::log(rpc_log(log)))
            .collect();
        (ForeignChainRpcRequest::Base(request), values)
    } else {
        let request: SvmRpcRequest = serde_json::from_value(request["Solana"].clone()).unwrap();
        let values = vector["rpc_accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|account| {
                ExtractedValue::account(SvmAccount {
                    owner: bytes32(account["owner_hex"].as_str().unwrap()),
                    data: parse_hex(account["data_hex"].as_str().unwrap()).unwrap(),
                })
            })
            .collect();
        (ForeignChainRpcRequest::Solana(request), values)
    }
}

fn live_vectors() -> Vec<Value> {
    serde_json::from_str::<Value>(LIVE_VECTORS)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn live_vectors_reproduce_the_signed_payload_hash() {
    let vectors = live_vectors();
    let mut base = 0;
    let mut solana = 0;
    for vector in &vectors {
        let (request, values) = request_and_values(vector);
        match request {
            ForeignChainRpcRequest::Base(_) => base += 1,
            ForeignChainRpcRequest::Solana(_) => solana += 1,
        }
        let response: VerifyForeignTransactionResponse =
            serde_json::from_value(vector["response"].clone()).unwrap();
        let computed = payload_hash(request.clone(), values.clone());
        assert_eq!(
            computed, response.payload_hash.0,
            "vector {}",
            vector["label"]
        );
        assert_eq!(
            ForeignTxSignPayload::v1(request, values).payload_hash(),
            computed
        );
    }
    // Pinned: the sandbox's mock MPC signs whatever hash a test registers, so these recorded
    // live responses are the only check of the byte layout against the real nodes. Re-record
    // them (never drop one) when `near/mpc` moves past 3.18.0.
    assert_eq!(
        (vectors.len(), base, solana),
        (10, 6, 4),
        "the recorded live vectors are all present"
    );
}

#[test]
fn live_vectors_match_the_call_json_the_engine_sends() {
    for vector in live_vectors() {
        let (request, _) = request_and_values(&vector);
        let mut call = VerifyForeignTransactionCall::new(request);
        assert_eq!(call.request.domain_id, DOMAIN_FOREIGN_TX);
        assert_eq!(call.request.payload_version, PAYLOAD_VERSION_V1);
        let args = &vector["args"];
        if let Some(expected) = args["request"].get("expected_payload_hash") {
            call.request.expected_payload_hash = Some(bytes32(expected.as_str().unwrap()));
        }
        assert_eq!(
            serde_json::to_value(&call).unwrap(),
            *args,
            "vector {}",
            vector["label"]
        );
        let parsed: VerifyForeignTransactionCall = serde_json::from_value(args.clone()).unwrap();
        assert_eq!(parsed, call);
    }
}

#[test]
fn live_responses_round_trip_through_json() {
    for vector in live_vectors() {
        let response: VerifyForeignTransactionResponse =
            serde_json::from_value(vector["response"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&response).unwrap(),
            vector["response"],
            "vector {}",
            vector["label"]
        );
        assert!(response.signature.as_secp256k1().is_some());
        assert!(response.signature.as_ed25519().is_none());
    }
}

#[test]
fn live_signatures_recover_to_the_domain_3_key() {
    let expected = parse_near_secp256k1(DOMAIN_3_PUBLIC_KEY).unwrap();
    for vector in live_vectors() {
        let response: VerifyForeignTransactionResponse =
            serde_json::from_value(vector["response"].clone()).unwrap();
        let signature = response.signature.as_secp256k1().unwrap();
        let r = &signature.big_r.affine_point[1..];
        let k256_signature = Signature::from_slice(&[r, &signature.s.scalar].concat()).unwrap();
        let key = VerifyingKey::recover_from_prehash(
            &response.payload_hash.0,
            &k256_signature,
            RecoveryId::from_byte(signature.recovery_id).unwrap(),
        )
        .unwrap();
        assert_eq!(
            &key.to_encoded_point(false).as_bytes()[1..],
            &expected[..],
            "vector {}",
            vector["label"]
        );
    }
}

#[test]
fn borsh_discriminants_match_the_real_enums() {
    let log = EvmLog {
        removed: false,
        log_index: 7,
        transaction_index: 5,
        transaction_hash: Bytes32([1; 32]),
        block_hash: Bytes32([2; 32]),
        block_number: 9,
        address: Bytes20([3; 20]),
        data: "0x".to_string(),
        topics: vec![],
    };
    let base = ForeignChainRpcRequest::Base(EvmRpcRequest {
        tx_id: Bytes32([1; 32]),
        extractors: vec![EvmExtractor::Log { log_index: 7 }],
        finality: EvmFinality::Safe,
    });
    let mut expected = vec![6u8];
    expected.extend_from_slice(&[1; 32]);
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.push(1);
    expected.extend_from_slice(&7u64.to_le_bytes());
    expected.push(1);
    assert_eq!(borsh::to_vec(&base).unwrap(), expected);

    let solana = ForeignChainRpcRequest::Solana(SvmRpcRequest {
        tx_id: rose_engine::foreign::mpc::Bytes64([4; 64]),
        finality: SvmFinality::Finalized,
        extractors: vec![SvmExtractor::AccountState {
            pubkey: Bytes32([5; 32]),
        }],
    });
    let mut expected = vec![2u8];
    expected.extend_from_slice(&[4; 64]);
    expected.push(1);
    expected.extend_from_slice(&1u32.to_le_bytes());
    expected.push(2);
    expected.extend_from_slice(&[5; 32]);
    assert_eq!(borsh::to_vec(&solana).unwrap(), expected);

    let evm_value = borsh::to_vec(&ExtractedValue::log(log)).unwrap();
    assert_eq!(&evm_value[..2], &[1, 1]);
    let svm_value = borsh::to_vec(&ExtractedValue::account(SvmAccount {
        owner: Bytes32([0; 32]),
        data: vec![],
    }))
    .unwrap();
    assert_eq!(&svm_value[..2], &[6, 1]);
    let payload = ForeignTxSignPayload::v1(base, vec![]).payload_bytes();
    assert_eq!(payload[0], 0);
    assert_eq!(payload[1], 6);
}

#[test]
fn finality_is_part_of_the_hash() {
    let request = |finality| {
        ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: Bytes32([1; 32]),
            extractors: vec![EvmExtractor::Log { log_index: 0 }],
            finality,
        })
    };
    assert_ne!(
        payload_hash(request(EvmFinality::Safe), vec![]),
        payload_hash(request(EvmFinality::Finalized), vec![])
    );
}

#[test]
fn sign_calls_match_the_wire_format_catalog() {
    let call = SignCall::ecdsa("test", [7; 32]);
    assert_eq!(call.request.domain_id, DOMAIN_SECP256K1);
    assert_eq!(
        serde_json::to_value(&call).unwrap(),
        json!({"request":{"path":"test","payload_v2":{"Ecdsa":"0707070707070707070707070707070707070707070707070707070707070707"},"domain_id":0}})
    );
    let call = SignCall::eddsa("vault/sol", vec![0xab, 0x00, 0xff]);
    assert_eq!(call.request.domain_id, DOMAIN_ED25519);
    assert_eq!(
        serde_json::to_value(&call).unwrap(),
        json!({"request":{"path":"vault/sol","payload_v2":{"Eddsa":"ab00ff"},"domain_id":1}})
    );
    let parsed: SignCall = serde_json::from_value(serde_json::to_value(&call).unwrap()).unwrap();
    assert_eq!(
        parsed.request.payload_v2,
        SignPayload::Eddsa(vec![0xab, 0x00, 0xff])
    );
}

#[test]
fn signature_responses_parse_both_schemes() {
    let secp = json!({"scheme":"Secp256k1","big_r":{"affine_point":"026df93ecb5f24b0743b4fbe61c20facf62f86e008e5ff8db7d4604b781d89e50e"},"s":{"scalar":"67807abd08d31ba24158b3afad7414de13b6a58e3f0a7949cab3b9e26a082bea"},"recovery_id":0});
    let response: SignatureResponse = serde_json::from_value(secp.clone()).unwrap();
    let signature = response.as_secp256k1().unwrap();
    assert_eq!(signature.big_r.affine_point[0], 0x02);
    assert_eq!(signature.recovery_id, 0);
    assert_eq!(serde_json::to_value(&response).unwrap(), secp);

    let bytes: Vec<u8> = (0..64).collect();
    let ed = json!({"scheme":"Ed25519","signature":bytes});
    let response: SignatureResponse = serde_json::from_value(ed.clone()).unwrap();
    let signature = response.as_ed25519().unwrap();
    assert_eq!(signature[63], 63);
    assert_eq!(serde_json::to_value(&response).unwrap(), ed);
    assert_eq!(
        response,
        SignatureResponse::Ed25519 {
            signature: Ed25519Signature(core::array::from_fn(|i| i as u8)),
        }
    );
    let short: Result<SignatureResponse, _> =
        serde_json::from_value(json!({"scheme":"Ed25519","signature":[1, 2, 3]}));
    assert!(short.is_err());
}

#[test]
fn hex_inputs_accept_a_prefix_and_any_case_but_output_is_canonical() {
    let upper = json!({"tx_id":"0xABCDEF0000000000000000000000000000000000000000000000000000000000","extractors":[{"Log":{"log_index":1}}],"finality":"Latest"});
    let request: EvmRpcRequest = serde_json::from_value(upper).unwrap();
    assert_eq!(&request.tx_id.0[..3], &[0xab, 0xcd, 0xef]);
    assert_eq!(
        serde_json::to_value(&request).unwrap()["tx_id"],
        "abcdef0000000000000000000000000000000000000000000000000000000000"
    );
    assert!(parse_hex_array::<32>("abcd").is_none());
    assert!(parse_hex("abc").is_none());
}

#[test]
fn log_data_must_be_canonical() {
    let mut log = EvmLog {
        removed: false,
        log_index: 0,
        transaction_index: 0,
        transaction_hash: Bytes32([0; 32]),
        block_hash: Bytes32([0; 32]),
        block_number: 0,
        address: Bytes20([0; 20]),
        data: "0xAB".to_string(),
        topics: vec![],
    };
    assert!(log.data_bytes().is_none());
    log.data = "ab".to_string();
    assert!(log.data_bytes().is_none());
    log.data = "0x".to_string();
    assert_eq!(log.data_bytes().unwrap(), Vec::<u8>::new());
}

proptest! {
    #[test]
    fn log_data_string_round_trips(data in proptest::collection::vec(any::<u8>(), 0..400)) {
        let text = EvmLog::data_string(&data);
        prop_assert!(text.starts_with("0x"));
        prop_assert_eq!(text.len(), 2 + 2 * data.len());
        let log = EvmLog {
            removed: false,
            log_index: 0,
            transaction_index: 0,
            transaction_hash: Bytes32([0; 32]),
            block_hash: Bytes32([0; 32]),
            block_number: 0,
            address: Bytes20([0; 20]),
            data: text,
            topics: vec![],
        };
        prop_assert_eq!(log.data_bytes().unwrap(), data);
    }
}
