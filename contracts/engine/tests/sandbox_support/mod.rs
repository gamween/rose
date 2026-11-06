//! Shared plumbing of the sandbox tests (`tests/sandbox_*.rs`): one sandbox worker and the
//! compiled contracts per test binary, engine deployment with a mock MPC that signs with
//! deterministic test keys (or replays recorded keys and responses for the replays of real
//! traffic), ForeignTx proofs registered per request, deterministic or recorded CKD outputs,
//! tUSDC funding, sealed orders, time travel and a gas table.
//!
//! The suite runs only with `ROSE_SANDBOX=1` (it downloads the sandbox binary and compiles three
//! contracts with cargo-near); without it every test prints a skip line and passes.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use ark_ec::{AffineRepr, CurveGroup};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use rand::rngs::StdRng;
use rand::SeedableRng;
use rose_engine::foreign::mpc::{
    self, payload_hash, Bytes32, Bytes64, EvmExtractor, EvmFinality, EvmRpcRequest, ExtractedValue,
    ForeignChainRpcRequest, SvmAccount, SvmExtractor, SvmFinality, SvmRpcRequest,
};
use rose_engine::foreign::{evm, solana as sol};
use rose_ibe::{AssociatedData, Fr, G1Affine, G2Affine, Plaintext, SALT_LEN};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::OnceCell;

pub const NS: u64 = 1_000_000_000;
pub const USDC: u128 = 1_000_000;
pub const SABLIER_LOCKUP: &str = "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e";
pub const STREAMFLOW_PROGRAM: &str = "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ";
pub const DEMO_TOKEN: &str = "0x17e75069dd837eda977abedf7a455adda42868a9";
/// RoseVault address the engine is configured with in the sandbox (the emitter of the logs the
/// tests attest).
pub const ROSE_VAULT: &str = "0x3985ddbbe8477dd42bd5e19f8726aae7a339b5e0";
pub const RECIPIENT: &str = "0x00000000000000000000000000000000000000aa";
/// Live MPC domains.
pub const DOMAIN_SECP256K1: u64 = 0;
pub const DOMAIN_ED25519: u64 = 1;
pub const DOMAIN_CKD: u64 = 2;
pub const DOMAIN_FOREIGN_TX: u64 = 3;
/// Deposits the engine requires.
pub const BID_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);
pub const ROUND_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(50);
pub const PAYOUT_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(25);
pub const RECORD_STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(15);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// Wallet cap on prepaid gas.
pub const WALLET_GAS: Gas = Gas::from_tgas(300);

/// True when the suite runs (`ROSE_SANDBOX=1`).
pub fn enabled(test: &str) -> bool {
    if std::env::var("ROSE_SANDBOX").is_ok_and(|v| v == "1") {
        true
    } else {
        eprintln!("{test}: skipped (set ROSE_SANDBOX=1 to run the sandbox tests)");
        false
    }
}

static ENGINE_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static MOCK_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();
static TUSDC_WASM: OnceCell<Vec<u8>> = OnceCell::const_new();

/// A fresh sandbox for one test (the binary is downloaded on first use). It is owned by the
/// test's [`Engine`]: dropping the last clone of the worker kills the near-sandbox child and
/// removes its temporary home, also when the test panics, so no sandbox outlives its test.
pub async fn worker() -> Result<Worker<Sandbox>> {
    let started = Instant::now();
    let worker = near_workspaces::sandbox().await?;
    eprintln!(
        "sandbox started in {:.1} s",
        started.elapsed().as_secs_f64()
    );
    Ok(worker)
}

async fn compiled(cell: &'static OnceCell<Vec<u8>>, project: &str) -> Result<Vec<u8>> {
    cell.get_or_try_init(|| async {
        let started = Instant::now();
        let wasm = near_workspaces::compile_project(project).await?;
        eprintln!(
            "compiled {project} ({} bytes) in {:.1} s",
            wasm.len(),
            started.elapsed().as_secs_f64()
        );
        Ok::<_, anyhow::Error>(wasm)
    })
    .await
    .cloned()
}

pub async fn engine_wasm() -> Result<Vec<u8>> {
    compiled(&ENGINE_WASM, "./").await
}

pub async fn mock_wasm() -> Result<Vec<u8>> {
    compiled(&MOCK_WASM, "../mock-mpc").await
}

pub async fn tusdc_wasm() -> Result<Vec<u8>> {
    compiled(&TUSDC_WASM, "../tusdc").await
}

/// Recorded real MPC responses (`tests/vectors/sandbox/recorded.json`).
#[derive(Deserialize)]
pub struct Recorded {
    pub mpc_public_keys: BTreeMap<String, RecordedKey>,
    pub ckd: Vec<RecordedCkd>,
}

#[derive(Deserialize)]
pub struct RecordedKey {
    pub key: String,
}

#[derive(Deserialize, Clone)]
pub struct RecordedCkd {
    pub engine: String,
    pub path: String,
    pub big_y: String,
    pub big_c: String,
    pub key: String,
}

/// A derived key read live from `v1.signer-prod.testnet` for a replayed engine account.
#[derive(Deserialize, Clone)]
pub struct RecordedDerivedKey {
    pub path: String,
    pub domain_id: u64,
    pub key: String,
}

