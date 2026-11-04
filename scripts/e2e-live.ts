/**
 * Live end-to-end proofs on the seeded rounds (spec 13), against any engine:
 *
 *   node scripts/e2e-live.ts [step|all] [--env deployments/<engine>.env]
 *
 * Steps, in order (`all` runs them all; each is recorded once and resumes where it stopped):
 *   cancel-no-key  an Exit round with a 60 s key timeout that nobody closes: `close` is refused
 *                  after the timeout, `cancel_no_key` cancels it and `settle_bid` refunds the bid
 *   close          `close` of the Tender, the Exit and the Advance once their window ended: the real
 *                  MPC releases each round key (CKD), checked against an offline unwrap
 *   open           every sealed order decrypted with the released key and opened on chain by a
 *                  third party; the malformed bid fails to decrypt and its author's own opening is
 *                  refused on chain
 *   clear          `clear` of each round, compared with the `@rose/sdk` clearing reference on the
 *                  opened bids (the run exits non-zero on any mismatch)
 *   settle         `settle_bid` of every order (units, cash, refunds, bonds; the malformed bid's
 *                  bond is slashed)
 *   payouts        NEAR tUSDC withdrawal (`withdraw_near_cash`), Base tUSDC withdrawal
 *                  (`withdraw_base_cash` + `executeTransfer`), Advance repayment from unlocks (lien
 *                  share claim + `executeTransfer` of CINDR), in-kind redeem (`redeem` + `executeRelease`)
 *   report         the markdown table of every transaction for docs/verification.md
 *
 * Record: `deployments/e2e/<engine>.live.json`. Prerequisite: `node scripts/seed.ts` on the same engine.
 */

import type { Address, Hex } from "viem";
import {
  executeRelease,
  executeTransfer,
  isAuthorizationUsed,
  SABLIER_LOCKUP_V4,
  roseEvents,
  sablierLockupAbi,
  tokenBalance,
  withdrawMax,
  calculateMinFeeWei,
  type PayoutView,
  type Side,
} from "@rose/sdk";
import { sendBase } from "./lib/base.ts";
import { createContext, type Context } from "./lib/context.ts";
import { DEFAULT_ENV_FILE, log, NEAR_CASH_TOKEN, parseArgs } from "./lib/env.ts";
import { accountOf, CAST, usdc, whole, type Who } from "./lib/identity.ts";
import type { StepScope } from "./lib/journal.ts";
import { nearRef, rpc, withRetry, type NearActor, type NearResult } from "./lib/near.ts";
import { checkClearing, classDecimals, createRound, getRound, placeOrder, usdcText, waitUntil, type ClearingCheck, type OrderRecord, type OrderSecret, type RoundRecord } from "./lib/rounds.ts";
import { open, unwrap } from "./lib/sealed.ts";
import { waitSigned } from "./lib/solana.ts";

const USAGE = "usage: node scripts/e2e-live.ts [cancel-no-key|close|open|clear|settle|payouts|report|all] [--env deployments/<engine>.env]";
const args = parseArgs(process.argv.slice(2), USAGE);
const ctx: Context = await createContext(args.flags.get("env") ?? DEFAULT_ENV_FILE);
log(`engine ${ctx.engine}`);

const MAIN_ROUNDS = ["tender", "exit", "advance"] as const;
type MainRound = (typeof MAIN_ROUNDS)[number];

function seededRound(key: MainRound): RoundRecord {
  return ctx.seed.get<RoundRecord>(`round:${key}`);
}

function whoIs(account: string): Who {
  const who = (Object.keys(CAST) as Who[]).find((w) => accountOf(w) === account);
  if (who === undefined) throw new Error(`${account} is not in the cast`);
  return who;
}

function events(result: NearResult): ReturnType<typeof roseEvents> {
  return roseEvents(result.logs);
}

async function nearCash(account: string): Promise<bigint> {
  const cash = await withRetry("get_cash", () => ctx.views.getCash(account));
  return cash.find((c) => c.venue === "Near")?.amount ?? 0n;
}

