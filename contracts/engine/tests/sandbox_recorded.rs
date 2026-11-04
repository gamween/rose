//! Replays a recorded real CKD response in the sandbox: the engine deployed under the account
//! name of the IBE spike, keyed to the live MPC master key, must unwrap the recorded
//! `(big_y, big_c)` of `round/1` into the key the live callback stored
//! (`docs/verification.md`, "CKD and IBE"). Run with
//! `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_recorded -- --nocapture`.

mod sandbox_support;

use anyhow::Result;
use sandbox_support::*;
use serde_json::{json, Value};

const SPIKE_ENGINE: &str = "rose-ckd-1793753433.testnet";

#[tokio::test]
async fn recorded_ckd_response_unwraps_to_the_live_round_key() -> Result<()> {
    if !enabled("recorded_ckd_response_unwraps_to_the_live_round_key") {
        return Ok(());
    }
    let gas = GasTable::new("recorded ckd");
    let recorded = Recorded::load()?;
    let live_mpk = recorded.mpc_public_keys["2"].key.clone();
    let mpk = rose_ibe::parse_near_g2(&live_mpk)?;
    let engine = Engine::deploy(EngineSpec {
        account: Some(SPIKE_ENGINE),
        ckd_public_key: live_mpk,
        mpk,
        ..EngineSpec::test(&TestKey::new())
    })
    .await?;
    assert_eq!(engine.id().as_str(), SPIKE_ENGINE);
    engine.bootstrap(&gas).await?;
    let holder = engine.account().await?;
    engine.register(&holder, &gas).await?;
    let now = engine.now_ns().await? / NS;
    let stream = BaseStream::midstream(
        8,
        holder.id().as_str(),
        now,
        1_000,
        10_000,
        10_000 * USDC,
        5,
    );
    let class = engine.base_deposit(&holder, &stream, &gas).await?;
    engine.fund(&holder, 10 * USDC, &gas).await?;

    // Round 0 takes the first id; round 1 is the one the spike recorded.
    let round0 = engine.create_exit(&holder, &class, USDC, 60, &gas).await?;
    assert_eq!(round0, 0);
    let round = engine.create_exit(&holder, &class, USDC, 5, &gas).await?;
    assert_eq!(round, 1);
    let (ask, sealed) = engine
        .place_ask(&holder, round, 100 * USDC, USDC, 100 * USDC, &gas)
        .await?;
    let expected = recorded
        .ckd(SPIKE_ENGINE, "round/1")
        .expect("recorded round 1");
    let result = engine.close(&holder, &TestKey::new(), round, &gas).await?;
    assert!(result.logged("key_received"), "{:?}", result.logs);
    let view = engine.round(round).await?;
    assert_eq!(view["key"], expected.key, "the live round key");
    assert_eq!(view["key_source"], "Callback");
    let app_id = hex::encode(rose_ibe::round_app_id(SPIKE_ENGINE, 1));
    assert_eq!(view["app_id"], app_id);
    assert_eq!(
        app_id, "305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5",
        "round 1 app_id of the spike"
    );

    // The key opens an order sealed under the live master key.
    engine.open(&holder, round, ask, &sealed, &gas).await?;
    let bid: Value = engine
        .view(
            "get_bid",
            json!({ "round_id": round.to_string(), "bid_id": ask }),
        )
        .await?;
    assert_eq!(bid["status"], "Opened");
    gas.print();
    Ok(())
}