impl Recorded {
    pub fn load() -> Result<Self> {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/vectors/sandbox/recorded.json"
        );
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    /// The recorded CKD output of `path` under `engine`, when one exists.
    pub fn ckd(&self, engine: &str, path: &str) -> Option<RecordedCkd> {
        self.ckd
            .iter()
            .find(|c| c.engine == engine && c.path == path)
            .cloned()
    }
}

/// A transaction recorded on the staging engine (`tests/vectors/sandbox/staging/*.json`): the
/// method arguments as sent, the MPC calls the engine made and every receipt with its value.
#[derive(Deserialize)]
pub struct StagingRecord {
    pub near_tx: String,
    pub engine: String,
    pub method: String,
    pub args: Value,
    pub receipts: Vec<StagingReceipt>,
    pub mpc_calls: Vec<StagingMpcCall>,
}

#[derive(Deserialize)]
pub struct StagingReceipt {
    pub executor: String,
    pub gas_burnt: u64,
    pub value: Value,
    pub logs: Vec<String>,
}

#[derive(Deserialize)]
pub struct StagingMpcCall {
    pub method: String,
    pub args: Value,
}

impl StagingRecord {
    pub fn load(name: &str) -> Result<Self> {
        let path = format!(
            "{}/tests/vectors/sandbox/staging/{name}.json",
            env!("CARGO_MANIFEST_DIR")
        );
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    /// The value the live MPC contract returned (the resumed yield's receipt).
    pub fn mpc_value(&self) -> Result<Value> {
        self.receipts
            .iter()
            .find(|r| r.executor == "v1.signer-prod.testnet" && !r.value.is_null())
            .map(|r| r.value.clone())
            .ok_or_else(|| anyhow!("{}: no MPC value recorded", self.near_tx))
    }

    /// The arguments of the engine's first MPC call.
    pub fn mpc_request(&self) -> Result<&Value> {
        self.mpc_calls
            .first()
            .map(|c| &c.args["request"])
            .ok_or_else(|| anyhow!("{}: no MPC call recorded", self.near_tx))
    }

    /// Total gas burnt by the recorded transaction, Tgas.
    pub fn tgas(&self) -> f64 {
        self.receipts.iter().map(|r| r.gas_burnt).sum::<u64>() as f64 / 1e12
    }

    /// A log containing `needle`, if any.
    pub fn log(&self, needle: &str) -> Option<&str> {
        self.receipts
            .iter()
            .flat_map(|r| r.logs.iter())
            .find(|l| l.contains(needle))
            .map(String::as_str)
    }
}

/// Deterministic test CKD master key (the same as the unit tests').
pub struct TestKey {
    msk: Fr,
}

impl TestKey {
    pub fn new() -> Self {
        Self {
            msk: Fr::from(0x5eed_c0de_1234_5678u64),
        }
    }

    pub fn mpk(&self) -> G2Affine {
        (G2Affine::generator() * self.msk).into_affine()
    }

    pub fn mpk_near(&self) -> String {
        rose_ibe::format_near_g2(&self.mpk())
    }

    /// The identity key of `round/<round_id>` under `engine`.
    pub fn round_key(&self, engine: &str, round_id: u64) -> G1Affine {
        let app_id = rose_ibe::round_app_id(engine, round_id);
        (rose_ibe::identity_point(&self.mpk(), &app_id) * self.msk).into_affine()
    }