async function stepCancelNoKey(): Promise<void> {
  const holder = ctx.actor("halden");
  const kolClass = ctx.seed.get<{ classes: Record<string, string> }>("base-register").classes["kol-base"];
  if (kolClass === undefined) throw new Error("no kol-base class in the seed record");
  const round = await ctx.live.step<RoundRecord>("nokey:create", (scope) => {
    const now = BigInt(Date.now()) * 1_000_000n;
    return createRound(ctx, scope, "Halden Ventures: create_exit with a 60 s key timeout (KOL Round)", holder, "Exit", kolClass,
      ctx.calls.createExit({ classId: kolClass, venue: "Near", maxPrice: usdc(0.05), window: { closesAt: now + 90_000_000_000n, keyTimeout: 60_000_000_000n, revealWindow: 300_000_000_000n } }),
    );
  });
  const before = await ctx.live.step("nokey:cash-before", async () => ({ cash: (await nearCash(holder.accountId)).toString() }));
  await ctx.live.step<OrderRecord>("nokey:bid", (scope) => placeOrder(ctx, scope, round, "halden", holder, "Buy", { quantity: whole(100, 18), price: usdc(0.01), collateral: usdc(10) }));
  const full = await getRound(ctx, round.roundId);
  await waitUntil(full.closesAt + full.keyTimeout, "closes_at + key_timeout");
  await ctx.live.step("nokey:close-refused", async (scope) => {
    const result = await ctx.funder.call(ctx.calls.close(BigInt(round.roundId)), { allowFailure: true });
    scope.tx(nearRef("close after the key timeout (refused)", result));
    if (result.failure?.includes("Key timeout reached") !== true) throw new Error(`close was not refused: ${result.failure ?? "succeeded"}`);
    return { refused: result.failure };
  });
  await ctx.live.step("nokey:cancel", async (scope) => {
    const result = await ctx.funder.call(ctx.calls.cancelNoKey(BigInt(round.roundId)));
    scope.tx(nearRef("cancel_no_key", result));
    const after = await getRound(ctx, round.roundId);
    if (after.status !== "Cancelled" || after.cancelReason !== "NoKey") throw new Error(`round ${round.roundId} is ${after.status} (${after.cancelReason ?? "no reason"})`);
    return { status: after.status, reason: after.cancelReason, key: after.key };
  });
  await ctx.live.step("nokey:settle", async (scope) => {
    const result = await ctx.funder.call(ctx.calls.settleBid(BigInt(round.roundId), 0));
    scope.tx(nearRef("settle_bid (refund of escrow and bond)", result));
    const settled = events(result).find((e) => e.event === "bid_settled");
    const after = await nearCash(holder.accountId);
    if (after.toString() !== before.cash) throw new Error(`Halden's NEAR cash ${after} differs from ${before.cash} before the bid`);
    return { cash_before: before.cash, cash_after: after.toString(), settled: settled?.data };
  });
}

/** The CKD response `(big_y, big_c)` the MPC returned inside the close transaction. */
function ckdResponse(result: NearResult): { big_y: string; big_c: string } | null {
  for (const receipt of result.outcome.receipts_outcome) {
    const status = receipt.outcome.status;
    if (receipt.outcome.executor_id !== ctx.config.mpc_account || typeof status !== "object" || !("SuccessValue" in status) || status.SuccessValue === "") continue;
    const value = JSON.parse(Buffer.from(status.SuccessValue, "base64").toString()) as unknown;
    if (typeof value === "object" && value !== null && "big_y" in value && "big_c" in value) return value as { big_y: string; big_c: string };
  }
  return null;
}

