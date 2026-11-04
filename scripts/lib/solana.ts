/**
 * Solana devnet: the CINDR SPL mint, Streamflow streams of the Strategic Round and their deposit
 * into the engine in three calls (spec 7.2: attribute, move, register).
 */

import BN from "bn.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { ICluster, SolanaStreamClient } from "@streamflow/stream";
import {
  base64ToBytes,
  buildTransferRecipientTransaction,
  bytesToHex,
  checkStreamflowEligibility,
  decodeStreamflowMetadata,
  type PayoutView,
  type StreamflowScheduleArgs,
} from "@rose/sdk";
import type { Context } from "./context.ts";
import { log, sleep, SOLANA_RPC } from "./env.ts";
import { STRATEGIC_SCHEDULE, TOKEN } from "./identity.ts";
import { txRef, type StepScope } from "./journal.ts";
import { near, nearRef, rpc, withRetry, type NearActor } from "./near.ts";

type StreamflowSender = Parameters<SolanaStreamClient["create"]>[1]["sender"];

export async function waitFinalized(ctx: Context, signature: string): Promise<void> {
  for (let i = 0; i < 90; i += 1) {
    const status = (await ctx.solana.getSignatureStatuses([signature])).value[0];
    if (status?.err !== undefined && status.err !== null) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "finalized") return;
    await sleep(2_000);
  }
  throw new Error(`${signature} not finalized after 3 minutes`);
}

export async function accountHex(ctx: Context, address: PublicKey): Promise<{ data: string; owner: string }> {
  const info = await ctx.solana.getAccountInfo(address, "finalized");
  if (info === null) throw new Error(`account ${address.toBase58()} missing`);
  return { data: bytesToHex(Uint8Array.from(info.data)), owner: info.owner.toBase58() };
}

/** SOL transfers from the ops key; returns the signature. */
export async function fundSol(ctx: Context, scope: StepScope, label: string, transfers: { to: PublicKey; sol: number }[]): Promise<void> {
  if (transfers.length === 0) return;
  const tx = new Transaction();
  for (const t of transfers) tx.add(SystemProgram.transfer({ fromPubkey: ctx.ops.publicKey, toPubkey: t.to, lamports: Math.round(t.sol * LAMPORTS_PER_SOL) }));
  const signature = await sendAndConfirmTransaction(ctx.solana, tx, [ctx.ops], { commitment: "confirmed" });
  scope.tx(txRef(label, "solana", signature));
}

/** The CINDR devnet mint (classic SPL Token, mint authority = the ops key); created once for every engine. */
export async function cindrMint(ctx: Context): Promise<PublicKey> {
  const stored = await ctx.identity.step("solana-mint", async (scope) => {
    const mint = await createMint(ctx.solana, ctx.ops, ctx.ops.publicKey, null, TOKEN.solanaDecimals);
    const signatures = await ctx.solana.getSignaturesForAddress(mint, { limit: 1 });
    const creation = signatures[0]?.signature;
    if (creation !== undefined) scope.tx(txRef("createMint (CINDR, 9 decimals)", "solana", creation));
    return { mint: mint.toBase58(), decimals: TOKEN.solanaDecimals };
  });
  return new PublicKey(stored.mint);
}

/** Creates the Strategic Round stream of `amount` whole tokens to `recipient` and returns its metadata account. */
export async function createStrategicStream(ctx: Context, scope: StepScope, label: string, mint: PublicKey, recipient: PublicKey, amount: number): Promise<string> {
  const unit = 10n ** BigInt(TOKEN.solanaDecimals);
  const total = BigInt(amount) * unit;
  const ata = await getOrCreateAssociatedTokenAccount(ctx.solana, ctx.ops, mint, ctx.ops.publicKey);
  if (ata.amount < total) {
    const signature = await mintTo(ctx.solana, ctx.ops, mint, ata.address, ctx.ops, total - ata.amount);
    scope.tx(txRef(`${label}: mintTo treasury`, "solana", signature));
  }
  const client = new SolanaStreamClient(SOLANA_RPC, ICluster.Devnet, "confirmed");
  const created = await client.create(
    {
      recipient: recipient.toBase58(),
      tokenId: mint.toBase58(),
      start: STRATEGIC_SCHEDULE.start,
      cliff: STRATEGIC_SCHEDULE.start,
      amount: new BN(total.toString()),
      cliffAmount: new BN(((total * STRATEGIC_SCHEDULE.cliffPercent) / 100n).toString()),
      amountPerPeriod: new BN(((total * STRATEGIC_SCHEDULE.perPeriodPercent) / 100n).toString()),
      period: STRATEGIC_SCHEDULE.period,
      name: STRATEGIC_SCHEDULE.name,
      cancelableBySender: false,
      cancelableByRecipient: false,
      transferableBySender: false,
      transferableByRecipient: true,
      canTopup: false,
      automaticWithdrawal: false,
      canPause: false,
      canUpdateRate: false,
    },
    // The Streamflow SDK bundles its own @solana/web3.js copy: same Keypair, distinct declaration.
    { sender: ctx.ops as unknown as StreamflowSender, isNative: false },
  );
  scope.tx(txRef(label, "solana", created.txId));
  await waitFinalized(ctx, created.txId);
  return created.metadataId;
}

