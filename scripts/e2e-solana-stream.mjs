#!/usr/bin/env node
// End-to-end Streamflow flow on Solana devnet against a deployed engine (spec 7.2 and 7.3):
// a stream of a devnet test SPL token is created to a holder, the holder moves it to its engine
// deposit address (transfer_recipient), the engine attributes it (ForeignTx AccountState proof),
// signs the move to the vault, registers it once it sits at the vault, signs a payout drawing on
// the stream (Streamflow withdraw + TransferChecked in one durable-nonce transaction), which is
// broadcast and then confirmed with a proof that the nonce advanced and the stream paid, and
// finally signs the in-kind release of the position, broadcast and confirmed the same way.
//
// With --case ended, the stream runs 65 minutes (the engine refuses one ending within an hour of
// its attribution) and stays in the vault until it ends: Streamflow's auto-claim then withdraws
// its whole remainder into the vault's token account, `sync_sol_stream` books it in the class's
// swept balance, and a claim paid from that balance alone (no draw, `TransferChecked` and the
// receipt advance) is broadcast and confirmed on its receipt.
//
//   node scripts/e2e-solana-stream.mjs <engine account> <step> [--holder <near account>] [--case main|ended]
// Steps, in order: setup, transfer, attribute, move, register, claim, confirm, redeem,
// confirm-redeem (or `all`); with --case ended: setup, transfer, attribute, move, register,
// wait-end, sync, claim-swept, confirm (or `all`). Every signature and NEAR transaction is recorded
// in deployments/e2e/<engine>.solana.json (<engine>.solana-ended.json for --case ended); `setup`
// and the claims resume what an earlier attempt sent instead of sending it again. --holder (the NEAR account credited, its key in the legacy
// keychain) is required on the first run and then read from that file. Keys, under
// $ROSE_CONFIG_DIR (default ~/.config/rose): the ops key solana-ops.json funds everything (never
// printed); the Solana holder key is generated into solana-holder.json (mode 600); NEAR calls use
// the legacy keychain. Endpoints: SOLANA_RPC_URL (default https://api.devnet.solana.com) and
// NEAR_RPC_URL (default https://test.rpc.fastnear.com).
// Dependencies: scripts is a workspace package (`pnpm install` at the root, then
// `pnpm --filter @rose/sdk build` once so @rose/sdk resolves).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, NonceAccount, PublicKey,
  SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { ICluster, SolanaStreamClient } from "@streamflow/stream";
import { createNonceAccountTransaction, nonceRent, payoutNonceAddress, payoutNonceSeed } from "@rose/sdk";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const NEAR_RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const CONFIG_DIR = process.env.ROSE_CONFIG_DIR ?? join(homedir(), ".config", "rose");
const MPC = "v1.signer-prod.testnet";
const STREAMFLOW_PROGRAM = "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const nearExplorer = (hash) => `https://testnet.near.rocks/tx/${hash}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [engine, step, ...rest] = process.argv.slice(2);
if (!engine || !step) {
  console.error("usage: e2e-solana-stream.mjs <engine account> <step|all> [--holder <near account>] [--case main|ended]");
  process.exit(2);
}
let holderFlag = null;
let flowCase = "main";
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === "--holder") holderFlag = rest[i + 1];
  else if (rest[i] === "--case") flowCase = rest[i + 1];
  else throw new Error(`unknown argument ${rest[i]}`);
}
if (flowCase !== "main" && flowCase !== "ended") throw new Error(`--case must be main or ended, not ${flowCase}`);

const conn = new Connection(RPC, "confirmed");
const ops = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(CONFIG_DIR, "solana-ops.json"), "utf8"))));
const holderFile = join(CONFIG_DIR, "solana-holder.json");
if (!existsSync(holderFile)) writeFileSync(holderFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const holder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(holderFile, "utf8"))));
const stateFile = join(root, "deployments", "e2e", flowCase === "main" ? `${engine}.solana.json` : `${engine}.solana-ended.json`);
mkdirSync(dirname(stateFile), { recursive: true });
const recorded = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
const nearHolder = holderFlag ?? recorded?.near_holder;
if (!nearHolder) {
  console.error("--holder <near account> is required on the first run (its key must be in the legacy keychain)");
  process.exit(2);
}
const state = recorded ?? { engine, near_holder: nearHolder, steps: {} };
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
const log = (...args) => console.error(...args);