async function stepClose(): Promise<void> {
  for (const key of MAIN_ROUNDS) {
    const record = seededRound(key);
    await ctx.live.step(`close:${key}`, async (scope) => {
      await waitUntil(BigInt(record.closesAt), `the ${key} round to close`);
      let round = await getRound(ctx, record.roundId);
      let response: { big_y: string; big_c: string } | null = null;
      for (let attempt = 0; round.key === null && attempt < 3; attempt += 1) {
        const result = await ctx.funder.call(ctx.calls.close(BigInt(record.roundId)));
        scope.tx(nearRef(attempt === 0 ? `close (${key}): CKD key request` : `close (${key}): retry ${attempt}`, result));
        response = ckdResponse(result);
        round = await getRound(ctx, record.roundId);
      }
      if (round.key === null || round.keyReceivedAt === null || round.closeRequestedAt === null) throw new Error(`no key for round ${record.roundId}`);
      const offline = response === null ? null : unwrap(ctx.engine, BigInt(record.roundId), response.big_y, response.big_c);
      if (offline !== null && offline !== round.key) throw new Error(`the offline unwrap ${offline} differs from the stored key ${round.key}`);
      return {
        round_id: record.roundId,
        key: round.key,
        key_source: round.keySource,
        ckd_response: response,
        unwrapped_offline_equal: offline !== null,
        latency_ms: Number((round.keyReceivedAt - round.closeRequestedAt) / 1_000_000n),
        reveal_ends_at: new Date(Number((round.revealEndsAt ?? 0n) / 1_000_000n)).toISOString(),
      };
    });
  }
}

interface Opening {
  bidId: number;
  who: Who;
  side: Side;
  opened: { quantity: string; price: string } | null;
  matchesSealed: boolean | null;
  unopenable?: string;
}