async function readStream(ctx: Context, metadata: string): Promise<ReturnType<typeof decodeStreamflowMetadata>> {
  const info = await ctx.solana.getAccountInfo(new PublicKey(metadata), "finalized");
  if (info === null) throw new Error(`stream ${metadata} not found`);
  return decodeStreamflowMetadata(Uint8Array.from(info.data));
}

export function scheduleArgs(m: ReturnType<typeof decodeStreamflowMetadata>): StreamflowScheduleArgs {
  return {
    start_time: Number(m.startTime),
    end_time: Number(m.endTime),
    net_amount_deposited: m.netAmountDeposited.toString(),
    period: Number(m.period),
    amount_per_period: m.amountPerPeriod.toString(),
    cliff: Number(m.cliff),
    cliff_amount: m.cliffAmount.toString(),
  };
}

/** Polls an engine-built transaction until both signatures are stored. */
export async function waitSigned(ctx: Context, payoutId: string): Promise<PayoutView> {
  for (let i = 0; i < 90; i += 1) {
    const payout = await withRetry("get_payout", () => ctx.views.getPayout(payoutId));
    if (payout?.status === "Signed") return payout;
    if (payout !== null && typeof payout.status === "object") throw new Error(`payout ${payoutId} failed: ${payout.status.Failed.reason}`);
    await sleep(2_000);
  }
  throw new Error(`payout ${payoutId} still unsigned after 3 minutes`);
}

/** Broadcasts a stored engine-built transaction (anyone may; `gas/sol` pays the fee). */
export async function broadcastStored(ctx: Context, scope: StepScope, label: string, payout: PayoutView): Promise<string> {
  const prior = scope.sent(label);
  if (prior !== undefined) return prior.hash;
  const wire = payout.solana?.transaction;
  if (wire === undefined || wire === null) throw new Error(`payout ${payout.id} has no transaction`);
  const bytes = base64ToBytes(wire);
  const simulation = await ctx.solana.simulateTransaction(VersionedTransaction.deserialize(bytes), { sigVerify: true });
  if (simulation.value.err !== null) throw new Error(`${label}: simulation failed ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join("\n")}`);
  const signature = await ctx.solana.sendRawTransaction(bytes, { skipPreflight: false });
  scope.tx(txRef(label, "solana", signature, { note: `${simulation.value.unitsConsumed ?? 0} CU` }));
  await waitFinalized(ctx, signature);
  return signature;
}

export interface SolPosition {
  metadata: string;
  classId: string;
  depositAddress: string;
  positionId: string;
  units: string;
}

/**
 * Spec 7.2 for one holder: `transfer_recipient` to its deposit address (signed by the holder),
 * `attribute_sol_deposit` (ForeignTx proof), `move_sol_deposit` (engine-signed, broadcast) and
 * `register_sol_deposit` (proof at the vault, units minted).
 */