async function nearView(account, method, args = {}) {
  const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
  for (let attempt = 0; ; attempt += 1) {
    const res = await (await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (res.result?.result) return JSON.parse(Buffer.from(res.result.result).toString());
    const error = res.result?.error ?? res.error;
    // Public RPCs answer -429 when rate limited: back off and retry a few times.
    if (error?.code !== -429 || attempt >= 8) throw new Error(`view ${account}.${method}: ${JSON.stringify(error)}`);
    await sleep(3000 * (attempt + 1));
  }
}
async function nearTxStatus(hash, sender) {
  const body = { jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" } };
  const res = await (await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return res.result;
}
function nearCall(signer, method, args, gas, deposit) {
  const run = spawnSync("near", ["contract", "call-function", "as-transaction", engine, method, "json-args", JSON.stringify(args),
    "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-legacy-keychain", "send"],
  { encoding: "utf8" });
  const out = `${run.stdout}\n${run.stderr}`;
  if (run.status !== 0) throw new Error(`near call ${method} failed:\n${out}`);
  const hash = /Transaction ID: ([1-9A-HJ-NP-Za-km-z]+)/.exec(out)?.[1];
  if (!hash) throw new Error(`no transaction id in near-cli output:\n${out}`);
  return hash;
}
async function record(name, hash, signer, extra = {}) {
  const status = await nearTxStatus(hash, signer);
  const gas = ([status.transaction_outcome, ...status.receipts_outcome].reduce((sum, o) => sum + o.outcome.gas_burnt, 0) / 1e12).toFixed(2);
  const mpc = status.receipts_outcome.filter((o) => o.outcome.executor_id === MPC && o.outcome.status.SuccessValue)
    .map((o) => JSON.parse(Buffer.from(o.outcome.status.SuccessValue, "base64").toString() || "null")).filter((v) => v !== null);
  state.steps[name] = { ...(state.steps[name] ?? {}), near_tx: hash, link: nearExplorer(hash), gas_tgas: Number(gas), mpc_responses: mpc, ...extra };
  save();
  log(`${name}: ${nearExplorer(hash)} (${gas} Tgas)`);
  return status;
}
async function waitFinalized(signature) {
  for (let i = 0; i < 60; i += 1) {
    // History included: the recent-status cache forgets a signature after about 150 slots, so a
    // resumed step would otherwise wait for a transaction finalized long ago.
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (st?.confirmationStatus === "finalized") return;
    await sleep(2000);
  }
  throw new Error(`${signature} not finalized`);
}
async function accountHex(pubkey) {
  const info = await conn.getAccountInfo(new PublicKey(pubkey), "finalized");
  if (!info) throw new Error(`account ${pubkey} missing`);
  return { data: Buffer.from(info.data).toString("hex"), owner: info.owner.toBase58() };
}
async function waitPayout(id) {
  for (let i = 0; i < 90; i += 1) {
    const payout = await nearView(engine, "get_payout", { payout_id: String(id) });
    if (payout.status === "Signed" || payout.status?.Failed) return payout;
    await sleep(2000);
  }
  throw new Error(`payout ${id} still pending`);
}
async function broadcast(payout, name) {
  const wire = Buffer.from(payout.solana.transaction, "base64");
  const vtx = VersionedTransaction.deserialize(wire);
  const sim = await conn.simulateTransaction(vtx, { sigVerify: true });
  if (sim.value.err) throw new Error(`simulation of ${name} failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`);
  const sig = await conn.sendRawTransaction(wire, { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  await waitFinalized(sig);
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  state.steps[name] = { ...(state.steps[name] ?? {}), solana_tx: sig, solana_link: explorer(sig), fee: tx?.meta?.fee, units: sim.value.unitsConsumed };
  save();
  log(`${name} broadcast: ${explorer(sig)} (fee ${tx?.meta?.fee} lamports, ${sim.value.unitsConsumed} CU)`);
  return sig;
}

const config = await nearView(engine, "get_config");
const derived = config.derived_addresses;
if (!derived) throw new Error("engine is not bootstrapped");
const vault = new PublicKey(derived.vault_sol);
const gasPayer = new PublicKey(derived.gas_sol);
const client = new SolanaStreamClient(RPC, ICluster.Devnet, "confirmed");

const schedule = () => state.steps.setup.schedule;
// Token amounts of `compute_sol_class_id` are U64 JSON strings; timestamps and the period stay numbers.
const classArgs = () => {
  const s = schedule();
  return { mint: state.steps.setup.mint, decimals: 6, schedule: { ...s, net_amount_deposited: String(s.net_amount_deposited), amount_per_period: String(s.amount_per_period), cliff_amount: String(s.cliff_amount) } };
};

/** The id in the transaction's own `payout_requested` event (the engine is shared: the global counter can already count someone else's request). */
function payoutIdOf(status) {
  for (const receipt of status.receipts_outcome) {
    for (const line of receipt.outcome.logs) {
      if (!line.startsWith("EVENT_JSON:")) continue;
      const event = JSON.parse(line.slice("EVENT_JSON:".length));
      if (event.standard === "rose" && event.event === "payout_requested") return event.data.payout_id;
    }
  }
  throw new Error(`no payout_requested event in ${status.transaction.hash}`);
}

/** The oldest signature of an account: its creation transaction. */
async function creationSignature(address) {
  const signatures = await conn.getSignaturesForAddress(new PublicKey(address), {}, "finalized");
  const oldest = signatures.at(-1)?.signature;
  if (!oldest) throw new Error(`${address} has no finalized transaction yet: run the step again`);
  return oldest;
}

// 60 tokens unlock per minute: two hours for the main flow, 65 minutes for the ended case.
const STREAM_AMOUNT = flowCase === "main" ? 7_200_000_000n : 3_900_000_000n;

async function stepSetup() {
  if (state.steps.setup?.schedule) {
    log("setup already done: stream", state.steps.setup.metadata);
    return;
  }
  log("ops balance", (await conn.getBalance(ops.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  const gasBalance = await conn.getBalance(gasPayer);
  if (gasBalance < 0.05 * LAMPORTS_PER_SOL) {
    const holderBalance = await conn.getBalance(holder.publicKey);
    const fund = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: ops.publicKey, toPubkey: gasPayer, lamports: 0.05 * LAMPORTS_PER_SOL }),
    );
    if (holderBalance < 0.02 * LAMPORTS_PER_SOL) {
      fund.add(SystemProgram.transfer({ fromPubkey: ops.publicKey, toPubkey: holder.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    }
    const sig = await sendAndConfirmTransaction(conn, fund, [ops]);
    state.steps.fund = { solana_tx: sig, solana_link: explorer(sig), gas_sol: gasPayer.toBase58(), holder: holder.publicKey.toBase58() };
    log("funded gas/sol with 0.05 SOL (and the holder when short):", explorer(sig));
  }
  // The mint is recorded as soon as it exists, so a resumed setup reuses it.
  if (!state.steps.setup?.mint) {
    const created = await createMint(conn, ops, ops.publicKey, null, 6);
    state.steps.setup = { mint: created.toBase58(), holder: holder.publicKey.toBase58() };
    save();
  }
  const mint = new PublicKey(state.steps.setup.mint);
  // The mint is this run's own, so a stream of it from ops to the holder can only be one an
  // earlier attempt created before it stopped: reuse it instead of creating a second one.
  const existing = (await client.searchStreams({ mint: mint.toBase58(), sender: ops.publicKey.toBase58(), recipient: holder.publicKey.toBase58() }))[0];
  let metadataId;
  let txId;
  if (existing) {
    metadataId = existing.publicKey.toBase58();
    txId = await creationSignature(metadataId);
    log("reusing stream", metadataId, "created by an earlier attempt");
  } else {
    const ata = await getOrCreateAssociatedTokenAccount(conn, ops, mint, ops.publicKey);
    if (ata.amount < STREAM_AMOUNT) await mintTo(conn, ops, mint, ata.address, ops, STREAM_AMOUNT - ata.amount);
    const now = Math.floor(Date.now() / 1000);
    // 60 tokens unlocking per minute (two hours, or 65 minutes for the ended case), starting in a
    // minute (the engine refuses a stream ending within an hour of its attribution): no cliff, no
    // sender permissions, transferable by the recipient, no automatic withdrawal.
    const params = {
      recipient: holder.publicKey.toBase58(), tokenId: mint.toBase58(), start: now + 60, cliff: 0,
      amount: new BN(STREAM_AMOUNT.toString()), cliffAmount: new BN(0), amountPerPeriod: new BN(60_000_000), period: 60,
      name: "rose staging", cancelableBySender: false, cancelableByRecipient: false, transferableBySender: false,
      transferableByRecipient: true, canTopup: false, automaticWithdrawal: false, canPause: false, canUpdateRate: false,
    };
    const res = await client.create(params, { sender: ops, isNative: false });
    metadataId = res.metadataId;
    txId = res.txId;
    state.steps.setup = { ...state.steps.setup, metadata: metadataId, create_tx: txId, create_link: explorer(txId) };
    save();
  }
  await waitFinalized(txId);
  const stream = await client.getOne({ id: metadataId });
  state.steps.setup = {
    ...state.steps.setup, metadata: metadataId, create_tx: txId, create_link: explorer(txId),
    schedule: { start_time: Number(stream.start), cliff: Number(stream.cliff), cliff_amount: Number(stream.cliffAmount),
      period: Number(stream.period), amount_per_period: Number(stream.amountPerPeriod),
      net_amount_deposited: Number(stream.depositedAmount), end_time: Number(stream.end) },
  };
  save();
  log("stream", metadataId, "created:", explorer(txId), JSON.stringify(state.steps.setup.schedule));
}

async function stepTransfer() {
  const classId = await nearView(engine, "compute_sol_class_id", classArgs());
  const path = `dep/${nearHolder}/${classId}`;
  const key = await nearView(MPC, "derived_public_key", { path, predecessor: engine, domain_id: config.sign_ed25519_domain });
  const depositAddress = key.replace("ed25519:", "");
  const res = await client.transfer({ id: state.steps.setup.metadata, newRecipient: depositAddress }, { invoker: holder });
  await waitFinalized(res.txId);
  state.steps.transfer = { class_id: classId, path, deposit_address: depositAddress, solana_tx: res.txId, solana_link: explorer(res.txId) };
  save();
  log(`transfer_recipient to ${depositAddress} (${path}):`, explorer(res.txId));
}

async function stepAttribute() {
  const metadata = await accountHex(state.steps.setup.metadata);
  const mint = await accountHex(state.steps.setup.mint);
  if (metadata.owner !== STREAMFLOW_PROGRAM) throw new Error(`metadata owner ${metadata.owner}`);
  const args = { args: { metadata: state.steps.setup.metadata, class_id: state.steps.transfer.class_id, return_to: holder.publicKey.toBase58(),
    anchor_tx: state.steps.transfer.solana_tx, metadata_data: metadata.data, mint_data: mint.data } };
  const hash = nearCall(nearHolder, "attribute_sol_deposit", args, "120 Tgas", "0.015 NEAR");
  await record("attribute", hash, nearHolder);
  const deposit = await nearView(engine, "get_sol_deposit", { metadata: state.steps.setup.metadata });
  if (deposit?.stage !== "Attributed") throw new Error(`not attributed: ${JSON.stringify(deposit)}`);
  log("attributed:", JSON.stringify(deposit));
}

async function stepMove() {
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  const hash = nearCall(nearHolder, "move_sol_deposit", { metadata: state.steps.setup.metadata, recent_blockhash: blockhash }, "120 Tgas", "0.025 NEAR");
  await record("move", hash, nearHolder);
  const deposit = await nearView(engine, "get_sol_deposit", { metadata: state.steps.setup.metadata });
  const payoutId = deposit.stage.MoveSigned.payout_id;
  const payout = await waitPayout(payoutId);
  if (payout.status !== "Signed") throw new Error(`move not signed: ${JSON.stringify(payout.status)}`);
  state.steps.move.payout_id = payoutId;
  await broadcast(payout, "move");
  const stream = await client.getOne({ id: state.steps.setup.metadata });
  log("stream recipient now", stream.recipient, stream.recipient === vault.toBase58() ? "(the vault)" : "(NOT the vault)");
}

async function stepRegister() {
  const metadata = await accountHex(state.steps.setup.metadata);
  const deposit = await nearView(engine, "registration_deposit_for", { account: nearHolder, class_id: state.steps.transfer.class_id });
  const attached = `${Number(BigInt(deposit)) / 1e24} NEAR`;
  const hash = nearCall(nearHolder, "register_sol_deposit", { metadata: state.steps.setup.metadata, anchor_tx: state.steps.move.solana_tx, metadata_data: metadata.data }, "80 Tgas", attached);
  await record("register", hash, nearHolder);
  const record_ = await nearView(engine, "get_sol_deposit", { metadata: state.steps.setup.metadata });
  if (!record_.stage?.Registered) throw new Error(`not registered: ${JSON.stringify(record_)}`);
  const positionId = record_.stage.Registered.position_id;
  const units = await nearView(engine, "mt_balance_of", { account_id: nearHolder, token_id: state.steps.transfer.class_id });
  const info = await nearView(engine, "get_sol_stream", { position_id: positionId });
  state.steps.register.position_id = positionId;
  state.steps.register.units = units;
  state.steps.register.engine_withdrawn = info.engine_withdrawn;
  save();
  log(`registered position ${positionId}: ${units} units to ${nearHolder}, engine_withdrawn ${info.engine_withdrawn}`);
}

/**
 * The nonce proof of a payout or redeem to `owner`: the nonce account, the receipt nonce account
 * (which the transaction advances last) and `owner`'s token account, read at finalized.
 */
async function payoutProof(owner, anchor) {
  const nonceInfo = await conn.getAccountInfo(new PublicKey(state.steps.claim.nonce_account), "finalized");
  const receipt = await accountHex(state.steps.claim.receipt_account);
  const recipientTokens = getAssociatedTokenAddressSync(new PublicKey(state.steps.setup.mint), owner);
  const tokens = await accountHex(recipientTokens.toBase58());
  return {
    proof: {
      account: state.steps.claim.nonce_account,
      base: state.steps.claim.nonce_base,
      seed: state.steps.claim.nonce_seed,
      receipt_seed: state.steps.claim.receipt_seed,
      anchor_tx: anchor,
      data: Buffer.from(nonceInfo.data).toString("hex"),
      receipt_data: receipt.data,
      recipient_tokens_data: tokens.data,
    },
    value: NonceAccount.fromAccountData(nonceInfo.data).nonce,
  };
}

/** Creates the claimant's nonce and receipt accounts once and records them in `state.steps.claim`. */
async function ensureNonceAccounts() {
  if (!state.steps.claim?.nonce_account) {
    // The engine accepts only nonce accounts created with seeds naming the claimant (spec 7.3):
    // createWithSeed(ops, prefix(nearHolder) + suffix, System), so nobody else can spend their
    // values. The receipt account is the second one: the payout advances it last.
    const suffix = Date.now().toString(36).slice(-7);
    const seed = await payoutNonceSeed(nearHolder, `${suffix}a`);
    const receiptSeed = await payoutNonceSeed(nearHolder, `${suffix}r`);
    const nonceAccount = await payoutNonceAddress(ops.publicKey, seed);
    const receiptAccount = await payoutNonceAddress(ops.publicKey, receiptSeed);
    const rent = await nonceRent(conn);
    const latest = await conn.getLatestBlockhash("confirmed");
    const create = createNonceAccountTransaction({ payer: ops.publicKey, nonceAccount, seed, authority: vault, lamports: rent, ...latest });
    create.add(...createNonceAccountTransaction({ payer: ops.publicKey, nonceAccount: receiptAccount, seed: receiptSeed, authority: vault, lamports: rent, ...latest }).instructions);
    const createSig = await sendAndConfirmTransaction(conn, create, [ops]);
    state.steps.claim = {
      nonce_account: nonceAccount.toBase58(), nonce_base: ops.publicKey.toBase58(), nonce_seed: seed,
      receipt_account: receiptAccount.toBase58(), receipt_seed: receiptSeed,
      nonce_create_tx: createSig, nonce_create_link: explorer(createSig), to_owner: ops.publicKey.toBase58(),
    };
    save();
  }
  await waitFinalized(state.steps.claim.nonce_create_tx);
}

// Resumable: the nonce account, the NEAR claim and the broadcast are each recorded as soon as they
// exist, and a rerun continues from the first one missing instead of claiming again.
async function stepClaim() {
  if (state.steps.claim?.recipient_balance) {
    log("claim already done: payout", state.steps.claim.payout_id);
    return;
  }
  await ensureNonceAccounts();
  if (!state.steps.claim.near_tx) {
    const claimable = await nearView(engine, "get_claimable", { account: nearHolder, class_id: state.steps.transfer.class_id });
    if (claimable === "0") throw new Error("nothing claimable yet: the stream unlocks 60 tokens per minute after its start");
    const streams = await nearView(engine, "get_sol_streams", { class_id: state.steps.transfer.class_id });
    const stream = streams.find((s) => s.position_id === state.steps.register.position_id);
    const amount = BigInt(stream.withdrawable) < BigInt(claimable) ? stream.withdrawable : claimable;
    const { proof, value } = await payoutProof(ops.publicKey, state.steps.claim.nonce_create_tx);
    state.steps.claim.amount = amount;
    state.steps.claim.nonce_value = value;
    save();
    const draws = [{ position_id: state.steps.register.position_id, amount }];
    const hash = nearCall(nearHolder, "claim_sol_tokens", { source: { Holding: { class_id: state.steps.transfer.class_id } }, draws, to_owner: ops.publicKey.toBase58(), nonce: proof }, "200 Tgas", "0.025 NEAR");
    await record("claim", hash, nearHolder);
  }
  if (!state.steps.claim.payout_id) {
    state.steps.claim.payout_id = payoutIdOf(await nearTxStatus(state.steps.claim.near_tx, nearHolder));
    save();
  }
  const payout = await waitPayout(state.steps.claim.payout_id);
  if (payout.status !== "Signed") throw new Error(`claim not signed: ${JSON.stringify(payout.status)}`);
  state.steps.claim.draws = payout.solana.draws;
  const ata = getAssociatedTokenAddressSync(new PublicKey(state.steps.setup.mint), ops.publicKey);
  const balance = () => conn.getTokenAccountBalance(ata, "confirmed").then((b) => b.value.amount);
  if (!state.steps.claim.solana_tx) {
    state.steps.claim.balance_before = await balance();
    save();
    await broadcast(payout, "claim");
  }
  const before = state.steps.claim.balance_before;
  const after = await balance();
  state.steps.claim.recipient_balance = { before, after };
  save();
  log(`claimed ${state.steps.claim.amount}: recipient balance ${before} -> ${after}`);
}

/** Waits until the stream ended and Streamflow's auto-claim emptied it into the vault, at finality. */
async function stepWaitEnd() {
  if (state.steps.wait_end?.auto_claim_tx) {
    log("auto-claim already seen:", state.steps.wait_end.auto_claim_link);
    return;
  }
  const end = schedule().end_time;
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now > end + 1) break;
    log(`stream ends in ${end - now} s; draws stopped ${now >= end - 300 ? "already" : `in ${end - 300 - now} s`}`);
    await sleep(Math.min(60, end + 2 - now) * 1000);
  }
  const metadata = new PublicKey(state.steps.setup.metadata);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const info = await conn.getAccountInfo(metadata, "finalized");
    const withdrawn = info ? Buffer.from(info.data).readBigUInt64LE(17) : 0n;
    const net = BigInt(schedule().net_amount_deposited);
    if (withdrawn === net) {
      const latest = (await conn.getSignaturesForAddress(metadata, { limit: 10 }, "finalized")).find((entry) => entry.err === null);
      state.steps.wait_end = { amount_withdrawn: withdrawn.toString(), auto_claim_tx: latest.signature, auto_claim_link: explorer(latest.signature), memo: latest.memo ?? null };
      save();
      log(`auto-claim seen at finality (${latest.memo ?? "no memo"}): ${explorer(latest.signature)}; amount_withdrawn ${withdrawn} of ${net}`);
      return;
    }
    log(`waiting for the auto-claim: amount_withdrawn ${withdrawn} of ${net} at finality`);
    await sleep(10_000);
  }
  throw new Error("the auto-claim did not show at finality within 10 minutes of the end");
}

/** `sync_sol_stream`: the engine proves the metadata and books the auto-claim in the class's swept balance. */
async function stepSync() {
  if (state.steps.sync?.swept_after) {
    log("sync already done:", state.steps.sync.link);
    return;
  }
  const classId = state.steps.transfer.class_id;
  const before = await nearView(engine, "get_sol_swept", { class_id: classId });
  const metadata = await accountHex(state.steps.setup.metadata);
  const hash = nearCall(nearHolder, "sync_sol_stream", { position_id: state.steps.register.position_id, anchor_tx: state.steps.wait_end.auto_claim_tx, metadata_data: metadata.data }, "80 Tgas", "0 NEAR");
  const status = await record("sync", hash, nearHolder);
  const event = status.receipts_outcome.flatMap((o) => o.outcome.logs).filter((line) => line.startsWith("EVENT_JSON:")).map((line) => JSON.parse(line.slice("EVENT_JSON:".length))).find((e) => e.event === "sol_stream_swept");
  if (!event) throw new Error(`no sol_stream_swept event in ${hash}`);
  const after = await nearView(engine, "get_sol_swept", { class_id: classId });
  const streams = await nearView(engine, "get_sol_streams", { class_id: classId });
  state.steps.sync = { ...state.steps.sync, booked: event.data.amount, swept_before: before, swept_after: after, stream_pruned: !streams.some((entry) => entry.position_id === state.steps.register.position_id) };
  save();
  log(`synced: ${event.data.amount} booked, swept balance ${before.balance} -> ${after.balance}, stream pruned: ${state.steps.sync.stream_pruned}`);
}

/** A claim paid from the swept balance alone: no draw, `TransferChecked` and the receipt advance. */
async function stepClaimSwept() {
  if (state.steps.claim?.recipient_balance) {
    log("swept claim already done: payout", state.steps.claim.payout_id);
    return;
  }
  await ensureNonceAccounts();
  const classId = state.steps.transfer.class_id;
  if (!state.steps.claim.near_tx) {
    const claimable = BigInt(await nearView(engine, "get_claimable", { account: nearHolder, class_id: classId }));
    const swept = await nearView(engine, "get_sol_swept", { class_id: classId });
    const available = BigInt(swept.balance) - BigInt(swept.pending);
    const amount = (claimable < available ? claimable : available).toString();
    if (amount === "0") throw new Error(`nothing to claim from the swept balance: claimable ${claimable}, available ${available}`);
    const { proof, value } = await payoutProof(ops.publicKey, state.steps.claim.nonce_create_tx);
    state.steps.claim.amount = amount;
    state.steps.claim.nonce_value = value;
    state.steps.claim.swept_before = swept;
    save();
    const hash = nearCall(nearHolder, "claim_sol_tokens", { source: { Holding: { class_id: classId } }, draws: [], swept: amount, to_owner: ops.publicKey.toBase58(), nonce: proof }, "200 Tgas", "0.025 NEAR");
    await record("claim", hash, nearHolder);
  }
  if (!state.steps.claim.payout_id) {
    state.steps.claim.payout_id = payoutIdOf(await nearTxStatus(state.steps.claim.near_tx, nearHolder));
    save();
  }
  const payout = await waitPayout(state.steps.claim.payout_id);
  if (payout.status !== "Signed") throw new Error(`swept claim not signed: ${JSON.stringify(payout.status)}`);
  if (payout.solana.draws.length !== 0 || payout.solana.swept !== state.steps.claim.amount) throw new Error(`unexpected payout: draws ${JSON.stringify(payout.solana.draws)}, swept ${payout.solana.swept}`);
  state.steps.claim.swept_pending = (await nearView(engine, "get_sol_swept", { class_id: classId })).pending;
  const ata = getAssociatedTokenAddressSync(new PublicKey(state.steps.setup.mint), ops.publicKey);
  const balance = () => conn.getTokenAccountBalance(ata, "confirmed").then((b) => b.value.amount);
  if (!state.steps.claim.solana_tx) {
    state.steps.claim.balance_before = await balance();
    save();
    await broadcast(payout, "claim");
  }
  const after = await balance();
  state.steps.claim.recipient_balance = { before: state.steps.claim.balance_before, after };
  save();
  log(`claimed ${state.steps.claim.amount} from the swept balance: recipient balance ${state.steps.claim.balance_before} -> ${after}`);
}

async function stepConfirm() {
  const nonce = await accountHex(state.steps.claim.nonce_account);
  const receipt = await accountHex(state.steps.claim.receipt_account);
  const hash = nearCall(nearHolder, "confirm_sol_payout", { payout_id: state.steps.claim.payout_id, anchor_tx: state.steps.claim.solana_tx, nonce_data: nonce.data, receipt_data: receipt.data }, "100 Tgas", "0 NEAR");
  await record("confirm", hash, nearHolder);
  const payout = await nearView(engine, "get_payout", { payout_id: state.steps.claim.payout_id });
  if (payout.status !== "Landed") throw new Error(`payout not landed: ${JSON.stringify(payout.status)}`);
  state.steps.confirm.status = payout.status;
  if (flowCase === "ended") {
    const swept = await nearView(engine, "get_sol_swept", { class_id: state.steps.transfer.class_id });
    state.steps.confirm.swept_after = swept;
    save();
    log(`payout ${payout.id} landed on its receipt: swept balance ${swept.balance}, pending ${swept.pending}`);
    return;
  }
  const info = await nearView(engine, "get_sol_stream", { position_id: state.steps.register.position_id });
  const stream = await client.getOne({ id: state.steps.setup.metadata });
  state.steps.confirm.engine_withdrawn = info.engine_withdrawn;
  state.steps.confirm.stream_withdrawn = String(stream.withdrawnAmount);
  save();
  log(`payout ${payout.id} landed: engine_withdrawn ${info.engine_withdrawn}, stream withdrawn ${stream.withdrawnAmount}`);
}

async function stepRedeem() {
  // A release already in flight (an earlier run stopped after the NEAR call) is resumed.
  let releaseId = await nearView(engine, "get_pending_release", { position_id: state.steps.register.position_id });
  if (releaseId === null) {
    const { proof, value } = await payoutProof(holder.publicKey, state.steps.claim.solana_tx);
    const streams = await nearView(engine, "get_sol_streams", { class_id: state.steps.transfer.class_id });
    const owed = streams.find((s) => s.position_id === state.steps.register.position_id)?.redeem_claimable;
    state.steps.redeem = { nonce_value: value, to_owner: holder.publicKey.toBase58(), redeem_claimable: owed };
    save();
    const hash = nearCall(nearHolder, "redeem", { position_id: state.steps.register.position_id, to: holder.publicKey.toBase58(), nonce: proof }, "200 Tgas", "0.025 NEAR");
    await record("redeem", hash, nearHolder);
    releaseId = await nearView(engine, "get_pending_release", { position_id: state.steps.register.position_id });
  }
  const payout = await waitPayout(releaseId);
  if (payout.status !== "Signed") throw new Error(`release not signed: ${JSON.stringify(payout.status)}`);
  state.steps.redeem.payout_id = payout.id;
  const position = await nearView(engine, "get_position", { position_id: state.steps.register.position_id });
  if (position.state !== "Releasing") throw new Error(`position not releasing: ${position.state}`);
  await broadcast(payout, "redeem");
  const stream = await client.getOne({ id: state.steps.setup.metadata });
  log("stream recipient now", stream.recipient, stream.recipient === holder.publicKey.toBase58() ? "(the holder)" : "(NOT the holder)");
}

async function stepConfirmRedeem() {
  const nonce = await accountHex(state.steps.claim.nonce_account);
  const receipt = await accountHex(state.steps.claim.receipt_account);
  const hash = nearCall(nearHolder, "confirm_sol_redeem", { position_id: state.steps.register.position_id, anchor_tx: state.steps.redeem.solana_tx, nonce_data: nonce.data, receipt_data: receipt.data }, "100 Tgas", "0 NEAR");
  await record("confirm_redeem", hash, nearHolder);
  const position = await nearView(engine, "get_position", { position_id: state.steps.register.position_id });
  const payout = await nearView(engine, "get_payout", { payout_id: state.steps.redeem.payout_id });
  if (position.state !== "Released" || payout.status !== "Landed") throw new Error(`release not final: ${position.state} ${JSON.stringify(payout.status)}`);
  state.steps.confirm_redeem.position_state = position.state;
  save();
  log(`position ${position.position_id} released to ${holder.publicKey.toBase58()}`);
}

const deposit = { setup: stepSetup, transfer: stepTransfer, attribute: stepAttribute, move: stepMove, register: stepRegister };
const steps = flowCase === "main"
  ? { ...deposit, claim: stepClaim, confirm: stepConfirm, redeem: stepRedeem, "confirm-redeem": stepConfirmRedeem }
  : { ...deposit, "wait-end": stepWaitEnd, sync: stepSync, "claim-swept": stepClaimSwept, confirm: stepConfirm };
if (step === "all") {
  for (const name of Object.keys(steps)) await steps[name]();
} else if (steps[step]) {
  await steps[step]();
} else {
  throw new Error(`unknown step ${step}`);
}
