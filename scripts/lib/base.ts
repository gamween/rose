/**
 * Base Sepolia helpers: transactions recorded in the journal before their receipt is awaited (a
 * resumed step waits for the same hash instead of sending again), and the engine registration of
 * RoseVault logs once Base's `safe` head has passed them (spec 7.1 step 3).
 */

import type { Hex, TransactionReceipt } from "viem";
import { waitForSafeHead, type RegisterBaseCashArgs, type RegisterBaseDepositArgs } from "@rose/sdk";
import type { Context } from "./context.ts";
import { log, sleep } from "./env.ts";
import { txRef, type StepScope } from "./journal.ts";
import { nearRef, withRetry, type NearActor } from "./near.ts";

/** Sends once per step and label, waits for the receipt and requires success. */
export async function sendBase(ctx: Context, scope: StepScope, label: string, send: () => Promise<Hex>): Promise<TransactionReceipt> {
  const hash = (scope.sent(label)?.hash as Hex | undefined) ?? (await send());
  scope.tx(txRef(label, "base", hash));
  const receipt = await ctx.base.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  scope.tx(txRef(label, "base", hash, { gasUsed: receipt.gasUsed.toString() }));
  return receipt;
}

export async function waitSafe(ctx: Context, blockNumber: number): Promise<void> {
  log(`  waiting for the Base safe head to pass block ${blockNumber} (about 3 to 4 minutes) plus 30 s of margin`);
  await waitForSafeHead(ctx.base, BigInt(blockNumber), {
    onProgress: (p) => {
      if (p.phase === "waiting_safe") log(`    safe head ${p.safeHead}`);
    },
  });
}

function replayKey(txHash: string, logIndex: number): { BaseLog: { tx_hash: string; log_index: number } } {
  return { BaseLog: { tx_hash: txHash.replace(/^0x/, "").toLowerCase(), log_index: logIndex } };
}

async function alreadyRegistered(ctx: Context, txHash: string, logIndex: number): Promise<boolean> {
  return (await withRetry("get_replay", () => ctx.views.raw.getReplay(replayKey(txHash, logIndex)))) === "Consumed";
}

/** Polls the replay key until the attestation resolved: true when consumed (registered). */
async function replayConsumed(ctx: Context, txHash: string, logIndex: number): Promise<boolean> {
  const key = replayKey(txHash, logIndex);
  for (let i = 0; i < 60; i += 1) {
    const state = await withRetry("get_replay", () => ctx.views.raw.getReplay(key));
    if (state === "Consumed") return true;
    if (state === null) return false;
    await sleep(5_000);
  }
  throw new Error(`registration of ${txHash}:${logIndex} still pending after 5 minutes`);
}

/** `register_base_deposit` of one `StreamDeposited` log, paid by `payer`; returns the class id. */
export async function registerStream(ctx: Context, scope: StepScope, payer: NearActor, args: RegisterBaseDepositArgs, label: string): Promise<string> {
  const f = args.fields;
  const classId = await withRetry("compute_base_class_id", () =>
    ctx.views.raw.computeBaseClassId(f.token, f.decimals, {
      start: f.start,
      cliff: f.cliff,
      end: f.end,
      granularity: f.granularity,
      deposited: f.deposited,
      start_unlock: f.start_unlock,
      cliff_unlock: f.cliff_unlock,
    }),
  );
  if (await alreadyRegistered(ctx, args.location.tx_hash, args.location.log_index)) return classId;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const deposit = BigInt(await withRetry("registration_deposit_for", () => ctx.views.raw.registrationDepositFor(f.near_account, classId)));
    const result = await payer.call(ctx.calls.registerBaseDeposit(args.location, f, deposit));
    scope.tx(nearRef(attempt === 0 ? label : `${label} (retry ${attempt})`, result));
    if (await replayConsumed(ctx, args.location.tx_hash, args.location.log_index)) return classId;
    log(`  ${label}: the attestation did not register (MPC timeout or a lagging provider), retrying`);
  }
  throw new Error(`${label}: the deposit did not register after three attempts`);
}

/** `register_base_cash` of one `CashDeposited` log. */
export async function registerCash(ctx: Context, scope: StepScope, payer: NearActor, args: RegisterBaseCashArgs, label: string): Promise<void> {
  if (await alreadyRegistered(ctx, args.location.tx_hash, args.location.log_index)) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await payer.call(ctx.calls.registerBaseCash(args.location, args.fields));
    scope.tx(nearRef(attempt === 0 ? label : `${label} (retry ${attempt})`, result));
    if (await replayConsumed(ctx, args.location.tx_hash, args.location.log_index)) return;
    log(`  ${label}: the attestation did not register, retrying`);
  }
  throw new Error(`${label}: the cash deposit did not register after three attempts`);
}
