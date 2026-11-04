//! Sandbox integration tests of the engine (spec section 10): real transactions on a local
//! NEAR sandbox against a mock MPC that signs with deterministic test keys (every signature the
//! engine stores is checked against the keys it bootstrapped), with the gas of every user-facing
//! method measured. Run with
//! `ROSE_SANDBOX=1 cargo test -p rose-engine --test sandbox_lifecycle -- --nocapture --test-threads=1`.

mod sandbox_support;

use anyhow::{bail, Result};
use ed25519_dalek::{Signature, VerifyingKey};
use futures::future::try_join_all;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use rose_engine::foreign::solana as sol;
use sandbox_support::*;
use serde_json::{json, Value};

/// Deposits a mid-stream position of `deposited` units unlocking over `duration` seconds
/// (started `elapsed` seconds ago) for `holder` and returns its class id.
async fn deposit_for(
    engine: &Engine,
    holder: &Account,
    stream_id: u64,
    elapsed: u64,
    duration: u64,
    deposited: u128,
    gas: &GasTable,
) -> Result<String> {
    let now = engine.now_ns().await? / NS;
    let stream = BaseStream::midstream(
        stream_id,
        holder.id().as_str(),
        now,
        elapsed,
        duration,
        deposited,
        5,
    );
    let class_id = engine.base_deposit(holder, &stream, gas).await?;
    if engine.balance(holder.id(), &class_id).await? != deposited {
        bail!("the full allocation is minted");
    }
    Ok(class_id)
}

