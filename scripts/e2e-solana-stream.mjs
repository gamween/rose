#!/usr/bin/env node
// End-to-end Streamflow flow on Solana devnet against a deployed engine (spec 7.2 and 7.3):
// a stream of a devnet test SPL token is created to a holder, the holder moves it to its engine
// deposit address (transfer_recipient), the engine attributes it (ForeignTx AccountState proof),
// signs the move to the vault, registers it once it sits at the vault, signs a payout drawing on
// the stream (Streamflow withdraw + TransferChecked in one durable-nonce transaction), which is
// broadcast and then confirmed with a proof that the nonce advanced and the stream paid, and
// finally signs the in-kind release of the position, broadcast and confirmed the same way.
//
//   node scripts/e2e-solana-stream.mjs <engine account> <step> [--holder <near account>]
// Steps, in order: setup, transfer, attribute, move, register, claim, confirm, redeem,
// confirm-redeem (or `all`). Every signature
// and NEAR transaction is recorded in deployments/e2e/<engine>.solana.json. Keys: the ops key
// ~/.config/rose/solana-ops.json funds everything (never printed); the Solana holder key is
// generated into ~/.config/rose/solana-holder.json; NEAR calls use the legacy keychain.
// Dependencies: `pnpm install --ignore-workspace` in scripts/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import BN from "bn.js";
import bs58 from "bs58";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey,
  SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createMint, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { ICluster, SolanaStreamClient } from "@streamflow/stream";

const RPC = "https://api.devnet.solana.com";
const NEAR_RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const MPC = "v1.signer-prod.testnet";
const STREAMFLOW_PROGRAM = "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const nearExplorer = (hash) => `https://testnet.near.rocks/tx/${hash}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const [engine, step, ...rest] = process.argv.slice(2);
if (!engine || !step) {
  console.error("usage: e2e-solana-stream.mjs <engine account> <step|all> [--holder <near account>]");
  process.exit(2);
}
let nearHolder = "b1.rose-ckd-1793753433.testnet";
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] === "--holder") nearHolder = rest[i + 1];
  else throw new Error(`unknown argument ${rest[i]}`);
}