export async function depositStrategicStream(ctx: Context, scope: StepScope, who: string, holder: Keypair, actor: NearActor, metadata: string): Promise<SolPosition> {
  const stream = await readStream(ctx, metadata);
  const eligibility = checkStreamflowEligibility(stream);
  if (!eligibility.eligible) throw new Error(`stream ${metadata} is not eligible: ${eligibility.reasons.join(", ")}`);
  const classId = await withRetry("compute_sol_class_id", () => ctx.views.raw.computeSolClassId(stream.mint.toBase58(), TOKEN.solanaDecimals, scheduleArgs(stream)));
  const path = await withRetry("deposit_path_of", () => ctx.views.raw.depositPathOf(actor.accountId, classId));
  const derived = await withRetry("derived_public_key", () =>
    rpc.viewFunction<string>(ctx.config.mpc_account, "derived_public_key", { path, predecessor: ctx.engine, domain_id: ctx.config.sign_ed25519_domain }),
  );
  const depositAddress = new PublicKey(derived.value.replace(/^ed25519:/, ""));

  if (stream.recipient.equals(holder.publicKey)) {
    const latest = await ctx.solana.getLatestBlockhash("finalized");
    const tx = buildTransferRecipientTransaction({ metadataPubkey: new PublicKey(metadata), authority: holder.publicKey, newRecipient: depositAddress, mint: stream.mint, ...latest });
    const signature = await sendAndConfirmTransaction(ctx.solana, tx, [holder], { commitment: "confirmed" });
    scope.tx(txRef(`${who}: transfer_recipient to the deposit address ${depositAddress.toBase58()}`, "solana", signature));
    await waitFinalized(ctx, signature);
  }
  const transferTx = scope.sent(`${who}: transfer_recipient to the deposit address ${depositAddress.toBase58()}`)?.hash;
  if (transferTx === undefined) throw new Error(`${who}: no transfer_recipient recorded for ${metadata}`);

  let record = await withRetry("get_sol_deposit", () => ctx.views.raw.getSolDeposit(metadata));
  if (record === null) {
    const meta = await accountHex(ctx, new PublicKey(metadata));
    const mint = await accountHex(ctx, stream.mint);
    const result = await actor.call(
      ctx.calls.attributeSolDeposit({ metadata, class_id: classId, return_to: holder.publicKey.toBase58(), anchor_tx: transferTx, metadata_data: meta.data, mint_data: mint.data }),
    );
    scope.tx(nearRef(`${who}: attribute_sol_deposit`, result));
    record = await withRetry("get_sol_deposit", () => ctx.views.raw.getSolDeposit(metadata));
  }
  if (record?.stage === "Attributed") {
    const { blockhash } = await ctx.solana.getLatestBlockhash("finalized");
    const result = await actor.call(ctx.calls.moveSolDeposit(metadata, blockhash));
    scope.tx(nearRef(`${who}: move_sol_deposit`, result));
    record = await withRetry("get_sol_deposit", () => ctx.views.raw.getSolDeposit(metadata));
  }
  if (record !== null && typeof record.stage === "object" && "MoveSigned" in record.stage) {
    const moved = await readStream(ctx, metadata);
    if (!moved.recipient.equals(ctx.derived.vaultSol)) {
      const payout = await waitSigned(ctx, record.stage.MoveSigned.payout_id);
      await broadcastStored(ctx, scope, `${who}: move to the vault (engine-signed, broadcast)`, payout);
    }
    const anchor = scope.sent(`${who}: move to the vault (engine-signed, broadcast)`)?.hash;
    if (anchor === undefined) throw new Error(`${who}: the move of ${metadata} was broadcast by an earlier run that recorded no signature`);
    const meta = await accountHex(ctx, new PublicKey(metadata));
    const deposit = BigInt(await withRetry("registration_deposit_for", () => ctx.views.raw.registrationDepositFor(actor.accountId, classId)));
    const result = await actor.call(ctx.calls.registerSolDeposit(metadata, anchor, meta.data, deposit + near("0.001")));
    scope.tx(nearRef(`${who}: register_sol_deposit`, result));
    record = await withRetry("get_sol_deposit", () => ctx.views.raw.getSolDeposit(metadata));
  }
  if (record === null || typeof record.stage !== "object" || !("Registered" in record.stage)) throw new Error(`${who}: stream ${metadata} not registered: ${JSON.stringify(record)}`);
  const positionId = record.stage.Registered.position_id;
  const units = (await withRetry("mt_balance_of", () => ctx.views.mtBalanceOf(actor.accountId, classId))).toString();
  log(`  ${who}: position ${positionId}, ${units} units of ${classId}`);
  return { metadata, classId, depositAddress: depositAddress.toBase58(), positionId, units };
}