#[tokio::test]
async fn tender_exit_and_advance_lifecycles() -> Result<()> {
    if !enabled("tender_exit_and_advance_lifecycles") {
        return Ok(());
    }
    let gas = GasTable::new("lifecycles");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let (holder, issuer, buyer, funder, anyone) = (
        engine.account().await?,
        engine.account().await?,
        engine.account().await?,
        engine.account().await?,
        engine.account().await?,
    );
    engine.register(&holder, &gas).await?;
    // 10,000 tokens (6 decimals), 10% unlocked, 90% over the next 9,000 s.
    let class = deposit_for(&engine, &holder, 1, 1_000, 10_000, 10_000 * USDC, &gas).await?;
    engine.fund(&holder, 10 * USDC, &gas).await?;
    engine.fund(&issuer, 2_000 * USDC, &gas).await?;
    engine.fund(&buyer, 2_000 * USDC, &gas).await?;
    engine.fund(&funder, 2_000 * USDC, &gas).await?;

    // Tender: budget 1,000 USDC, max 10 USDC per locked token; one ask of 100 tokens at 9.
    let result = issuer
        .call(engine.id(), "create_tender")
        .args_json(json!({ "params": {
            "class_id": class,
            "venue": "Near",
            "budget": (1_000 * USDC).to_string(),
            "max_price": (10 * USDC).to_string(),
            "reference_price": (12 * USDC).to_string(),
            "retire_to": RECIPIENT,
            "window": engine.window(8).await?,
        }}))
        .deposit(ROUND_STORAGE_DEPOSIT)
        .transact()
        .await?;
    let tender = round_id_of(gas.ok_in("tender", "create_tender", result)?)?;
    let issuer_cash = engine.cash(&issuer).await?;
    assert_eq!(
        issuer_cash,
        2_000 * USDC - 1_003 * USDC,
        "budget + 30 bps escrowed"
    );
    let (ask, ask_sealed) = engine
        .place_ask(&holder, tender, 100 * USDC, 9 * USDC, 100 * USDC, &gas)
        .await?;
    let close = engine.close(&anyone, &key, tender, &gas).await?;
    assert!(close.logged("key_received"), "{:?}", close.logs);
    engine.open(&anyone, tender, ask, &ask_sealed, &gas).await?;
    let round = engine.clear(&anyone, tender, &gas).await?;
    assert_eq!(round["status"], "Settled");
    let result = &round["result"];
    assert_eq!(u128_of(&result["price"])?, 9 * USDC);
    assert_eq!(u128_of(&result["volume"])?, 100 * USDC);
    let fill = &result["fills"][ask as usize];
    let proceeds = u128_of(&fill["cash"])?;
    assert!(
        proceeds > 0 && proceeds <= 900 * USDC,
        "charge for 100 locked tokens at 9"
    );
    engine.settle(&anyone, tender, ask, &gas).await?;
    assert_eq!(
        engine.cash(&holder).await?,
        10 * USDC + proceeds,
        "bond back plus proceeds"
    );
    let retired: Value = engine
        .view("get_retired_lot", json!({ "round_id": tender.to_string() }))
        .await?;
    assert_eq!(u128_of(&retired["units"])?, 100 * USDC);
    assert_eq!(retired["retire_to"], RECIPIENT);
    assert!(
        engine.cash(&issuer).await? > issuer_cash,
        "unspent budget refunded"
    );

    // Exit: 1,000 tokens asked at 1 USDC, bid at 1.2 USDC: the midpoint clears.
    let exit = engine
        .create_exit(&anyone, &class, 2 * USDC, 8, &gas)
        .await?;
    engine.register(&buyer, &gas).await?;
    let (ask, ask_sealed) = engine
        .place_ask(&holder, exit, 1_000 * USDC, USDC, 1_000 * USDC, &gas)
        .await?;
    let (bid, bid_sealed, escrow) = engine
        .place_bid(&buyer, exit, 1_000 * USDC, 12 * USDC / 10, &gas)
        .await?;
    assert_eq!(
        engine.cash(&buyer).await?,
        2_000 * USDC - escrow - (escrow / 100).max(USDC),
        "escrow plus bond"
    );
    engine.close(&anyone, &key, exit, &gas).await?;
    engine.open(&anyone, exit, ask, &ask_sealed, &gas).await?;
    engine.open(&anyone, exit, bid, &bid_sealed, &gas).await?;
    let round = engine.clear(&anyone, exit, &gas).await?;
    assert_eq!(round["status"], "Settled");
    assert_eq!(u128_of(&round["result"]["price"])?, 11 * USDC / 10);
    assert_eq!(u128_of(&round["result"]["volume"])?, 1_000 * USDC);
    engine.settle(&anyone, exit, ask, &gas).await?;
    engine.settle(&anyone, exit, bid, &gas).await?;
    assert_eq!(engine.balance(buyer.id(), &class).await?, 1_000 * USDC);
    assert_eq!(
        engine.balance(holder.id(), &class).await?,
        10_000 * USDC - 100 * USDC - 1_000 * USDC
    );

    // Advance on a class unlocking 1,000 tokens over 1,000 s: 4,000 units back a 500-token
    // claim; one funder bids 1.5 USDC per claimed token against a 0.9 reserve.
    let fast = deposit_for(&engine, &holder, 2, 100, 1_000, 10_000 * USDC, &gas).await?;
    let result = holder
        .call(engine.id(), "create_advance")
        .args_json(json!({ "params": {
            "class_id": fast,
            "venue": "Near",
            "units": (4_000 * USDC).to_string(),
            "claim": (500 * USDC).to_string(),
            "min_fill": (100 * USDC).to_string(),
            "max_price": (2 * USDC).to_string(),
            "window": engine.window(8).await?,
        }}))
        .deposit(ROUND_STORAGE_DEPOSIT)
        .transact()
        .await?;
    let advance = round_id_of(gas.ok_in("advance", "create_advance", result)?)?;
    let (ask, ask_sealed) = engine
        .place_ask(
            &holder,
            advance,
            500 * USDC,
            9 * USDC / 10,
            500 * USDC,
            &gas,
        )
        .await?;
    let (bid, bid_sealed, _) = engine
        .place_bid(&funder, advance, 500 * USDC, 15 * USDC / 10, &gas)
        .await?;
    engine.close(&anyone, &key, advance, &gas).await?;
    engine
        .open(&anyone, advance, ask, &ask_sealed, &gas)
        .await?;
    engine
        .open(&anyone, advance, bid, &bid_sealed, &gas)
        .await?;
    let round = engine.clear(&anyone, advance, &gas).await?;
    assert_eq!(round["status"], "Settled");
    assert_eq!(u128_of(&round["result"]["price"])?, 12 * USDC / 10);
    let lien_id = u64_of(&round["lien_id"])?;
    engine.settle(&anyone, advance, ask, &gas).await?;
    engine.settle(&anyone, advance, bid, &gas).await?;
    let (_, shares): (Vec<Value>, Vec<Value>) = engine
        .view("get_liens", json!({ "account": funder.id() }))
        .await?;
    assert_eq!(u128_of(&shares[0]["claim"])?, 500 * USDC);
    let holding: Value = engine
        .view(
            "get_holding",
            json!({ "account": holder.id(), "class_id": fast }),
        )
        .await?;
    assert_eq!(u128_of(&holding["encumbered"])?, 4_000 * USDC);
    // 4,000 units deliver 500 tokens once the class unlocks 12.5% more: about 130 s.
    let now = engine.now_ns().await?;
    engine.advance_past(now + 140 * NS).await?;
    let lien: Value = engine
        .view("get_lien", json!({ "lien_id": lien_id.to_string() }))
        .await?;
    assert_eq!(u128_of(&lien["delivered"])?, 500 * USDC, "{lien}");
    let result = anyone
        .call(engine.id(), "release_lien")
        .args_json(json!({ "lien_id": lien_id.to_string() }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    gas.ok_in("advance", "release_lien", result)?;
    let holding: Value = engine
        .view(
            "get_holding",
            json!({ "account": holder.id(), "class_id": fast }),
        )
        .await?;
    assert_eq!(u128_of(&holding["encumbered"])?, 0);
    assert_eq!(u128_of(&holding["balance"])?, 10_000 * USDC);

    // Cash leaves the engine through the NEP-141 pull.
    let proceeds = engine.cash(&holder).await?;
    let result = holder
        .call(engine.id(), "withdraw_near_cash")
        .args_json(json!({ "amount": proceeds.to_string() }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    gas.ok("withdraw_near_cash", result)?;
    assert_eq!(engine.cash(&holder).await?, 0);
    let balance: Value = engine
        .tusdc
        .view("ft_balance_of")
        .args_json(json!({ "account_id": holder.id() }))
        .await?
        .json()?;
    assert_eq!(u128_of(&balance)?, proceeds);

    let stats: Value = engine.view("stats", json!({})).await?;
    assert_eq!(stats["rounds_settled"], 3);
    let events: Value = engine
        .view("get_events", json!({ "from_seq": null, "limit": 200 }))
        .await?;
    let kinds: Vec<&str> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["event"].as_str())
        .collect();
    for kind in [
        "bootstrapped",
        "deposit_registered",
        "round_created",
        "key_received",
        "bid_opened",
        "round_cleared",
        "bid_settled",
        "lien_released",
    ] {
        assert!(kinds.contains(&kind), "{kind} in the on-chain history");
    }
    gas.print();
    let close_tgas = gas.tgas("close").unwrap();
    assert!(close_tgas < 60.0, "close burnt {close_tgas:.2} Tgas");
    let open_tgas = gas.tgas("open_bid").unwrap();
    assert!(
        (100.0..140.0).contains(&open_tgas),
        "open_bid burnt {open_tgas:.2} Tgas"
    );
    Ok(())
}

#[tokio::test]
async fn clear_at_the_bid_cap() -> Result<()> {
    if !enabled("clear_at_the_bid_cap") {
        return Ok(());
    }
    let gas = GasTable::new("64 bids");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let holder = engine.account().await?;
    engine.register(&holder, &gas).await?;
    let class = deposit_for(&engine, &holder, 3, 1_000, 100_000, 100_000 * USDC, &gas).await?;
    // The seller's bond is 1% of 63,000 tokens valued at the max price.
    engine.fund(&holder, 2_000 * USDC, &gas).await?;
    // Every buyer is registered and funded before the round opens, so only the orders themselves
    // run inside its window.
    let buyers: Vec<Account> = try_join_all((0..63).map(|_| engine.account())).await?;
    try_join_all(buyers.iter().map(|buyer| {
        let (engine, gas) = (&engine, &gas);
        async move {
            engine.register(buyer, gas).await?;
            engine.fund(buyer, 2_000 * USDC, gas).await
        }
    }))
    .await?;
    let late = engine.account().await?;
    engine.register(&late, &gas).await?;
    engine.fund(&late, 1_300 * USDC, &gas).await?;
    let round = engine
        .create_exit(&holder, &class, 2 * USDC, 600, &gas)
        .await?;
    let (ask, ask_sealed) = engine
        .place_ask(&holder, round, 63_000 * USDC, USDC, 63_000 * USDC, &gas)
        .await?;
    let placed = try_join_all(buyers.iter().enumerate().map(|(i, buyer)| {
        engine.place_bid(
            buyer,
            round,
            1_000 * USDC,
            USDC + (i as u128 + 1) * USDC / 100,
            &gas,
        )
    }))
    .await?;
    let result = engine.place_bid(&late, round, USDC, USDC, &gas).await;
    assert!(
        result.is_err_and(|e| e.to_string().contains("Round is full")),
        "the 65th order is refused"
    );
    engine.close(&holder, &key, round, &gas).await?;
    engine.open(&holder, round, ask, &ask_sealed, &gas).await?;
    try_join_all(
        buyers
            .iter()
            .zip(placed.iter())
            .map(|(buyer, (bid, sealed, _))| engine.open(buyer, round, *bid, sealed, &gas)),
    )
    .await?;
    let round_view = engine.clear(&holder, round, &gas).await?;
    assert_eq!(round_view["status"], "Settled");
    assert_eq!(round_view["opened_count"], 64);
    assert_eq!(u128_of(&round_view["result"]["volume"])?, 63_000 * USDC);
    try_join_all(
        buyers
            .iter()
            .zip(placed.iter())
            .map(|(buyer, (bid, _, _))| engine.settle(buyer, round, *bid, &gas)),
    )
    .await?;
    engine.settle(&holder, round, ask, &gas).await?;
    assert_eq!(engine.balance(buyers[0].id(), &class).await?, 1_000 * USDC);
    gas.print();
    eprintln!("clear at 64 bids: {:.2} Tgas", gas.tgas("clear").unwrap());
    Ok(())
}

#[tokio::test]
async fn base_payout_authorization_and_redeem() -> Result<()> {
    if !enabled("base_payout_authorization_and_redeem") {
        return Ok(());
    }
    let gas = GasTable::new("base payout");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let holder = engine.account().await?;
    engine.register(&holder, &gas).await?;
    let now = engine.now_ns().await? / NS;
    let first = BaseStream::midstream(
        4,
        holder.id().as_str(),
        now,
        1_000,
        10_000,
        10_000 * USDC,
        5,
    );
    let class = engine.base_deposit(&holder, &first, &gas).await?;
    engine.advance_past((now + 10) * NS).await?;
    let claimable = engine.claimable(holder.id(), &class).await?;
    assert!(claimable > 0, "accrual since the deposit checkpoint");

    let result = holder
        .call(engine.id(), "claim_base_tokens")
        .args_json(json!({
            "source": { "Holding": { "class_id": class } },
            "amount": claimable.to_string(),
            "to": RECIPIENT,
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    gas.ok("claim_base_tokens", result)?;
    let payout: Value = engine
        .view("get_payout", json!({ "payout_id": "0" }))
        .await?;
    assert_eq!(payout["status"], "Signed", "{payout}");
    let config: Value = engine.view("get_config", json!({})).await?;
    assert_eq!(
        recover_signer(&payout)?,
        config["derived_addresses"]["vault_base"].as_str().unwrap(),
        "the stored (r, s, v) recovers to the bootstrapped vault address: {payout}"
    );
    assert_eq!(payout["kind"]["BaseTransfer"]["to"], RECIPIENT);
    let left = engine.claimable(holder.id(), &class).await?;
    assert!(
        left < 5 * USDC,
        "the claim debited the claimable balance (a few seconds accrued since): {left}"
    );

    // A second position of the same class is redeemed in kind: its allocation is burnt and a
    // Release is authorized.
    let template = BaseStream::midstream(
        4,
        holder.id().as_str(),
        engine.now_ns().await? / NS,
        1_000,
        10_000,
        10_000 * USDC,
        5,
    );
    let second = engine
        .base_deposit(
            &holder,
            &BaseStream {
                stream_id: 5,
                tx_hash: format!("{:0>64}", "55"),
                deposited: 1_000 * USDC,
                withdrawn: 0,
                start: first.start,
                end: first.end,
                ..template
            },
            &gas,
        )
        .await?;
    assert_eq!(
        second, class,
        "same token and normalized schedule, same class"
    );
    let before = engine.balance(holder.id(), &class).await?;
    let result = holder
        .call(engine.id(), "redeem")
        .args_json(json!({
            "position_id": "1",
            "to": RECIPIENT,
            "nonce": null,
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    gas.ok("redeem", result)?;
    assert_eq!(
        engine.balance(holder.id(), &class).await?,
        before - 1_000 * USDC
    );
    let position: Value = engine
        .view("get_position", json!({ "position_id": "1" }))
        .await?;
    assert_eq!(position["state"], "Released");
    let payout: Value = engine
        .view("get_payout", json!({ "payout_id": "1" }))
        .await?;
    assert_eq!(payout["status"], "Signed");
    assert_eq!(payout["kind"]["BaseRelease"]["stream_id"], 5);
    assert_eq!(
        recover_signer(&payout)?,
        config["derived_addresses"]["vault_base"].as_str().unwrap()
    );
    gas.print();
    Ok(())
}

/// The EVM address that signed a Base payout's stored digest with its stored `(r, s, v)`.
fn recover_signer(payout: &Value) -> Result<String> {
    let digest = hex::decode(payout["digest"].as_str().unwrap())?;
    let r = hex::decode(payout["base"]["r"].as_str().unwrap())?;
    let s = hex::decode(payout["base"]["s"].as_str().unwrap())?;
    let v = payout["base"]["v"].as_u64().unwrap() as u8;
    let signature = k256::ecdsa::Signature::from_slice(&[r, s].concat())?;
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(
        &digest,
        &signature,
        k256::ecdsa::RecoveryId::from_byte(v - 27).unwrap(),
    )?;
    let point = key.to_encoded_point(false);
    let public: [u8; 64] = point.as_bytes()[1..].try_into()?;
    Ok(rose_engine::foreign::evm::format_address(
        &rose_engine::foreign::evm::address_from_public_key(&public),
    ))
}

/// Verifies an Ed25519 signature (base64 from a payout record) over `message` by `key`
/// (`ed25519:<base58>` or base58).
fn verify_ed25519(key: &str, message: &[u8], signature: &Value) -> Result<()> {
    let key = sol::parse_pubkey(key.strip_prefix("ed25519:").unwrap_or(key))
        .map_err(|e| anyhow::anyhow!("key: {e:?}"))?;
    let bytes: [u8; 64] = base64_decode(signature.as_str().unwrap())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("signature length"))?;
    VerifyingKey::from_bytes(&key)?.verify_strict(message, &Signature::from_bytes(&bytes))?;
    Ok(())
}

fn base64_decode(text: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.decode(text)?)
}

#[tokio::test]
async fn solana_two_phase_payout_and_redeem() -> Result<()> {
    if !enabled("solana_two_phase_payout_and_redeem") {
        return Ok(());
    }
    let gas = GasTable::new("solana");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let holder = engine.account().await?;
    engine.register(&holder, &gas).await?;
    let config: Value = engine.view("get_config", json!({})).await?;
    let vault_text = config["derived_addresses"]["vault_sol"]
        .as_str()
        .unwrap()
        .to_string();
    let gas_text = config["derived_addresses"]["gas_sol"]
        .as_str()
        .unwrap()
        .to_string();
    let vault = sol::parse_pubkey(&vault_text).expect("bootstrapped vault key");
    let streamflow = sol::parse_pubkey(STREAMFLOW_PROGRAM).expect("program id");
    let mint = [9u8; 32];
    let stream = [3u8; 32];
    let return_to = [4u8; 32];
    let now = engine.now_ns().await? / NS;
    let spec = |recipient: [u8; 32], withdrawn: u64| StreamflowSpec {
        recipient,
        mint,
        start_time: now - 1_500,
        period: 1_000,
        amount_per_period: 100 * USDC as u64,
        net_amount_deposited: 1_000 * USDC as u64,
        end_time: now - 1_500 + 10_000,
        amount_withdrawn: withdrawn,
    };
    let class: String = engine
        .contract
        .view("compute_sol_class_id")
        .args_json(json!({
            "mint": sol::format_pubkey(&mint),
            "decimals": 6,
            "schedule": {
                "start_time": now - 1_500,
                "cliff": 0,
                "cliff_amount": 0,
                "period": 1_000,
                "amount_per_period": 100 * USDC as u64,
                "net_amount_deposited": 1_000 * USDC as u64,
                "end_time": now - 1_500 + 10_000,
            },
        }))
        .await?
        .json()?;
    let path: String = engine
        .view(
            "deposit_path_of",
            json!({ "account": holder.id(), "class_id": class }),
        )
        .await?;
    let deposit_text = engine.derived_key(&path, DOMAIN_ED25519).await?;
    let deposit_key = sol::parse_near_ed25519(&deposit_text).expect("mock-derived key");

    // Attribution: the stream sits at the deposit address the mock derives for the holder.
    let anchor = bs58::encode([21u8; 64]).into_string();
    let at_deposit = spec(deposit_key, 0);
    engine
        .prime_accounts(
            &anchor,
            &[
                (stream, streamflow, at_deposit.bytes()),
                (mint, sol::TOKEN_PROGRAM, mint_bytes(6)),
            ],
        )
        .await?;
    let result = holder
        .call(engine.id(), "attribute_sol_deposit")
        .args_json(json!({ "args": {
            "metadata": sol::format_pubkey(&stream),
            "class_id": class,
            "return_to": sol::format_pubkey(&return_to),
            "anchor_tx": anchor,
            "metadata_data": hex::encode(at_deposit.bytes()),
            "mint_data": hex::encode(mint_bytes(6)),
        }}))
        .deposit(RECORD_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(120))
        .transact()
        .await?;
    gas.ok("attribute_sol_deposit", result)?;
    let record: Value = engine
        .view(
            "get_sol_deposit",
            json!({ "metadata": sol::format_pubkey(&stream) }),
        )
        .await?;
    assert_eq!(record["stage"], "Attributed", "{record}");

    // Move: the deposit key and gas/sol sign the engine-built message.
    let result = holder
        .call(engine.id(), "move_sol_deposit")
        .args_json(json!({
            "metadata": sol::format_pubkey(&stream),
            "recent_blockhash": sol::format_pubkey(&[1u8; 32]),
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    gas.ok("move_sol_deposit", result)?;
    let payout: Value = engine
        .view("get_payout", json!({ "payout_id": "0" }))
        .await?;
    assert_eq!(payout["status"], "Signed", "{payout}");
    let message = base64_decode(payout["solana"]["message"].as_str().unwrap())?;
    verify_ed25519(
        &deposit_text,
        &message,
        &payout["solana"]["authority_signature"],
    )?;
    verify_ed25519(&gas_text, &message, &payout["solana"]["gas_signature"])?;

    // Registration: the stream now belongs to the vault.
    let at_vault = spec(vault, 0);
    engine
        .prime_accounts(&anchor, &[(stream, streamflow, at_vault.bytes())])
        .await?;
    let deposit: Value = engine
        .view(
            "registration_deposit_for",
            json!({ "account": holder.id(), "class_id": class }),
        )
        .await?;
    let result = holder
        .call(engine.id(), "register_sol_deposit")
        .args_json(json!({
            "metadata": sol::format_pubkey(&stream),
            "anchor_tx": anchor,
            "metadata_data": hex::encode(at_vault.bytes()),
        }))
        .deposit(NearToken::from_yoctonear(u128_of(&deposit)?))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    let result = gas.ok("register_sol_deposit", result)?;
    assert!(result.logged("deposit_registered"), "{:?}", result.logs);
    assert_eq!(engine.balance(holder.id(), &class).await?, 1_000 * USDC);
    let claimable = engine.claimable(holder.id(), &class).await?;
    assert_eq!(claimable, 100 * USDC, "one period of 100 tokens unlocked");

    // Claim: the holder names the stream, proves its nonce account and its token account.
    let nonce_account = [12u8; 32];
    let signed_nonce = [13u8; 32];
    let advanced_nonce = [14u8; 32];
    let recipient_tokens = sol::associated_token_address(&return_to, &mint).unwrap();
    let nonce_anchor = bs58::encode([23u8; 64]).into_string();
    let proof = |value: [u8; 32]| {
        json!({
            "account": sol::format_pubkey(&nonce_account),
            "anchor_tx": nonce_anchor,
            "data": hex::encode(nonce_bytes(vault, value)),
            "recipient_tokens_data": hex::encode(token_account_bytes(mint, return_to)),
        })
    };
    let payout_accounts = |value: [u8; 32]| {
        vec![
            (
                nonce_account,
                sol::SYSTEM_PROGRAM,
                nonce_bytes(vault, value),
            ),
            (
                recipient_tokens,
                sol::TOKEN_PROGRAM,
                token_account_bytes(mint, return_to),
            ),
        ]
    };
    engine
        .prime_accounts(&nonce_anchor, &payout_accounts(signed_nonce))
        .await?;
    let result = holder
        .call(engine.id(), "claim_sol_tokens")
        .args_json(json!({
            "source": { "Holding": { "class_id": class } },
            "draws": [{ "position_id": "0", "amount": claimable.to_string() }],
            "to_owner": sol::format_pubkey(&return_to),
            "nonce": proof(signed_nonce),
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    gas.ok("claim_sol_tokens", result)?;
    let payout: Value = engine
        .view("get_payout", json!({ "payout_id": "1" }))
        .await?;
    assert_eq!(payout["status"], "Signed", "{payout}");
    let message = base64_decode(payout["solana"]["message"].as_str().unwrap())?;
    verify_ed25519(
        &vault_text,
        &message,
        &payout["solana"]["authority_signature"],
    )?;
    verify_ed25519(&gas_text, &message, &payout["solana"]["gas_signature"])?;
    let transaction = base64_decode(payout["solana"]["transaction"].as_str().unwrap())?;
    assert_eq!(transaction[0], 2);
    assert_eq!(&transaction[129..], &message[..]);
    assert_eq!(
        payout["solana"]["draws"][0]["expected_withdrawn"],
        claimable.to_string()
    );
    assert_eq!(engine.claimable(holder.id(), &class).await?, 0);
    let info: Value = engine
        .view("get_sol_stream", json!({ "position_id": "0" }))
        .await?;
    assert_eq!(info["engine_withdrawn"], 0, "nothing counts before landing");
    assert_eq!(info["drawing"], "1");

    // A redeem waits for the payout's confirmation.
    let result = holder
        .call(engine.id(), "redeem")
        .args_json(json!({
            "position_id": "0",
            "to": sol::format_pubkey(&return_to),
            "nonce": proof(advanced_nonce),
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    gas.fails_with("redeem (payout unconfirmed)", result, "not confirmed yet")?;

    // Broadcast and executed: the nonce advanced and the stream paid the claim.
    let confirm_anchor = bs58::encode([24u8; 64]).into_string();
    let paid = spec(vault, claimable as u64);
    engine
        .prime_accounts(
            &confirm_anchor,
            &[
                (
                    nonce_account,
                    sol::SYSTEM_PROGRAM,
                    nonce_bytes(vault, advanced_nonce),
                ),
                (stream, streamflow, paid.bytes()),
            ],
        )
        .await?;
    let result = holder
        .call(engine.id(), "confirm_sol_payout")
        .args_json(json!({
            "payout_id": "1",
            "anchor_tx": confirm_anchor,
            "nonce_data": hex::encode(nonce_bytes(vault, advanced_nonce)),
            "stream_data": [hex::encode(paid.bytes())],
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let result = gas.ok("confirm_sol_payout", result)?;
    assert!(result.logged("payout_landed"), "{:?}", result.logs);
    let info: Value = engine
        .view("get_sol_stream", json!({ "position_id": "0" }))
        .await?;
    assert_eq!(info["engine_withdrawn"], claimable as u64);
    assert!(info["drawing"].is_null());

    // Redeem: the stream's unlocked tokens are all withdrawn, so the holder pays nothing more;
    // the release stays Releasing until its own confirmation.
    let redeem_nonce = [15u8; 32];
    engine
        .prime_accounts(&nonce_anchor, &payout_accounts(advanced_nonce))
        .await?;
    let result = holder
        .call(engine.id(), "redeem")
        .args_json(json!({
            "position_id": "0",
            "to": sol::format_pubkey(&return_to),
            "nonce": proof(advanced_nonce),
        }))
        .deposit(PAYOUT_STORAGE_DEPOSIT)
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    gas.ok("redeem (solana)", result)?;
    let release: Value = engine
        .view("get_payout", json!({ "payout_id": "2" }))
        .await?;
    assert_eq!(release["status"], "Signed", "{release}");
    let message = base64_decode(release["solana"]["message"].as_str().unwrap())?;
    verify_ed25519(
        &vault_text,
        &message,
        &release["solana"]["authority_signature"],
    )?;
    let position: Value = engine
        .view("get_position", json!({ "position_id": "0" }))
        .await?;
    assert_eq!(position["state"], "Releasing", "{position}");
    assert_eq!(engine.balance(holder.id(), &class).await?, 0);

    let released = StreamflowSpec {
        amount_withdrawn: claimable as u64,
        ..spec(return_to, 0)
    };
    engine
        .prime_accounts(
            &confirm_anchor,
            &[
                (
                    nonce_account,
                    sol::SYSTEM_PROGRAM,
                    nonce_bytes(vault, redeem_nonce),
                ),
                (stream, streamflow, released.bytes()),
            ],
        )
        .await?;
    let result = holder
        .call(engine.id(), "confirm_sol_redeem")
        .args_json(json!({
            "position_id": "0",
            "anchor_tx": confirm_anchor,
            "nonce_data": hex::encode(nonce_bytes(vault, redeem_nonce)),
            "stream_data": hex::encode(released.bytes()),
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let result = gas.ok("confirm_sol_redeem", result)?;
    assert!(result.logged("position_released"), "{:?}", result.logs);
    let position: Value = engine
        .view("get_position", json!({ "position_id": "0" }))
        .await?;
    assert_eq!(position["state"], "Released", "{position}");
    let release: Value = engine
        .view("get_payout", json!({ "payout_id": "2" }))
        .await?;
    assert_eq!(release["status"], "Landed");
    gas.print();
    Ok(())
}

#[tokio::test]
async fn key_timeout_cancel_waits_for_the_key_request() -> Result<()> {
    if !enabled("key_timeout_cancel_waits_for_the_key_request") {
        return Ok(());
    }
    let gas = GasTable::new("no key");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let holder = engine.account().await?;
    engine.register(&holder, &gas).await?;
    let class = deposit_for(&engine, &holder, 6, 1_000, 10_000, 10_000 * USDC, &gas).await?;
    engine.fund(&holder, 10 * USDC, &gas).await?;

    // A failed CKD request leaves the round KeyRequested; after the key timeout, and once the
    // request can no longer be answered (250 blocks after `close`), anyone cancels it and the
    // ask settles as a refund.
    let round = engine.create_exit(&holder, &class, USDC, 5, &gas).await?;
    let (ask, _) = engine
        .place_ask(&holder, round, 100 * USDC, USDC, 100 * USDC, &gas)
        .await?;
    let view = engine.round(round).await?;
    engine.advance_past(u64_of(&view["closes_at"])?).await?;
    engine
        .mock
        .call("set_fail_next")
        .transact()
        .await?
        .into_result()?;
    let result = holder
        .call(engine.id(), "close")
        .args_json(json!({ "round_id": round.to_string() }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let result = gas.ok("close (MPC failure)", result)?;
    assert!(result.logged("key_request_failed"), "{:?}", result.logs);
    assert_eq!(engine.round(round).await?["status"], "KeyRequested");
    let result = holder
        .call(engine.id(), "cancel_no_key")
        .args_json(json!({ "round_id": round.to_string() }))
        .transact()
        .await?;
    gas.fails_with("cancel_no_key (too early)", result, "timeout")?;
    engine
        .advance_past(u64_of(&view["closes_at"])? + 40 * NS)
        .await?;
    let result = holder
        .call(engine.id(), "cancel_no_key")
        .args_json(json!({ "round_id": round.to_string() }))
        .transact()
        .await?;
    gas.fails_with("cancel_no_key (request in flight)", result, "in flight")?;
    let result = holder
        .call(engine.id(), "close")
        .args_json(json!({ "round_id": round.to_string() }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    gas.fails_with(
        "close (after the key timeout)",
        result,
        "Key timeout reached",
    )?;
    engine.worker.fast_forward(260).await?;
    let result = holder
        .call(engine.id(), "cancel_no_key")
        .args_json(json!({ "round_id": round.to_string() }))
        .transact()
        .await?;
    gas.ok("cancel_no_key", result)?;
    assert_eq!(engine.round(round).await?["status"], "Cancelled");
    engine.settle(&holder, round, ask, &gas).await?;
    assert_eq!(engine.balance(holder.id(), &class).await?, 10_000 * USDC);
    assert_eq!(engine.cash(&holder).await?, 10 * USDC, "bond refunded");

    // A round nobody closed before its key timeout cannot request a key any more: it is
    // cancelled at once (no request was ever in flight).
    let late = engine.create_exit(&holder, &class, USDC, 3, &gas).await?;
    let (ask, _) = engine
        .place_ask(&holder, late, 100 * USDC, USDC, 100 * USDC, &gas)
        .await?;
    let view = engine.round(late).await?;
    engine
        .advance_past(u64_of(&view["closes_at"])? + 40 * NS)
        .await?;
    let result = holder
        .call(engine.id(), "close")
        .args_json(json!({ "round_id": late.to_string() }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    gas.fails_with(
        "close (after the key timeout)",
        result,
        "Key timeout reached",
    )?;
    let result = holder
        .call(engine.id(), "cancel_no_key")
        .args_json(json!({ "round_id": late.to_string() }))
        .transact()
        .await?;
    gas.ok("cancel_no_key", result)?;
    let view = engine.round(late).await?;
    assert_eq!(view["status"], "Cancelled");
    assert!(view["key"].is_null());
    engine.settle(&holder, late, ask, &gas).await?;
    assert_eq!(engine.balance(holder.id(), &class).await?, 10_000 * USDC);
    gas.print();
    Ok(())
}

#[tokio::test]
async fn storage_registration_and_transfer_call_refund() -> Result<()> {
    if !enabled("storage_registration_and_transfer_call_refund") {
        return Ok(());
    }
    let gas = GasTable::new("nep-145");
    let key = TestKey::new();
    let engine = Engine::deploy(EngineSpec::test(&key)).await?;
    engine.bootstrap(&gas).await?;
    let (holder, alice, bob) = (
        engine.account().await?,
        engine.account().await?,
        engine.account().await?,
    );
    engine.register(&holder, &gas).await?;
    let class = deposit_for(&engine, &holder, 7, 1_000, 10_000, 10_000 * USDC, &gas).await?;

    let bounds: Value = engine.view("storage_balance_bounds", json!({})).await?;
    let min = u128_of(&bounds["min"])?;
    assert!(bounds["max"].is_null());
    let result = holder
        .call(engine.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": alice.id(),
            "token_id": class,
            "amount": (100 * USDC).to_string(),
            "approval": null,
            "memo": null,
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    gas.fails_with(
        "mt_transfer (unregistered receiver)",
        result,
        "not registered",
    )?;

    // Registration with an excess that stays as deposit, then a withdrawal of the excess.
    let result = alice
        .call(engine.id(), "storage_deposit")
        .args_json(json!({ "account_id": null, "registration_only": null }))
        .deposit(NearToken::from_yoctonear(min * 3))
        .transact()
        .await?;
    let balance: Value = gas.ok("storage_deposit", result)?.json()?;
    assert_eq!(u128_of(&balance["total"])?, min * 3);
    let result = alice
        .call(engine.id(), "storage_withdraw")
        .args_json(json!({ "amount": null }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    let balance: Value = gas.ok("storage_withdraw", result)?.json()?;
    assert_eq!(
        u128_of(&balance["total"])?,
        min,
        "withdrawing everything leaves the registration minimum: {balance}"
    );
    assert_eq!(u128_of(&balance["available"])?, 0);
    let result = holder
        .call(engine.id(), "mt_transfer")
        .args_json(json!({
            "receiver_id": alice.id(),
            "token_id": class,
            "amount": (100 * USDC).to_string(),
            "approval": null,
            "memo": null,
        }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    gas.ok("mt_transfer", result)?;
    assert_eq!(engine.balance(alice.id(), &class).await?, 100 * USDC);
    let result = alice
        .call(engine.id(), "storage_unregister")
        .args_json(json!({ "force": null }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    gas.fails_with("storage_unregister (holding)", result, "still holds")?;

    // The issuer path: distribute_units registers unregistered receivers from the attached NEAR.
    let result = holder
        .call(engine.id(), "distribute_units")
        .args_json(json!({
            "token_id": class,
            "receivers": [[bob.id(), (50 * USDC).to_string()], [alice.id(), (50 * USDC).to_string()]],
        }))
        .deposit(NearToken::from_yoctonear(min * 2))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    gas.ok("distribute_units", result)?;
    assert_eq!(engine.balance(bob.id(), &class).await?, 50 * USDC);
    assert_eq!(engine.balance(alice.id(), &class).await?, 150 * USDC);
    let bob_storage: Value = engine
        .view("storage_balance_of", json!({ "account_id": bob.id() }))
        .await?;
    assert_eq!(u128_of(&bob_storage["total"])?, min);

    // mt_transfer_call to a receiver contract (the mock) that keeps 300 and refunds 200.
    let receiver = engine.mock.as_account();
    let result = holder
        .call(engine.id(), "storage_deposit")
        .args_json(json!({ "account_id": receiver.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(min))
        .transact()
        .await?;
    gas.ok("storage_deposit (for another account)", result)?;
    let before = engine.balance(holder.id(), &class).await?;
    let result = holder
        .call(engine.id(), "mt_transfer_call")
        .args_json(json!({
            "receiver_id": receiver.id(),
            "token_id": class,
            "amount": (500 * USDC).to_string(),
            "approval": null,
            "memo": null,
            "msg": format!("refund:{}", 200 * USDC),
        }))
        .deposit(ONE_YOCTO)
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let done = gas.ok("mt_transfer_call", result)?;
    let used: Vec<Value> = done.json()?;
    assert_eq!(
        u128_of(&used[0])?,
        300 * USDC,
        "used amount returned: {:?} {:?}",
        done.logs,
        done.receipt_failures()
    );
    assert_eq!(engine.balance(receiver.id(), &class).await?, 300 * USDC);
    assert_eq!(
        engine.balance(holder.id(), &class).await?,
        before - 300 * USDC
    );

    // An account with no holding unregisters and gets its deposit back.
    let carol = engine.account().await?;
    engine.register(&carol, &gas).await?;
    let result = carol
        .call(engine.id(), "storage_unregister")
        .args_json(json!({ "force": null }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    let unregistered: bool = gas.ok("storage_unregister", result)?.json()?;
    assert!(unregistered);
    let gone: Value = engine
        .view("storage_balance_of", json!({ "account_id": carol.id() }))
        .await?;
    assert!(gone.is_null());
    gas.print();
    Ok(())
}