const conn = new Connection(RPC, "confirmed");
const ops = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/rose/solana-ops.json`, "utf8"))));
const holderFile = `${homedir()}/.config/rose/solana-holder.json`;
if (!existsSync(holderFile)) writeFileSync(holderFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const holder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(holderFile, "utf8"))));
const stateFile = join(root, "deployments", "e2e", `${engine}.solana.json`);
mkdirSync(dirname(stateFile), { recursive: true });
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { engine, near_holder: nearHolder, steps: {} };
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
    const st = (await conn.getSignatureStatuses([signature])).value[0];
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
const classArgs = () => ({ mint: state.steps.setup.mint, decimals: 6, schedule: schedule() });

async function stepSetup() {
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
  const mint = state.steps.setup?.mint ? new PublicKey(state.steps.setup.mint) : await createMint(conn, ops, ops.publicKey, null, 6);
  const ata = await getOrCreateAssociatedTokenAccount(conn, ops, mint, ops.publicKey);
  await mintTo(conn, ops, mint, ata.address, ops, 10_000_000_000n);
  const now = Math.floor(Date.now() / 1000);
  // 3,600 tokens unlocking 60 per minute over an hour, starting in a minute: no cliff, no
  // sender permissions, transferable by the recipient, no automatic withdrawal.
  const params = {
    recipient: holder.publicKey.toBase58(), tokenId: mint.toBase58(), start: now + 60, cliff: 0,
    amount: new BN(3_600_000_000), cliffAmount: new BN(0), amountPerPeriod: new BN(60_000_000), period: 60,
    name: "rose staging", cancelableBySender: false, cancelableByRecipient: false, transferableBySender: false,
    transferableByRecipient: true, canTopup: false, automaticWithdrawal: false, canPause: false, canUpdateRate: false,
  };
  const res = await client.create(params, { sender: ops, isNative: false });
  await waitFinalized(res.txId);
  const stream = await client.getOne({ id: res.metadataId });
  state.steps.setup = {
    mint: mint.toBase58(), metadata: res.metadataId, create_tx: res.txId, create_link: explorer(res.txId),
    holder: holder.publicKey.toBase58(),
    schedule: { start_time: Number(stream.start), cliff: Number(stream.cliff), cliff_amount: Number(stream.cliffAmount),
      period: Number(stream.period), amount_per_period: Number(stream.amountPerPeriod),
      net_amount_deposited: Number(stream.depositedAmount), end_time: Number(stream.end) },
  };
  save();
  log("stream", res.metadataId, "created:", explorer(res.txId), JSON.stringify(state.steps.setup.schedule));
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

/** The nonce proof of a payout or redeem to `owner`: the nonce account and `owner`'s token account read at finalized. */
async function payoutProof(owner, anchor) {
  const nonceInfo = await conn.getAccountInfo(new PublicKey(state.steps.claim.nonce_account), "finalized");
  const recipientTokens = getAssociatedTokenAddressSync(new PublicKey(state.steps.setup.mint), owner);
  const tokens = await accountHex(recipientTokens.toBase58());
  return {
    proof: { account: state.steps.claim.nonce_account, anchor_tx: anchor, data: Buffer.from(nonceInfo.data).toString("hex"), recipient_tokens_data: tokens.data },
    value: NonceAccount.fromAccountData(nonceInfo.data).nonce,
  };
}

async function stepClaim() {
  const claimable = await nearView(engine, "get_claimable", { account: nearHolder, class_id: state.steps.transfer.class_id });
  if (claimable === "0") throw new Error("nothing claimable yet: the stream unlocks 60 tokens per minute after its start");
  const streams = await nearView(engine, "get_sol_streams", { class_id: state.steps.transfer.class_id });
  const stream = streams.find((s) => s.position_id === state.steps.register.position_id);
  const amount = BigInt(stream.withdrawable) < BigInt(claimable) ? stream.withdrawable : claimable;
  const nonceKp = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  const create = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: ops.publicKey, newAccountPubkey: nonceKp.publicKey, lamports: rent, space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
    SystemProgram.nonceInitialize({ noncePubkey: nonceKp.publicKey, authorizedPubkey: vault }),
  );
  const createSig = await sendAndConfirmTransaction(conn, create, [ops, nonceKp]);
  await waitFinalized(createSig);
  state.steps.claim = { nonce_account: nonceKp.publicKey.toBase58(), nonce_create_tx: createSig, nonce_create_link: explorer(createSig), amount, to_owner: ops.publicKey.toBase58() };
  const { proof, value } = await payoutProof(ops.publicKey, createSig);
  state.steps.claim.nonce_value = value;
  save();
  const draws = [{ position_id: state.steps.register.position_id, amount }];
  const hash = nearCall(nearHolder, "claim_sol_tokens", { source: { Holding: { class_id: state.steps.transfer.class_id } }, draws, to_owner: ops.publicKey.toBase58(), nonce: proof }, "200 Tgas", "0.025 NEAR");
  await record("claim", hash, nearHolder);
  const total = Number(await nearView(engine, "payouts_total"));
  const payout = await waitPayout(total - 1);
  if (payout.status !== "Signed") throw new Error(`claim not signed: ${JSON.stringify(payout.status)}`);
  state.steps.claim.payout_id = payout.id;
  state.steps.claim.draws = payout.solana.draws;
  const ata = getAssociatedTokenAddressSync(new PublicKey(state.steps.setup.mint), ops.publicKey);
  const before = await conn.getTokenAccountBalance(ata, "confirmed").then((b) => b.value.amount);
  await broadcast(payout, "claim");
  const after = await conn.getTokenAccountBalance(ata, "confirmed").then((b) => b.value.amount);
  state.steps.claim.recipient_balance = { before, after };
  save();
  log(`claimed ${amount}: recipient balance ${before} -> ${after}`);
}

async function stepConfirm() {
  const nonce = await accountHex(state.steps.claim.nonce_account);
  const metadata = await accountHex(state.steps.setup.metadata);
  const hash = nearCall(nearHolder, "confirm_sol_payout", { payout_id: state.steps.claim.payout_id, anchor_tx: state.steps.claim.solana_tx, nonce_data: nonce.data, stream_data: [metadata.data] }, "100 Tgas", "0 NEAR");
  await record("confirm", hash, nearHolder);
  const payout = await nearView(engine, "get_payout", { payout_id: state.steps.claim.payout_id });
  if (payout.status !== "Landed") throw new Error(`payout not landed: ${JSON.stringify(payout.status)}`);
  const info = await nearView(engine, "get_sol_stream", { position_id: state.steps.register.position_id });
  const stream = await client.getOne({ id: state.steps.setup.metadata });
  state.steps.confirm.status = payout.status;
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
  const metadata = await accountHex(state.steps.setup.metadata);
  const hash = nearCall(nearHolder, "confirm_sol_redeem", { position_id: state.steps.register.position_id, anchor_tx: state.steps.redeem.solana_tx, nonce_data: nonce.data, stream_data: metadata.data }, "100 Tgas", "0 NEAR");
  await record("confirm_redeem", hash, nearHolder);
  const position = await nearView(engine, "get_position", { position_id: state.steps.register.position_id });
  const payout = await nearView(engine, "get_payout", { payout_id: state.steps.redeem.payout_id });
  if (position.state !== "Released" || payout.status !== "Landed") throw new Error(`release not final: ${position.state} ${JSON.stringify(payout.status)}`);
  state.steps.confirm_redeem.position_state = position.state;
  save();
  log(`position ${position.position_id} released to ${holder.publicKey.toBase58()}`);
}

const steps = {
  setup: stepSetup, transfer: stepTransfer, attribute: stepAttribute, move: stepMove, register: stepRegister,
  claim: stepClaim, confirm: stepConfirm, redeem: stepRedeem, "confirm-redeem": stepConfirmRedeem,
};
if (step === "all") {
  for (const name of Object.keys(steps)) await steps[name]();
} else if (steps[step]) {
  await steps[step]();
} else {
  throw new Error(`unknown step ${step}`);
}