    /// A CKD output `(Y, C) = (y * G1, key + y * pk1)` the engine unwraps with its public scalar.
    pub fn ckd_output(&self, engine: &str, round_id: u64) -> (String, String) {
        let y = Fr::from(0x7700_0000u64 + round_id);
        let (pk1, _) = rose_ibe::app_public_key_pv(&rose_ibe::app_scalar(engine, round_id));
        let big_y = (G1Affine::generator() * y).into_affine();
        let big_c = (self.round_key(engine, round_id).into_group() + pk1 * y).into_affine();
        (
            rose_ibe::format_near_g1(&big_y),
            rose_ibe::format_near_g1(&big_c),
        )
    }
}

impl Default for TestKey {
    fn default() -> Self {
        Self::new()
    }
}

/// A sealed order: hex ciphertext, plaintext and sigma.
pub struct Sealed {
    pub ciphertext: String,
    pub plaintext: String,
    pub sigma: String,
}

/// Seals `(quantity, price)` for `(round_id, bidder, side)` under `mpk` and the engine identity.
pub fn seal(
    mpk: &G2Affine,
    engine: &str,
    round_id: u64,
    bidder: &str,
    side: u8,
    quantity: u128,
    price: u128,
) -> Sealed {
    let mut seed = (quantity ^ price) as u64 ^ round_id ^ u64::from(side);
    for byte in bidder.as_bytes() {
        seed = seed.rotate_left(8) ^ u64::from(*byte);
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let plaintext = Plaintext {
        quantity,
        limit_price: price,
        salt: [side + 1; SALT_LEN],
    };
    let ad = AssociatedData {
        round_id,
        bidder,
        side,
    };
    let app_id = rose_ibe::round_app_id(engine, round_id);
    let (ciphertext, sigma) = rose_ibe::encrypt(&mut rng, mpk, &app_id, &ad, &plaintext);
    Sealed {
        ciphertext: hex::encode(ciphertext.to_bytes()),
        plaintext: hex::encode(plaintext.to_bytes()),
        sigma: hex::encode(sigma),
    }
}

/// Gas measured per method, printed as a table at the end of a test.
pub struct GasTable {
    scenario: String,
    rows: Mutex<Vec<(String, String, f64)>>,
}

impl GasTable {
    pub fn new(scenario: &str) -> Self {
        Self {
            scenario: scenario.to_string(),
            rows: Mutex::new(Vec::new()),
        }
    }

    /// Records a successful transaction of a user-facing method and asserts it fits the wallet
    /// cap. Returns the outcome for further inspection.
    pub fn ok(&self, method: &str, result: ExecutionFinalResult) -> Result<Done> {
        self.ok_in(&self.scenario.clone(), method, result)
    }

    /// Like [`GasTable::ok`] with an explicit scenario label.
    pub fn ok_in(
        &self,
        scenario: &str,
        method: &str,
        result: ExecutionFinalResult,
    ) -> Result<Done> {
        let tgas = result.total_gas_burnt.as_gas() as f64 / 1e12;
        if !result.is_success() {
            bail!(
                "{scenario}: {method} failed ({tgas:.2} Tgas): {:?}",
                result.failures()
            );
        }
        assert!(
            tgas < 300.0,
            "{scenario}: {method} burnt {tgas:.2} Tgas, above the 300 Tgas wallet cap"
        );
        self.rows
            .lock()
            .unwrap()
            .push((scenario.to_string(), method.to_string(), tgas));
        Ok(Done {
            logs: result.logs().iter().map(|l| l.to_string()).collect(),
            result,
        })
    }

    /// Records a transaction expected to fail with `expected` in its error.
    pub fn fails_with(
        &self,
        method: &str,
        result: ExecutionFinalResult,
        expected: &str,
    ) -> Result<()> {
        if result.is_success() {
            bail!(
                "{}: {method} succeeded, expected {expected:?}",
                self.scenario
            );
        }
        let message = format!("{:?}", result.failures());
        if !message.contains(expected) {
            bail!(
                "{}: {method} failed without {expected:?}: {message}",
                self.scenario
            );
        }
        Ok(())
    }

    /// The last measured gas of `method` in Tgas.
    pub fn tgas(&self, method: &str) -> Option<f64> {
        self.rows
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(_, m, _)| m == method)
            .map(|(_, _, t)| *t)
    }

    /// Prints the table.
    pub fn print(&self) {
        let rows = self.rows.lock().unwrap();
        eprintln!("\nGAS TABLE {}", self.scenario);
        eprintln!("| Scenario | Method | Tgas |");
        eprintln!("|---|---|---|");
        for (scenario, method, tgas) in rows.iter() {
            eprintln!("| {scenario} | {method} | {tgas:.2} |");
        }
        eprintln!();
    }
}

/// A successful, measured transaction.
pub struct Done {
    pub logs: Vec<String>,
    result: ExecutionFinalResult,
}

impl Done {
    /// The returned value.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T> {
        Ok(self.result.clone().json()?)
    }

    /// True when any log contains `needle`.
    pub fn logged(&self, needle: &str) -> bool {
        self.logs.iter().any(|log| log.contains(needle))
    }

    /// The receipts that failed inside an otherwise successful transaction (a callback that
    /// handled a `PromiseError`), for diagnostics.
    pub fn receipt_failures(&self) -> Vec<String> {
        self.result
            .receipt_outcomes()
            .iter()
            .filter(|outcome| outcome.is_failure())
            .map(|outcome| format!("{outcome:?}"))
            .collect()
    }
}

/// A deployed engine with its mock MPC and tUSDC.
pub struct Engine {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
    pub mock: Contract,
    pub tusdc: Contract,
    pub treasury: Account,
    pub recorded: Recorded,
    pub mpk: G2Affine,
}

/// How to deploy an engine.
pub struct EngineSpec {
    /// Account name (created with its parents), or a dev account.
    pub account: Option<&'static str>,
    /// CKD master public key (`bls12381g2:`).
    pub ckd_public_key: String,
    pub mpk: G2Affine,
    /// RoseVault address of the init arguments.
    pub rose_vault: String,
    /// Accepted Base cash tokens of the init arguments.
    pub base_cash_tokens: Vec<String>,
    /// Real derived keys the mock returns instead of its own (replays of a real account).
    pub derived_keys: Vec<RecordedDerivedKey>,
}

impl EngineSpec {
    /// An engine keyed to the deterministic test master key.
    pub fn test(key: &TestKey) -> Self {
        Self {
            account: None,
            ckd_public_key: key.mpk_near(),
            mpk: key.mpk(),
            rose_vault: ROSE_VAULT.to_string(),
            base_cash_tokens: vec!["0x036cbd53842c5426634e7929541ec2318f3dcf7e".to_string()],
            derived_keys: Vec::new(),
        }
    }
}

/// Creates `name` with every missing parent (the sandbox registrar only creates top-level
/// names, so `a.b.testnet` needs `testnet` and `b.testnet` first) and returns it. Accounts
/// that already exist in this sandbox are reused; keys are derived from the account name.
pub async fn ensure_account(worker: &Worker<Sandbox>, name: &str) -> Result<Account> {
    let labels: Vec<&str> = name.split('.').collect();
    let mut account: Option<Account> = None;
    for depth in (0..labels.len()).rev() {
        let id = labels[depth..].join(".");
        let sk = SecretKey::from_seed(KeyType::ED25519, &id);
        let exists = worker.view_account(&id.parse()?).await.is_ok();
        let current = if exists {
            Account::from_secret_key(id.parse()?, sk, worker)
        } else {
            let created = match &account {
                None => worker.create_tla(id.parse()?, sk).await?.into_result()?,
                Some(parent) => parent
                    .create_subaccount(labels[depth])
                    .keys(sk)
                    .initial_balance(NearToken::from_near(10))
                    .transact()
                    .await?
                    .into_result()?,
            };
            // Every account of the chain is funded by the sandbox root, so a parent never
            // pays for its children.
            worker
                .root_account()?
                .transfer_near(created.id(), NearToken::from_near(200))
                .await?
                .into_result()?;
            created
        };
        account = Some(current);
    }
    account.ok_or_else(|| anyhow!("empty account name"))
}

