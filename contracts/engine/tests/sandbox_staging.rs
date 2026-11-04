//! Replays transactions recorded on the staging engine `engine-s1.rose-app.testnet` against
//! the live MPC (`tests/vectors/sandbox/staging/*.json`, links inside): the engine deployed
//! under the same account name with the same init arguments and the account's real derived keys
//! must accept the recorded `register_base_deposit` arguments with the real
//! `verify_foreign_transaction` response, store the real CKD keys of rounds 0 and 1, and produce
//! the recorded `claim_base_tokens` digest, whose real signature (replayed only for that digest)
//! recovers to the real vault address. Run with
//! `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_staging -- --nocapture`.

mod sandbox_support;

use anyhow::Result;
use near_workspaces::types::{Gas, NearToken};
use sandbox_support::*;
use serde::Deserialize;
use serde_json::{json, Value};

const STAGING_ENGINE: &str = "engine-s1.rose-app.testnet";

#[derive(Deserialize)]
struct DerivedKeys {
    keys: Vec<RecordedDerivedKey>,
}

#[tokio::test]
async fn staging_recordings_replay_on_the_same_account_name() -> Result<()> {
    if !enabled("staging_recordings_replay_on_the_same_account_name") {
        return Ok(());
    }
    let gas = GasTable::new("staging replay");
    let deposit = StagingRecord::load("register_base_deposit")?;
    let claim = StagingRecord::load("claim_base_tokens")?;
    let rounds = [
        StagingRecord::load("close_round0")?,
        StagingRecord::load("close_round1")?,
    ];
    let init = {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../deployments/testnet.json"
        );
        let deployments: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        deployments["deployments"][STAGING_ENGINE]["near"]["engine"]["init_args"].clone()
    };
    let ckd_public_key = init["ckd_public_key"].as_str().unwrap().to_string();
    let derived: DerivedKeys = serde_json::from_str(&std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/vectors/sandbox/staging/derived_keys.json"
    ))?)?;
    let engine = Engine::deploy(EngineSpec {
        account: Some(STAGING_ENGINE),
        mpk: rose_ibe::parse_near_g2(&ckd_public_key)?,
        ckd_public_key,
        rose_vault: init["rose_vault"].as_str().unwrap().to_string(),
        base_cash_tokens: serde_json::from_value(init["base_cash_tokens"].clone())?,
        derived_keys: derived.keys,
    })
    .await?;
    assert_eq!(engine.id().as_str(), deposit.engine);
    engine.bootstrap(&gas).await?;

    // The recorded deposit: same arguments, the real attested response, the same units.
    let holder_id = deposit.args["fields"]["near_account"].as_str().unwrap();
    let holder = ensure_account(&engine.worker, holder_id).await?;
    let tx_id = deposit.mpc_request()?["request"]["Base"]["tx_id"]
        .as_str()
        .unwrap()
        .to_string();
    engine
        .prime_foreign_raw(&tx_id, &deposit.mpc_value()?)
        .await?;
    let class_id = deposit
        .log("class_created")
        .and_then(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["data"]["class_id"].clone())
        .unwrap();
    let class_id = class_id.as_str().unwrap().to_string();
    let registration: Value = engine
        .view(
            "registration_deposit_for",
            json!({ "account": holder_id, "class_id": class_id }),
        )
        .await?;
    let result = holder
        .call(engine.id(), "register_base_deposit")
        .args_json(&deposit.args)
        .deposit(NearToken::from_yoctonear(u128_of(&registration)?))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let result = gas.ok("register_base_deposit", result)?;
    assert!(result.logged("deposit_registered"), "{:?}", result.logs);
    let units = u128_of(&deposit.args["fields"]["deposited"])?;
    assert_eq!(engine.balance(holder.id(), &class_id).await?, units);
    eprintln!(
        "register_base_deposit: sandbox {:.2} Tgas, staging {:.2} Tgas",
        gas.tgas("register_base_deposit").unwrap(),
        deposit.tgas()
    );

    // Rounds 0 and 1 close with the real CKD outputs and store the keys the live callbacks
    // stored; the key of round 1 opens an ask sealed under the live master key.
    engine.fund(&holder, 1_000 * USDC, &gas).await?;
    for (round_id, record) in rounds.iter().enumerate() {
        let round_id = round_id as u64;
        let round = engine
            .create_exit(&holder, &class_id, USDC, 5, &gas)
            .await?;
        assert_eq!(round, round_id);
        let (ask, sealed) = engine
            .place_ask(&holder, round, units / 10, USDC / 2, units / 10, &gas)
            .await?;
        let response = record.mpc_value()?;
        let path = record.mpc_request()?["derivation_path"].as_str().unwrap();
        assert_eq!(path, rose_ibe::round_path(round_id));
        engine
            .prime_ckd_raw(
                path,
                response["big_y"].as_str().unwrap(),
                response["big_c"].as_str().unwrap(),
            )
            .await?;
        let result = engine.close_primed(&holder, round, &gas).await?;
        let live_key = record
            .log("key_received")
            .and_then(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["data"]["key"].clone())
            .unwrap();
        let view = engine.round(round).await?;
        assert_eq!(view["key"], live_key, "round {round_id}: {:?}", result.logs);
        eprintln!(
            "close round {round_id}: sandbox {:.2} Tgas, staging {:.2} Tgas",
            gas.tgas("close").unwrap(),
            record.tgas()
        );
        if round_id == 1 {
            engine.open(&holder, round, ask, &sealed, &gas).await?;
            let bid: Value = engine
                .view(
                    "get_bid",
                    json!({ "round_id": round.to_string(), "bid_id": ask }),
                )
                .await?;
            assert_eq!(bid["status"], "Opened");
        }
    }

    // The recorded claim: same arguments and payout id, so the same digest, signed by the real
    // vault/base signature.
    let sign_request = claim.mpc_request()?;
    engine
        .prime_sign_raw(
            DOMAIN_SECP256K1,
            "vault/base",
            sign_request["payload_v2"]["Ecdsa"].as_str().unwrap(),
            &claim.mpc_value()?,
        )
        .await?;
    let result = holder
        .call(engine.id(), "claim_base_tokens")
        .args_json(&claim.args)
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    gas.ok("claim_base_tokens", result)?;
    let payout: Value = engine
        .view("get_payout", json!({ "payout_id": "0" }))
        .await?;
    assert_eq!(payout["status"], "Signed", "{payout}");
    assert_eq!(payout["digest"], sign_request["payload_v2"]["Ecdsa"]);
    let response = claim.mpc_value()?;
    assert_eq!(
        payout["base"]["r"],
        response["big_r"]["affine_point"].as_str().unwrap()[2..]
    );
    assert_eq!(payout["base"]["s"], response["s"]["scalar"]);
    assert_eq!(
        payout["base"]["v"],
        27 + response["recovery_id"].as_u64().unwrap()
    );
    eprintln!(
        "claim_base_tokens: sandbox {:.2} Tgas, staging {:.2} Tgas",
        gas.tgas("claim_base_tokens").unwrap(),
        claim.tgas()
    );
    gas.print();
    Ok(())
}