/** Decrypts a sealed order, or returns why it cannot be decrypted. */
function tryOpen(identity: Parameters<typeof open>[0], key: string, ciphertextHex: string): ReturnType<typeof open> | string {
  try {
    return open(identity, key, ciphertextHex);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function stepOpen(): Promise<void> {
  for (const key of MAIN_ROUNDS) {
    const record = seededRound(key);
    await ctx.live.step<Opening[]>(`open:${key}`, async (scope) => {
      const round = await getRound(ctx, record.roundId);
      if (round.key === null) throw new Error(`round ${record.roundId} has no key yet`);
      const bids = await withRetry("get_bids", () => ctx.views.getBids(record.roundId));
      const out: Opening[] = [];
      for (const bid of bids) {
        const who = whoIs(bid.bidder);
        const identity = { mpk: ctx.config.ckd_public_key, engine: ctx.engine, roundId: BigInt(record.roundId), bidder: bid.bidder, side: bid.side };
        const secret = ctx.secrets.find<OrderSecret>(`order:${record.roundId}:${bid.bidder}:${bid.side}`);
        if (bid.ciphertextHex === null) throw new Error(`bid ${bid.bidId} has no ciphertext`);
        const opening = tryOpen(identity, round.key, bid.ciphertextHex);
        if (typeof opening === "string") {
          log(`  bid ${bid.bidId} (${CAST[who].name}) cannot be decrypted: ${opening}`);
          if (secret?.originalCiphertextHex === undefined) throw new Error(`bid ${bid.bidId} is unopenable but was not sealed malformed on purpose`);
          const own = open(identity, round.key, secret.originalCiphertextHex);
          const attempt = await ctx.actor(who).call(ctx.calls.openBid(BigInt(record.roundId), bid.bidId, own.plaintextHex, own.sigma), { allowFailure: true });
          scope.tx(nearRef(`${CAST[who].name}: open_bid of the malformed bid with the author's own opening (refused)`, attempt));
          if (attempt.failure === null) throw new Error("the malformed bid was opened");
          out.push({ bidId: bid.bidId, who, side: bid.side, opened: null, matchesSealed: null, unopenable: `${opening}; on chain: ${attempt.failure}` });
          continue;
        }
        if (bid.opened === null) {
          const result = await ctx.funder.call(ctx.calls.openBid(BigInt(record.roundId), bid.bidId, opening.plaintextHex, opening.sigma));
          scope.tx(nearRef(`open_bid ${bid.bidId} (${CAST[who].name}, ${bid.side === "Buy" ? "bid" : "ask"}) by ${ctx.funder.accountId}`, result));
        }
        const matches = secret === undefined ? null : secret.quantity === opening.quantity.toString() && secret.price === opening.limitPrice.toString();
        if (matches === false) throw new Error(`bid ${bid.bidId} opened to values different from what was sealed`);
        out.push({ bidId: bid.bidId, who, side: bid.side, opened: { quantity: opening.quantity.toString(), price: opening.limitPrice.toString() }, matchesSealed: matches });
      }
      return out;
    });
  }
}

let mismatch = false;

async function stepClear(): Promise<void> {
  for (const key of MAIN_ROUNDS) {
    const record = seededRound(key);
    const check = await ctx.live.step<ClearingCheck & { status: string; voids: Record<string, string> }>(`clear:${key}`, async (scope) => {
      let round = await getRound(ctx, record.roundId);
      if (round.revealEndsAt === null) throw new Error(`round ${record.roundId} is not revealing`);
      await waitUntil(round.revealEndsAt, `the ${key} reveal window`);
      if (round.status !== "Settled" && round.status !== "Cancelled") {
        const result = await ctx.funder.call(ctx.calls.clear(BigInt(record.roundId)));
        scope.tx(nearRef(`clear (${key})`, result));
        round = await getRound(ctx, record.roundId);
      }
      const verdict = checkClearing(round, await classDecimals(ctx, record.classId));
      const voids: Record<string, string> = {};
      for (const fill of round.result?.fills ?? []) if (fill.void !== null) voids[String(fill.bidId)] = fill.void;
      return { ...verdict, status: round.status, voids };
    });
    const price = check.engine.price;
    log(`  ${key}: ${check.status}, price ${usdcText(BigInt(price))} tUSDC, volume ${check.engine.volume}, reference ${check.matches ? "matches" : "DIFFERS"}`);
    if (!check.matches) mismatch = true;
  }
  if (mismatch) throw new Error("the on-chain clearing differs from the @rose/sdk reference");
}

async function stepSettle(): Promise<void> {
  for (const key of MAIN_ROUNDS) {
    const record = seededRound(key);
    await ctx.live.step(`settle:${key}`, async (scope) => {
      const round = await getRound(ctx, record.roundId);
      const fills = round.result?.fills ?? [];
      const out = [];
      for (const fill of fills) {
        if (!fill.settled) {
          const result = await ctx.funder.call(ctx.calls.settleBid(BigInt(record.roundId), fill.bidId));
          scope.tx(nearRef(`settle_bid ${fill.bidId} (${key}, ${CAST[whoIs(fill.bidder)].name})`, result));
        }
        out.push({ bid_id: fill.bidId, bidder: fill.bidder, side: fill.side, fill: fill.fillQuantity.toString(), cash: fill.cash.toString(), fee: fill.fee.toString(), bond: fill.bond.toString(), bond_refunded: fill.void === null, void: fill.void });
      }
      const slashed = out.filter((o) => !o.bond_refunded);
      if (key === "exit" && slashed.length !== 1) throw new Error(`expected exactly the malformed bid to be slashed, got ${slashed.length}`);
      return { round_id: record.roundId, lien_id: round.lienId?.toString() ?? null, bids: out };
    });
  }
}

/** The payout id of a payout request, from its `payout_requested` event. */
function payoutId(result: NearResult): string {
  const requested = events(result).find((e) => e.event === "payout_requested");
  if (requested?.event !== "payout_requested") throw new Error(`no payout_requested event in ${result.hash}`);
  return requested.data.payout_id;
}

function signature(payout: PayoutView): { v: number; r: Hex; s: Hex } {
  if (payout.base === null || payout.base === undefined) throw new Error(`payout ${payout.id} has no Base signature`);
  return { v: payout.base.v, r: `0x${payout.base.r.replace(/^0x/, "")}`, s: `0x${payout.base.s.replace(/^0x/, "")}` };
}

async function executeBaseTransfer(scope: StepScope, label: string, payout: PayoutView): Promise<void> {
  if (!("BaseTransfer" in payout.kind)) throw new Error(`payout ${payout.id} is not a Base transfer`);
  const k = payout.kind.BaseTransfer;
  if (await isAuthorizationUsed(ctx.base, ctx.deployment.roseVault, BigInt(payout.id))) return;
  await sendBase(ctx, scope, label, () =>
    executeTransfer(ctx.deployer, { vault: ctx.deployment.roseVault, authorization: { token: k.token as Address, to: k.to as Address, amount: BigInt(k.amount), id: BigInt(payout.id) }, ...signature(payout) }),
  );
}

async function requestPayout(scope: StepScope, label: string, actor: NearActor, call: Parameters<NearActor["call"]>[0]): Promise<PayoutView> {
  const result = await actor.call(call);
  scope.tx(nearRef(label, result));
  return waitSigned(ctx, payoutId(result));
}

async function stepPayouts(): Promise<void> {
  await ctx.live.step("payout:near-cash", async (scope) => {
    const actor = ctx.actor("ines");
    const amount = await nearCash(actor.accountId);
    const before = await withRetry("ft_balance_of", () => rpc.viewFunction<string>(NEAR_CASH_TOKEN, "ft_balance_of", { account_id: actor.accountId }));
    const result = await actor.call(ctx.calls.withdrawNearCash(amount));
    scope.tx(nearRef(`Ines Marlow: withdraw_near_cash ${usdcText(amount)} tUSDC (Exit proceeds and refunded bonds)`, result));
    const after = await withRetry("ft_balance_of", () => rpc.viewFunction<string>(NEAR_CASH_TOKEN, "ft_balance_of", { account_id: actor.accountId }));
    if (BigInt(after.value) - BigInt(before.value) !== amount) throw new Error(`tUSDC balance moved by ${BigInt(after.value) - BigInt(before.value)}, expected ${amount}`);
    return { amount: amount.toString(), wallet_before: before.value, wallet_after: after.value };
  });

  await ctx.live.step("payout:base-cash", async (scope) => {
    const actor = ctx.actor("halden");
    const token = ctx.deployment.baseTusdc;
    const cash = await withRetry("get_cash", () => ctx.views.getCash(actor.accountId));
    const amount = cash.find((c) => c.venue !== "Near" && c.venue.Base.token === token)?.amount ?? 0n;
    if (amount === 0n) throw new Error("Halden Ventures has no Base tUSDC cash to withdraw");
    const to = ctx.keys.evm("halden").address;
    const before = await tokenBalance(ctx.base, token, to);
    const payout = await requestPayout(scope, `Halden Ventures: withdraw_base_cash ${usdcText(amount)} tUSDC (Tender proceeds)`, actor, ctx.calls.withdrawBaseCash(token, amount, to.toLowerCase()));
    await executeBaseTransfer(scope, "executeTransfer of tUSDC to Halden Ventures", payout);
    const after = await tokenBalance(ctx.base, token, to);
    if (after - before !== amount) throw new Error(`Halden's tUSDC moved by ${after - before}, expected ${amount}`);
    return { amount: amount.toString(), payout_id: payout.id, to, balance_before: before.toString(), balance_after: after.toString() };
  });

  await ctx.live.step("payout:lien", async (scope) => {
    const settle = ctx.live.get<{ lien_id: string | null }>("settle:advance");
    if (settle.lien_id === null) throw new Error("the Advance created no lien");
    const teodorStream = ctx.seed.get<{ positions: { who: Who; streamId: string; selfDeposit: boolean }[] }>("base-register").positions.find((p) => p.who === "teodor");
    if (teodorStream === undefined) throw new Error("no Teodor Vance stream in the seed record");
    const streamId = BigInt(teodorStream.streamId);
    const withdrawable = await ctx.base.readContract({ address: SABLIER_LOCKUP_V4, abi: sablierLockupAbi, functionName: "withdrawableAmountOf", args: [streamId] });
    if (withdrawable > 0n) {
      const fee = await calculateMinFeeWei(ctx.base, streamId);
      await sendBase(ctx, scope, `Sablier withdrawMax(stream ${streamId}, RoseVault): unlocked CINDR into the vault`, () => withdrawMax(ctx.deployer, streamId, ctx.deployment.roseVault, { value: fee }));
    }
    const funder = ctx.actor("varick");
    const lien = await withRetry("get_lien", () => ctx.views.getLien(settle.lien_id ?? ""));
    const { shares } = await withRetry("get_liens", () => ctx.views.getLiens(funder.accountId));
    const share = shares.find((s) => s.lienId.toString() === settle.lien_id);
    if (share === undefined || share.claimable === 0n) throw new Error(`Varick Partners has nothing claimable on lien ${settle.lien_id}`);
    const to = ctx.keys.evm("varick").address;
    const before = await tokenBalance(ctx.base, ctx.deployment.demoToken, to);
    const payout = await requestPayout(scope, `Varick Partners: claim_base_tokens (lien share ${settle.lien_id}, ${share.claimable} CINDR base units)`, funder,
      ctx.calls.claimBaseTokens({ LienShare: { lien_id: settle.lien_id } }, share.claimable, to.toLowerCase()));
    await executeBaseTransfer(scope, "executeTransfer of CINDR to Varick Partners (Advance repayment)", payout);
    const after = await tokenBalance(ctx.base, ctx.deployment.demoToken, to);
    if (after - before !== share.claimable) throw new Error(`Varick's CINDR moved by ${after - before}, expected ${share.claimable}`);
    return { lien_id: settle.lien_id, claim_total: lien?.claimTotal.toString(), delivered: lien?.delivered.toString(), share_claim: share.claim.toString(), claimed: share.claimable.toString(), payout_id: payout.id, to };
  });

  await ctx.live.step("payout:redeem", async (scope) => {
    const position = ctx.seed.get<{ positions: { who: Who; streamId: string; positionId: string; selfDeposit: boolean }[] }>("base-register").positions.find((p) => p.who === "nadia" && p.selfDeposit);
    if (position === undefined) throw new Error("no self-deposited position of Nadia Solvik in the seed record");
    const actor = ctx.actor("nadia");
    const to = ctx.keys.evm("nadia").address;
    const pending = await withRetry("get_pending_release", () => ctx.views.raw.getPendingRelease(position.positionId));
    const payout =
      pending === null
        ? await requestPayout(scope, `Nadia Solvik: redeem position ${position.positionId} (stream ${position.streamId}) in kind`, actor, ctx.calls.redeem(BigInt(position.positionId), to.toLowerCase()))
        : await waitSigned(ctx, pending);
    if (!("BaseRelease" in payout.kind)) throw new Error(`payout ${payout.id} is not a release`);
    const k = payout.kind.BaseRelease;
    if (!(await isAuthorizationUsed(ctx.base, ctx.deployment.roseVault, BigInt(payout.id)))) {
      await sendBase(ctx, scope, `executeRelease of stream ${k.stream_id} to Nadia Solvik`, () =>
        executeRelease(ctx.deployer, { vault: ctx.deployment.roseVault, authorization: { lockup: k.lockup as Address, streamId: BigInt(k.stream_id), to: k.to as Address, vestedToRecipient: k.vested_to_recipient, id: BigInt(payout.id) }, ...signature(payout) }),
      );
    }
    const owner = await ctx.base.readContract({ address: k.lockup as Address, abi: sablierLockupAbi, functionName: "ownerOf", args: [BigInt(k.stream_id)] });
    if (owner.toLowerCase() !== to.toLowerCase()) throw new Error(`stream ${k.stream_id} is owned by ${owner}, expected ${to}`);
    const state = await withRetry("get_position", () => ctx.views.getPosition(position.positionId));
    return { position_id: position.positionId, stream_id: k.stream_id, payout_id: payout.id, owner, position_state: state?.state };
  });
}

function stepReport(): Promise<void> {
  const rows = [...ctx.identity.transactions(), ...ctx.seed.transactions(), ...ctx.live.transactions()].map(({ step, tx }) => {
    const short = `${tx.hash.slice(0, 10)}…`;
    const gas = tx.gasTgas === undefined ? (tx.gasUsed === undefined ? "" : `${tx.gasUsed} gas`) : `${tx.gasTgas} Tgas`;
    return `| ${step} | ${tx.label}${tx.failed === true ? ` (refused: ${tx.note ?? ""})` : ""} | [${short}](${tx.link}) | ${gas} |`;
  });
  process.stdout.write(["| Step | Action | Transaction | Gas |", "|---|---|---|---|", ...rows].join("\n") + "\n");
  return Promise.resolve();
}

const steps: Record<string, () => Promise<void>> = {
  "cancel-no-key": stepCancelNoKey,
  close: stepClose,
  open: stepOpen,
  clear: stepClear,
  settle: stepSettle,
  payouts: stepPayouts,
  report: stepReport,
};

try {
  if (args.step === "all") {
    for (const [name, run] of Object.entries(steps)) if (name !== "report") await run();
  } else {
    const run = steps[args.step];
    if (run === undefined) throw new Error(USAGE);
    await run();
  }
} catch (error) {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