impl Engine {
    /// Deploys the mock MPC, tUSDC and the engine, initializes the engine (the mock derives its
    /// keys from the test seed unless the spec names recorded ones) and registers the engine on
    /// tUSDC.
    pub async fn deploy(spec: EngineSpec) -> Result<Self> {
        let worker = worker().await?;
        let recorded = Recorded::load()?;
        let mock = worker.dev_deploy(&mock_wasm().await?).await?;
        mock.call("new").transact().await?.into_result()?;
        for (domain, key) in &recorded.mpc_public_keys {
            mock.call("set_public_key")
                .args_json(json!({ "domain_id": domain.parse::<u64>()?, "key": key.key }))
                .transact()
                .await?
                .into_result()?;
        }
        let tusdc = worker.dev_deploy(&tusdc_wasm().await?).await?;
        tusdc.call("new").transact().await?.into_result()?;
        let treasury = worker.dev_create_account().await?;
        let contract = match spec.account {
            Some(name) => ensure_account(&worker, name)
                .await?
                .deploy(&engine_wasm().await?)
                .await?
                .into_result()?,
            None => worker.dev_deploy(&engine_wasm().await?).await?,
        };
        contract
            .call("new")
            .args_json(json!({ "args": {
                "mpc_account": mock.id(),
                "sign_secp256k1_domain": DOMAIN_SECP256K1,
                "sign_ed25519_domain": DOMAIN_ED25519,
                "ckd_domain": DOMAIN_CKD,
                "foreign_tx_domain": DOMAIN_FOREIGN_TX,
                "ckd_public_key": spec.ckd_public_key,
                "fee_recipient": treasury.id(),
                "near_cash_token": tusdc.id(),
                "base_cash_tokens": spec.base_cash_tokens,
                "rose_vault": spec.rose_vault,
                "base_chain_id": 84532,
                "sablier_lockup": SABLIER_LOCKUP,
                "streamflow_program": STREAMFLOW_PROGRAM,
                "default_key_timeout": null,
                "default_reveal_window": null,
            }}))
            .transact()
            .await?
            .into_result()?;
        for key in &spec.derived_keys {
            mock.call("set_derived_key")
                .args_json(json!({
                    "path": key.path,
                    "predecessor": contract.id(),
                    "domain_id": key.domain_id,
                    "key": key.key,
                }))
                .transact()
                .await?
                .into_result()?;
        }
        let bounds: Value = tusdc.view("storage_balance_bounds").await?.json()?;
        treasury
            .call(tusdc.id(), "storage_deposit")
            .args_json(json!({ "account_id": contract.id(), "registration_only": true }))
            .deposit(NearToken::from_yoctonear(u128_of(&bounds["min"])?))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            contract,
            mock,
            tusdc,
            treasury,
            recorded,
            mpk: spec.mpk,
        })
    }

    pub fn id(&self) -> &AccountId {
        self.contract.id()
    }

    /// Calls `bootstrap` and checks the derived addresses.
    pub async fn bootstrap(&self, gas: &GasTable) -> Result<()> {
        let result = self
            .treasury
            .call(self.id(), "bootstrap")
            .gas(Gas::from_tgas(80))
            .transact()
            .await?;
        gas.ok("bootstrap", result)?;
        let config: Value = self.view("get_config", json!({})).await?;
        let derived = &config["derived_addresses"];
        if derived.is_null() {
            bail!("bootstrap did not store the derived addresses");
        }
        Ok(())
    }

    /// A view call.
    pub async fn view<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        args: Value,
    ) -> Result<T> {
        Ok(self.contract.view(method).args_json(args).await?.json()?)
    }

    /// Block timestamp now, nanoseconds.
    pub async fn now_ns(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Produces blocks until the chain timestamp passes `target_ns`.
    pub async fn advance_past(&self, target_ns: u64) -> Result<()> {
        loop {
            let now = self.now_ns().await?;
            if now > target_ns {
                return Ok(());
            }
            let missing_secs = (target_ns - now) / NS + 1;
            self.worker
                .fast_forward(missing_secs.clamp(1, 2_000))
                .await?;
        }
    }

    /// A fresh account with 100 NEAR.
    pub async fn account(&self) -> Result<Account> {
        Ok(self.worker.dev_create_account().await?)
    }

    /// NEP-145 registration of `account` on the engine with the minimum deposit.
    pub async fn register(&self, account: &Account, gas: &GasTable) -> Result<()> {
        let bounds: Value = self.view("storage_balance_bounds", json!({})).await?;
        let result = account
            .call(self.id(), "storage_deposit")
            .args_json(json!({ "account_id": null, "registration_only": true }))
            .deposit(NearToken::from_yoctonear(u128_of(&bounds["min"])?))
            .transact()
            .await?;
        gas.ok("storage_deposit", result)?;
        Ok(())
    }

    /// Mints `amount` tUSDC to `account` and deposits it as NEAR-venue cash in the engine,
    /// registering `account` on the engine first (a NEAR cash deposit needs room for its row).
    pub async fn fund(&self, account: &Account, amount: u128, gas: &GasTable) -> Result<()> {
        self.register(account, gas).await?;
        let bounds: Value = self.tusdc.view("storage_balance_bounds").await?.json()?;
        account
            .call(self.tusdc.id(), "mint")
            .args_json(json!({ "amount": amount.to_string() }))
            .deposit(NearToken::from_yoctonear(u128_of(&bounds["min"])?))
            .transact()
            .await?
            .into_result()?;
        let result = account
            .call(self.tusdc.id(), "ft_transfer_call")
            .args_json(json!({
                "receiver_id": self.id(),
                "amount": amount.to_string(),
                "memo": null,
                "msg": "",
            }))
            .deposit(ONE_YOCTO)
            .gas(Gas::from_tgas(60))
            .transact()
            .await?;
        gas.ok("ft_transfer_call (tUSDC -> ft_on_transfer)", result)?;
        Ok(())
    }

    /// Free NEAR-venue cash of `account`.
    pub async fn cash(&self, account: &Account) -> Result<u128> {
        let cash: Vec<Value> = self
            .view("get_cash", json!({ "account": account.id() }))
            .await?;
        Ok(cash
            .iter()
            .find(|c| c["venue"] == "Near")
            .map(|c| u128_of(&c["amount"]))
            .transpose()?
            .unwrap_or(0))
    }

    pub async fn balance(&self, account: &AccountId, class_id: &str) -> Result<u128> {
        let balance: Value = self
            .view(
                "mt_balance_of",
                json!({ "account_id": account, "token_id": class_id }),
            )
            .await?;
        u128_of(&balance)
    }

    pub async fn claimable(&self, account: &AccountId, class_id: &str) -> Result<u128> {
        let claimable: Value = self
            .view(
                "get_claimable",
                json!({ "account": account, "class_id": class_id }),
            )
            .await?;
        u128_of(&claimable)
    }

    pub async fn round(&self, round_id: u64) -> Result<Value> {
        self.view("get_round", json!({ "round_id": round_id.to_string() }))
            .await
    }

    /// Registers a Sablier stream deposit attested by the mock: the ForeignTx response carries
    /// the hash the engine recomputes over its own request. Returns the class id.
    pub async fn base_deposit(
        &self,
        caller: &Account,
        stream: &BaseStream,
        gas: &GasTable,
    ) -> Result<String> {
        let class_id: String = self
            .contract
            .view("compute_base_class_id")
            .args_json(json!({
                "token": DEMO_TOKEN,
                "decimals": stream.decimals,
                "schedule": {
                    "start": stream.start,
                    "cliff": 0,
                    "end": stream.end,
                    "granularity": 1,
                    "start_unlock": "0",
                    "cliff_unlock": "0",
                    "deposited": stream.deposited.to_string(),
                },
            }))
            .await?
            .json()?;
        let deposit: Value = self
            .view(
                "registration_deposit_for",
                json!({ "account": stream.near_account, "class_id": class_id }),
            )
            .await?;
        self.prime_proof(&stream.request(), stream.payload_hash())
            .await?;
        let result = caller
            .call(self.id(), "register_base_deposit")
            .args_json(json!({ "location": stream.location(), "fields": stream.fields() }))
            .deposit(NearToken::from_yoctonear(u128_of(&deposit)?))
            .gas(Gas::from_tgas(60))
            .transact()
            .await?;
        let result = gas.ok("register_base_deposit", result)?;
        if !result.logged("deposit_registered") {
            bail!(
                "deposit not registered: {:?} {:?}",
                result.logs,
                result.receipt_failures()
            );
        }
        Ok(class_id)
    }

    /// Primes the mock with the CKD output of `round_id`: the recorded one when the fixture has
    /// it for this engine account, else the deterministic test output.
    pub async fn prime_ckd(&self, key: &TestKey, round_id: u64) -> Result<()> {
        let path = rose_ibe::round_path(round_id);
        let (big_y, big_c) = match self.recorded.ckd(self.id().as_str(), &path) {
            Some(recorded) => (recorded.big_y, recorded.big_c),
            None => key.ckd_output(self.id().as_str(), round_id),
        };
        self.mock
            .call("set_ckd_response")
            .args_json(json!({ "path": path, "big_y": big_y, "big_c": big_c }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// The key the mock derives for this engine on `(path, domain_id)`.
    pub async fn derived_key(&self, path: &str, domain_id: u64) -> Result<String> {
        Ok(self
            .mock
            .view("derived_public_key")
            .args_json(json!({ "path": path, "predecessor": self.id(), "domain_id": domain_id }))
            .await?
            .json()?)
    }

    /// Primes the mock with a raw recorded CKD output for `path`.
    pub async fn prime_ckd_raw(&self, path: &str, big_y: &str, big_c: &str) -> Result<()> {
        self.mock
            .call("set_ckd_response")
            .args_json(json!({ "path": path, "big_y": big_y, "big_c": big_c }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Primes the mock with a raw recorded `sign` response for `(domain_id, path)` over exactly
    /// `payload` (hex).
    pub async fn prime_sign_raw(
        &self,
        domain_id: u64,
        path: &str,
        payload: &str,
        response: &Value,
    ) -> Result<()> {
        self.mock
            .call("set_sign_response")
            .args_json(json!({
                "domain_id": domain_id,
                "path": path,
                "payload": payload,
                "response": response.to_string(),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Primes the mock with a raw recorded ForeignTx response for `tx_id`.
    pub async fn prime_foreign_raw(&self, tx_id: &str, response: &Value) -> Result<()> {
        self.mock
            .call("set_foreign_response")
            .args_json(json!({ "tx_id": tx_id, "response": response.to_string() }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Registers with the mock the payload hash the nodes would attest for `request` (the mock
    /// signs it with its ForeignTx test key when the engine sends exactly this request).
    pub async fn prime_proof(
        &self,
        request: &ForeignChainRpcRequest,
        hash: [u8; 32],
    ) -> Result<()> {
        self.mock
            .call("set_foreign_payload")
            .args_json(json!({
                "request": serde_json::to_value(request)?,
                "payload_hash": hex::encode(hash),
            }))
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    /// Registers an `AccountState` proof at `Finalized` of `accounts` (pubkey, owner, data)
    /// anchored at `anchor`.
    pub async fn prime_accounts(
        &self,
        anchor: &str,
        accounts: &[([u8; 32], [u8; 32], Vec<u8>)],
    ) -> Result<()> {
        let (request, hash) = solana_proof(anchor, accounts);
        self.prime_proof(&request, hash).await
    }

    /// Creates an Exit round closing in `open_secs`, with a short key timeout and reveal window.
    pub async fn create_exit(
        &self,
        creator: &Account,
        class_id: &str,
        max_price: u128,
        open_secs: u64,
        gas: &GasTable,
    ) -> Result<u64> {
        let result = creator
            .call(self.id(), "create_exit")
            .args_json(json!({ "params": {
                "class_id": class_id,
                "venue": "Near",
                "max_price": max_price.to_string(),
                "window": self.window(open_secs).await?,
            }}))
            .deposit(ROUND_STORAGE_DEPOSIT)
            .transact()
            .await?;
        round_id_of(gas.ok("create_exit", result)?)
    }

    /// A round window closing in `open_secs`, key timeout 60 s (the minimum), reveal window
    /// 600 s (deadlines
    /// are passed by fast-forwarding blocks, so long windows cost nothing and keep the tests
    /// independent of the machine's speed).
    pub async fn window(&self, open_secs: u64) -> Result<Value> {
        Ok(json!({
            "opens_at": null,
            "closes_at": (self.now_ns().await? + open_secs * NS).to_string(),
            "key_timeout": (60 * NS).to_string(),
            "reveal_window": (600 * NS).to_string(),
        }))
    }

    /// Places a sealed ask of `quantity @ price` locking `units`.
    pub async fn place_ask(
        &self,
        seller: &Account,
        round_id: u64,
        quantity: u128,
        price: u128,
        units: u128,
        gas: &GasTable,
    ) -> Result<(u32, Sealed)> {
        let sealed = seal(
            &self.mpk,
            self.id().as_str(),
            round_id,
            seller.id().as_str(),
            1,
            quantity,
            price,
        );
        let result = seller
            .call(self.id(), "place_ask")
            .args_json(json!({
                "round_id": round_id.to_string(),
                "ciphertext_hex": sealed.ciphertext,
                "units": units.to_string(),
            }))
            .deposit(BID_STORAGE_DEPOSIT)
            .transact()
            .await?;
        let bid_id: u32 = gas.ok("place_ask", result)?.json()?;
        Ok((bid_id, sealed))
    }

    /// Places a sealed bid of `quantity @ price` with the quoted escrow.
    pub async fn place_bid(
        &self,
        buyer: &Account,
        round_id: u64,
        quantity: u128,
        price: u128,
        gas: &GasTable,
    ) -> Result<(u32, Sealed, u128)> {
        let quote: Value = self
            .view(
                "quote_buy",
                json!({
                    "round_id": round_id.to_string(),
                    "quantity": quantity.to_string(),
                    "limit_price": price.to_string(),
                }),
            )
            .await?;
        let escrow = u128_of(&quote["escrow_required"])?;
        let sealed = seal(
            &self.mpk,
            self.id().as_str(),
            round_id,
            buyer.id().as_str(),
            0,
            quantity,
            price,
        );
        let result = buyer
            .call(self.id(), "place_bid")
            .args_json(json!({
                "round_id": round_id.to_string(),
                "ciphertext_hex": sealed.ciphertext,
                "escrow": escrow.to_string(),
            }))
            .deposit(BID_STORAGE_DEPOSIT)
            .transact()
            .await?;
        let bid_id: u32 = gas.ok("place_bid", result)?.json()?;
        Ok((bid_id, sealed, escrow))
    }

    /// Passes `closes_at`, primes the CKD output and closes the round; the key must be stored.
    pub async fn close(
        &self,
        caller: &Account,
        key: &TestKey,
        round_id: u64,
        gas: &GasTable,
    ) -> Result<Done> {
        self.prime_ckd(key, round_id).await?;
        self.close_primed(caller, round_id, gas).await
    }

    /// Passes `closes_at` and closes the round with whatever CKD output the mock holds for it;
    /// the key must be stored.
    pub async fn close_primed(
        &self,
        caller: &Account,
        round_id: u64,
        gas: &GasTable,
    ) -> Result<Done> {
        let round = self.round(round_id).await?;
        self.advance_past(u64_of(&round["closes_at"])?).await?;
        let result = caller
            .call(self.id(), "close")
            .args_json(json!({ "round_id": round_id.to_string() }))
            .gas(Gas::from_tgas(80))
            .transact()
            .await?;
        let result = gas.ok("close", result)?;
        let round = self.round(round_id).await?;
        if round["status"] != "Revealing" {
            bail!(
                "round {round_id} is {} after close: {:?}",
                round["status"],
                result.logs
            );
        }
        Ok(result)
    }

    /// Opens a bid with its plaintext and sigma.
    pub async fn open(
        &self,
        caller: &Account,
        round_id: u64,
        bid_id: u32,
        sealed: &Sealed,
        gas: &GasTable,
    ) -> Result<()> {
        let result = caller
            .call(self.id(), "open_bid")
            .args_json(json!({
                "round_id": round_id.to_string(),
                "bid_id": bid_id,
                "plaintext_hex": sealed.plaintext,
                "sigma_hex": sealed.sigma,
            }))
            .gas(WALLET_GAS)
            .transact()
            .await?;
        gas.ok("open_bid", result)?;
        Ok(())
    }

    /// Passes the reveal window and clears the round.
    pub async fn clear(&self, caller: &Account, round_id: u64, gas: &GasTable) -> Result<Value> {
        let round = self.round(round_id).await?;
        self.advance_past(u64_of(&round["reveal_ends_at"])?).await?;
        let result = caller
            .call(self.id(), "clear")
            .args_json(json!({ "round_id": round_id.to_string() }))
            .gas(WALLET_GAS)
            .transact()
            .await?;
        gas.ok("clear", result)?;
        self.round(round_id).await
    }

    /// Settles one bid.
    pub async fn settle(
        &self,
        caller: &Account,
        round_id: u64,
        bid_id: u32,
        gas: &GasTable,
    ) -> Result<()> {
        let result = caller
            .call(self.id(), "settle_bid")
            .args_json(json!({ "round_id": round_id.to_string(), "bid_id": bid_id }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?;
        gas.ok("settle_bid", result)?;
        Ok(())
    }
}

/// A Sablier Lockup Linear stream deposited into RoseVault, as the app reads the
/// `StreamDeposited` log. No cliff, `granularity = 1`, no start unlock.
pub struct BaseStream {
    pub tx_hash: String,
    pub log_index: u64,
    pub stream_id: u64,
    pub sender: String,
    pub near_account: String,
    pub decimals: u8,
    pub deposited: u128,
    pub withdrawn: u128,
    pub start: u64,
    pub end: u64,
    pub timestamp: u64,
}

impl BaseStream {
    /// A stream of `deposited` base units unlocking linearly from `now - elapsed` to
    /// `now - elapsed + duration`, deposited `deposited_ago` seconds ago with the vested part
    /// withdrawn to the holder at deposit time.
    pub fn midstream(
        stream_id: u64,
        near_account: &str,
        now_secs: u64,
        elapsed: u64,
        duration: u64,
        deposited: u128,
        deposited_ago: u64,
    ) -> Self {
        let start = now_secs - elapsed;
        let timestamp = now_secs - deposited_ago;
        let withdrawn = deposited * u128::from(timestamp - start) / u128::from(duration);
        let mut hash = [0u8; 32];
        hash[..8].copy_from_slice(&stream_id.to_be_bytes());
        hash[8..16].copy_from_slice(&now_secs.to_be_bytes());
        Self {
            tx_hash: hex::encode(hash),
            log_index: 2,
            stream_id,
            sender: "0xfa76b8f304d2a87fcaee0c258a76118368d0d671".into(),
            near_account: near_account.into(),
            decimals: 6,
            deposited,
            withdrawn,
            start,
            end: start + duration,
            timestamp,
        }
    }

    pub fn location(&self) -> Value {
        json!({
            "tx_hash": format!("0x{}", self.tx_hash),
            "block_hash": "0x8015dd9257215c67ebf562e96e1b295aa8e9e41bdb6e726307d1cdc866230535",
            "block_number": 54_159_281u64,
            "transaction_index": 2,
            "log_index": self.log_index,
        })
    }

    pub fn fields(&self) -> Value {
        json!({
            "sender": self.sender,
            "stream_id": self.stream_id,
            "near_account": self.near_account,
            "lockup": SABLIER_LOCKUP,
            "token": DEMO_TOKEN,
            "decimals": self.decimals,
            "deposited": self.deposited.to_string(),
            "withdrawn": self.withdrawn.to_string(),
            "start": self.start,
            "cliff": 0,
            "end": self.end,
            "granularity": 1,
            "start_unlock": "0",
            "cliff_unlock": "0",
            "cancelable": false,
            "transferable": true,
            "timestamp": self.timestamp,
        })
    }

    /// The ForeignTx request the engine sends for this log.
    pub fn request(&self) -> ForeignChainRpcRequest {
        ForeignChainRpcRequest::Base(EvmRpcRequest {
            tx_id: Bytes32(mpc::parse_hex_array(&self.tx_hash).unwrap()),
            extractors: vec![EvmExtractor::Log {
                log_index: self.log_index,
            }],
            finality: EvmFinality::Safe,
        })
    }

    /// The payload hash the engine recomputes for this log at `Safe` finality.
    pub fn payload_hash(&self) -> [u8; 32] {
        let event = evm::StreamDeposited {
            sender: evm::parse_address(&self.sender).unwrap(),
            stream_id: self.stream_id,
            near_account: self.near_account.clone(),
            lockup: evm::parse_address(SABLIER_LOCKUP).unwrap(),
            token: evm::parse_address(DEMO_TOKEN).unwrap(),
            decimals: self.decimals,
            deposited: self.deposited,
            withdrawn: self.withdrawn,
            start: self.start,
            cliff: 0,
            end: self.end,
            granularity: 1,
            start_unlock: 0,
            cliff_unlock: 0,
            cancelable: false,
            transferable: true,
            timestamp: self.timestamp,
        };
        let tx_hash: [u8; 32] = mpc::parse_hex_array(&self.tx_hash).unwrap();
        let log = event.evm_log(
            evm::parse_address(ROSE_VAULT).unwrap(),
            &evm::LogLocation {
                transaction_hash: tx_hash,
                transaction_index: 2,
                block_hash: mpc::parse_hex_array(
                    "8015dd9257215c67ebf562e96e1b295aa8e9e41bdb6e726307d1cdc866230535",
                )
                .unwrap(),
                block_number: 54_159_281,
                log_index: self.log_index,
            },
        );
        payload_hash(self.request(), vec![ExtractedValue::log(log)])
    }
}

/// The request and payload hash of a Solana `AccountState` proof at `Finalized` over
/// `accounts` (pubkey, owner, data) anchored at `anchor` (base58 signature).
pub fn solana_proof(
    anchor: &str,
    accounts: &[([u8; 32], [u8; 32], Vec<u8>)],
) -> (ForeignChainRpcRequest, [u8; 32]) {
    let mut anchor_bytes = [0u8; 64];
    bs58::decode(anchor).onto(&mut anchor_bytes).unwrap();
    let request = ForeignChainRpcRequest::Solana(SvmRpcRequest {
        tx_id: Bytes64(anchor_bytes),
        finality: SvmFinality::Finalized,
        extractors: accounts
            .iter()
            .map(|(pubkey, _, _)| SvmExtractor::AccountState {
                pubkey: Bytes32(*pubkey),
            })
            .collect(),
    });
    let hash = payload_hash(
        request.clone(),
        accounts
            .iter()
            .map(|(_, owner, data)| {
                ExtractedValue::account(SvmAccount {
                    owner: Bytes32(*owner),
                    data: data.clone(),
                })
            })
            .collect(),
    );
    (request, hash)
}

/// A classic SPL token account (165 bytes) of `mint` owned by `owner`, initialized.
pub fn token_account_bytes(mint: [u8; 32], owner: [u8; 32]) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(&mint);
    data[32..64].copy_from_slice(&owner);
    data[108] = 1;
    data
}

/// Streamflow metadata bytes (1,104 bytes) with every flag zero unless set.
pub struct StreamflowSpec {
    pub recipient: [u8; 32],
    pub mint: [u8; 32],
    pub start_time: u64,
    pub period: u64,
    pub amount_per_period: u64,
    pub net_amount_deposited: u64,
    pub end_time: u64,
    pub amount_withdrawn: u64,
}

impl StreamflowSpec {
    pub fn bytes(&self) -> Vec<u8> {
        let mut data = vec![0u8; 1104];
        let put = |data: &mut Vec<u8>, offset: usize, value: u64| {
            data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        };
        put(&mut data, 17, self.amount_withdrawn);
        put(&mut data, 33, self.end_time);
        data[49..81].copy_from_slice(&[5u8; 32]);
        data[113..145].copy_from_slice(&self.recipient);
        data[145..177]
            .copy_from_slice(&sol::associated_token_address(&self.recipient, &self.mint).unwrap());
        data[177..209].copy_from_slice(&self.mint);
        data[209..241].copy_from_slice(&[6u8; 32]);
        data[325..357].copy_from_slice(&[8u8; 32]);
        put(&mut data, 409, self.start_time);
        put(&mut data, 417, self.net_amount_deposited);
        put(&mut data, 425, self.period);
        put(&mut data, 433, self.amount_per_period);
        data[461] = 1;
        data
    }
}

/// A classic SPL Token mint account (82 bytes) with `decimals`.
pub fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[44] = decimals;
    data[45] = 1;
    data
}

/// Durable nonce account bytes (80 bytes): `Current`, initialized, `authority`, `value`.
pub fn nonce_bytes(authority: [u8; 32], value: [u8; 32]) -> Vec<u8> {
    let mut data = vec![0u8; 80];
    data[0] = 1;
    data[4] = 1;
    data[8..40].copy_from_slice(&authority);
    data[40..72].copy_from_slice(&value);
    data[72..80].copy_from_slice(&5_000u64.to_le_bytes());
    data
}

pub fn u128_of(value: &Value) -> Result<u128> {
    match value {
        Value::String(s) => s.parse().context("u128 string"),
        Value::Number(n) => n
            .as_u64()
            .map(u128::from)
            .ok_or_else(|| anyhow!("not a u128: {n}")),
        other => bail!("not a u128: {other}"),
    }
}

pub fn u64_of(value: &Value) -> Result<u64> {
    Ok(u64::try_from(u128_of(value)?)?)
}

pub fn round_id_of(result: Done) -> Result<u64> {
    let id: Value = result.json()?;
    u64_of(&id)
}
