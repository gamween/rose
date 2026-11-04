/**
 * Demo seed (spec section 9) against any engine: the fictional Cindral Foundation and its token
 * Cindral (CINDR), three cohorts held through rose by six holders, and one Tender, one Exit round
 * and one Advance opened with real sealed orders.
 *
 *   node scripts/seed.ts [step|all] [--env deployments/<engine>.env] [--window-minutes 12] [--reveal-minutes 5]
 *                        [--kol-wallet nadia]
 *
 * Steps, in order (`all` runs them all; each is recorded and never repeated):
 *   fund      NEAR sub-accounts of rose-app.testnet for the cast (created once, topped up per run),
 *             ETH for the KOL holder's wallet, devnet SOL for the Strategic Round holders and gas/sol
 *   base      Seed Round and KOL Round streams created in custody (`RoseVault.createStreams`), the
 *             KOL holder's own DemoStreamFaucet stream deposited with `depositStream`, and the
 *             Tender cash deposited on Base (`depositCash`)
 *   solana    the CINDR devnet mint, the Strategic Round Streamflow streams and their deposit
 *             (`transfer_recipient`, `attribute_sol_deposit`, `move_sol_deposit`, `register_sol_deposit`)
 *   register  `register_base_deposit` / `register_base_cash` of every RoseVault log after the safe head
 *   cash      tUSDC minted on NEAR and deposited as engine cash for bonds and escrows
 *   rounds    the three rounds and their sealed orders (encrypted to the live CKD key)
 *   summary   classes, positions and rounds, and the demo mint in the deployment files
 *
 * `--kol-wallet` names the EVM key of `~/.config/rose/seed-accounts.json` that mints Nadia Solvik's
 * own KOL stream from the DemoStreamFaucet and self-deposits it (default `nadia`, generated on first
 * use). The faucet allows one mint per address and class every 24 hours, so a seed of another
 * engine within a day of the last one names a fresh key; the redeem still returns the stream to
 * Nadia Solvik's own address.
 *
 * Records: `deployments/e2e/cindral.json` (the engine-independent cast and mint),
 * `deployments/e2e/<engine>.seed.json` (every transaction with its explorer link). Keys:
 * `~/.config/rose/seed-accounts.json` (generated, mode 600); sealed orders until they are opened:
 * `~/.config/rose/seed-orders/<engine>.json` (mode 600).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther, type Address } from "viem";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  approveStream,
  approveToken,
  cohortTotal,
  createStreams,
  decodeCashDeposited,
  decodePositionMinted,
  decodeStreamDeposited,
  DemoClass,
  demoStreamFaucetAbi,
  demoTokenAbi,
  depositCash,
  CASH_ROW_STORAGE_DEPOSIT,
  depositNearCashCall,
  depositStream,
  lastMintAt,
  mintDemoPosition,
  mintTestUsdc,
  mintableAmount,
  mintTestUsdcCall,
  perClaimedToken,
  registerBaseCashArgs,
  registerBaseDepositArgs,
  roseVaultAbi,
  storageDepositCall,
  tokenBalance,
  type CohortSchedule,
  type RegisterBaseCashArgs,
  type RegisterBaseDepositArgs,
} from "@rose/sdk";
import { registerCash, registerStream, sendBase, waitSafe } from "./lib/base.ts";
import { createContext, type Context } from "./lib/context.ts";
import { DEFAULT_ENV_FILE, log, NEAR_CASH_TOKEN, numberFlag, parseArgs, ROOT, sleep } from "./lib/env.ts";
import { accountOf, CAST, COHORTS, EVERYONE, GAS_SOL_FUNDED, NADIA_ETH, ROUNDS, STRATEGIC_HOLDER_SOL, usdc, whole, type CohortKey, type Who } from "./lib/identity.ts";
import { txRef } from "./lib/journal.ts";
import { accountBalance, formatNear, near, nearRef, rpc, withRetry } from "./lib/near.ts";
import { createRound, escrowFor, placeOrder, pricingOf, getRound, type OrderRecord, type RoundRecord } from "./lib/rounds.ts";
import { cindrMint, createStrategicStream, depositStrategicStream, fundSol, type SolPosition } from "./lib/solana.ts";

const USAGE =
  "usage: node scripts/seed.ts [fund|base|solana|register|cash|rounds|summary|all] [--env deployments/<engine>.env] [--window-minutes 12] [--reveal-minutes 5] [--kol-wallet nadia]";
const args = parseArgs(process.argv.slice(2), USAGE);
const ctx: Context = await createContext(args.flags.get("env") ?? DEFAULT_ENV_FILE);
const windowMinutes = numberFlag(args, "window-minutes", 12);
const revealMinutes = numberFlag(args, "reveal-minutes", 5);
const kolWallet = args.flags.get("kol-wallet") ?? "nadia";
if (!/^[a-z0-9-]{1,32}$/.test(kolWallet)) throw new Error(`--kol-wallet must be a key name of lowercase letters, digits and dashes\n${USAGE}`);
log(`engine ${ctx.engine}, RoseVault ${ctx.deployment.roseVault}`);

interface CohortStream {
  who: Who;
  streamId: string;
  args: RegisterBaseDepositArgs;
  selfDeposit: boolean;
}

interface CashDeposit {
  who: Who;
  args: RegisterBaseCashArgs;
}

interface Registered {
  classes: Record<"seed-base" | "kol-base", string>;
  positions: { who: Who; streamId: string; positionId: string; classId: string; selfDeposit: boolean }[];
}

function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

async function stepFund(): Promise<void> {
  for (const who of EVERYONE) {
    const id = accountOf(who);
    await ctx.identity.step(`near-account:${id}`, async (scope) => {
      const { publicKey } = ctx.keys.near(id);
      if ((await accountBalance(id)) === null) {
        const hash = await ctx.funder.createSubAccount(id, publicKey, near(CAST[who].nearBalance));
        scope.tx(txRef(`create ${id} with ${CAST[who].nearBalance} NEAR`, "near", hash));
        while ((await accountBalance(id)) === null) await sleep(2_000);
      }
      return { account: id, name: CAST[who].name, public_key: publicKey };
    });
  }
  await ctx.identity.step("addresses", () => {
    const evm: Record<string, Address> = {};
    for (const who of EVERYONE) evm[who] = who === "issuer" ? ctx.deployer.account.address : ctx.keys.evm(who).address;
    const solana: Record<string, string> = { issuer: ctx.ops.publicKey.toBase58() };
    for (const [who] of COHORTS["strategic-sol"].allocations) solana[who] = ctx.keys.solana(who).publicKey.toBase58();
    return Promise.resolve({ evm, solana });
  });
  await ctx.seed.step("near-top-ups", async (scope) => {
    const balances: Record<string, string> = {};
    for (const who of EVERYONE) {
      const id = accountOf(who);
      const target = near(CAST[who].nearBalance);
      const balance = await accountBalance(id);
      if (balance === null) throw new Error(`${id} does not exist yet: run the fund step again`);
      if (balance + near("0.05") < target) {
        const hash = await ctx.funder.transfer(id, target - balance);
        scope.tx(txRef(`top up ${id} to ${CAST[who].nearBalance} NEAR`, "near", hash));
      }
      balances[id] = formatNear((await accountBalance(id)) ?? 0n);
    }
    log(`  funder ${ctx.funder.accountId}: ${formatNear((await accountBalance(ctx.funder.accountId)) ?? 0n)} NEAR left`);
    return balances;
  });
  await ctx.seed.step("gas-top-ups", async (scope) => {
    const wallet = ctx.keys.evm(kolWallet).address;
    if ((await ctx.base.getBalance({ address: wallet })) < parseEther("0.0015")) {
      await sendBase(ctx, scope, `${NADIA_ETH} ETH to Nadia Solvik's wallet`, () => ctx.deployer.sendTransaction({ to: wallet, value: parseEther(NADIA_ETH) }));
    }
    const transfers = [];
    for (const [who] of COHORTS["strategic-sol"].allocations) {
      const holder = ctx.keys.solana(who).publicKey;
      if ((await ctx.solana.getBalance(holder)) < 0.005 * LAMPORTS_PER_SOL) transfers.push({ to: holder, sol: STRATEGIC_HOLDER_SOL });
    }
    if ((await ctx.solana.getBalance(ctx.derived.gasSol)) < GAS_SOL_FUNDED * LAMPORTS_PER_SOL) transfers.push({ to: ctx.derived.gasSol, sol: GAS_SOL_FUNDED });
    await fundSol(ctx, scope, "SOL to the Strategic Round holders and gas/sol", transfers);
    return { kol_wallet: kolWallet, kol_wallet_address: wallet, solana_transfers: transfers.map((t) => ({ to: t.to.toBase58(), sol: t.sol })) };
  });
}

async function cohortSchedule(faucetClass: 0 | 1): Promise<CohortSchedule> {
  const s = await ctx.base.readContract({ address: ctx.deployment.demoFaucet, abi: demoStreamFaucetAbi, functionName: "scheduleOf", args: [faucetClass] });
  const unit = gcd(gcd(s.amount, s.startUnlock), s.cliffUnlock);
  return { start: s.start, cliff: s.cliff, end: s.end, granularity: 1, unitAmount: s.amount / unit, unitStartUnlock: s.startUnlock / unit, unitCliffUnlock: s.cliffUnlock / unit };
}

async function stepBase(): Promise<void> {
  const { roseVault: vault, demoToken: token, demoFaucet: faucet, baseTusdc } = ctx.deployment;
  const decimals = await ctx.base.readContract({ address: token, abi: demoTokenAbi, functionName: "decimals" });
  for (const key of ["seed-base", "kol-base"] as const) {
    const cohort = COHORTS[key];
    await ctx.seed.step<CohortStream[]>(`base-cohort:${key}`, async (scope) => {
      const schedule = await cohortSchedule(cohort.faucetClass);
      const allocations = cohort.allocations.map(([who, amount]) => ({ nearAccount: accountOf(who), amount: whole(amount, decimals) }));
      const total = cohortTotal(allocations);
      await sendBase(ctx, scope, `Cindral Foundation: approve RoseVault for ${cohort.label}`, () => approveToken(ctx.deployer, token, vault, total));
      const value = parseEther("0.0001") * BigInt(allocations.length);
      const receipt = await sendBase(ctx, scope, `Cindral Foundation: createStreams (${cohort.label})`, async () => {
        await ctx.base.simulateContract({ account: ctx.deployer.account, address: vault, abi: roseVaultAbi, functionName: "createStreams", args: [token, schedule, allocations], value });
        return createStreams(ctx.deployer, { vault, token, schedule, allocations, value });
      });
      return decodeStreamDeposited(receipt).map((entry, i) => {
        const who = cohort.allocations[i]?.[0];
        if (who === undefined || entry.args.nearAccount !== accountOf(who)) throw new Error(`unexpected StreamDeposited order in ${receipt.transactionHash}`);
        return { who, streamId: entry.args.streamId.toString(), args: registerBaseDepositArgs(entry), selfDeposit: false };
      });
    });
  }
  await ctx.seed.step<CohortStream>("base-self-deposit:nadia", async (scope) => {
    const key = ctx.keys.evm(kolWallet);
    const last = await lastMintAt(ctx.base, faucet, key.address, DemoClass.KOL);
    const cooldown = await ctx.base.readContract({ address: faucet, abi: demoStreamFaucetAbi, functionName: "COOLDOWN" });
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (last !== 0n && now < last + cooldown) {
      const until = new Date(Number(last + cooldown) * 1000).toISOString();
      throw new Error(`the KOL wallet "${kolWallet}" (${key.address}) minted less than 24 h ago (next mint ${until}): pass --kol-wallet <another key name>`);
    }
    const wallet = ctx.evmWallet(key.privateKey);
    const minted = await sendBase(ctx, scope, "Nadia Solvik: DemoStreamFaucet.mintPosition(KOL)", () => mintDemoPosition(wallet, faucet, DemoClass.KOL));
    const position = decodePositionMinted(minted);
    if (position === null) throw new Error("no PositionMinted log");
    await sendBase(ctx, scope, "Nadia Solvik: approve RoseVault for the stream", () => approveStream(wallet, position.streamId, vault));
    const receipt = await sendBase(ctx, scope, "Nadia Solvik: depositStream", async () =>
      (await depositStream(wallet, ctx.base, { vault, streamId: position.streamId, nearAccount: accountOf("nadia"), feeMarginWei: parseEther("0.00001") })).hash,
    );
    const entry = decodeStreamDeposited(receipt)[0];
    if (entry === undefined) throw new Error("no StreamDeposited log");
    return { who: "nadia", streamId: position.streamId.toString(), args: registerBaseDepositArgs(entry), selfDeposit: true };
  });
  await ctx.seed.step<CashDeposit[]>("base-cash", async (scope) => {
    const deposits = EVERYONE.filter((who) => CAST[who].baseCash > 0).map((who) => ({ who, amount: usdc(CAST[who].baseCash) }));
    const total = deposits.reduce((sum, d) => sum + d.amount, 0n);
    const holder = ctx.deployer.account.address;
    const balance = await tokenBalance(ctx.base, baseTusdc, holder);
    if (balance < total) {
      const room = await mintableAmount(ctx.base, baseTusdc, holder);
      if (room < total - balance) throw new Error(`the Base tUSDC mint cap leaves ${room} for ${holder}, ${total - balance} needed`);
      await sendBase(ctx, scope, "Cindral Foundation: mint Base tUSDC", () => mintTestUsdc(ctx.deployer, baseTusdc, total - balance));
    }
    await sendBase(ctx, scope, "Cindral Foundation: approve RoseVault for tUSDC", () => approveToken(ctx.deployer, baseTusdc, vault, total));
    const out: CashDeposit[] = [];
    for (const d of deposits) {
      const receipt = await sendBase(ctx, scope, `depositCash ${CAST[d.who].baseCash} tUSDC for ${accountOf(d.who)}`, () =>
        depositCash(ctx.deployer, { vault, token: baseTusdc, amount: d.amount, nearAccount: accountOf(d.who), roundId: 0n }),
      );
      const entry = decodeCashDeposited(receipt)[0];
      if (entry === undefined) throw new Error("no CashDeposited log");
      out.push({ who: d.who, args: registerBaseCashArgs(entry) });
    }
    return out;
  });
}

async function stepSolana(): Promise<void> {
  const mint = await cindrMint(ctx);
  log(`  CINDR devnet mint ${mint.toBase58()}`);
  for (const [who, amount] of COHORTS["strategic-sol"].allocations) {
    const holder = ctx.keys.solana(who);
    const stream = await ctx.seed.step<{ metadata: string }>(`sol-stream:${who}`, async (scope) => ({
      metadata: await createStrategicStream(ctx, scope, `Cindral Foundation: Streamflow stream of ${amount.toLocaleString("en-US")} CINDR to ${CAST[who].name}`, mint, holder.publicKey, amount),
    }));
    await ctx.seed.step<SolPosition>(`sol-deposit:${who}`, (scope) => depositStrategicStream(ctx, scope, CAST[who].name, holder, ctx.actor(who), stream.metadata));
  }
}

async function findBasePosition(streamId: string): Promise<{ positionId: string; classId: string }> {
  for (let from = 0n; ; from += 50n) {
    const page = await withRetry("get_positions", () => ctx.views.getPositions(from, 50));
    if (page.length === 0) throw new Error(`no position for stream ${streamId}`);
    const hit = page.find((p) => p.source.kind === "BaseStream" && p.source.streamId.toString() === streamId);
    if (hit !== undefined) return { positionId: hit.positionId.toString(), classId: hit.classId };
  }
}

async function stepRegister(): Promise<void> {
  await ctx.seed.step<Registered>("base-register", async (scope) => {
    const streams = [...ctx.seed.get<CohortStream[]>("base-cohort:seed-base"), ...ctx.seed.get<CohortStream[]>("base-cohort:kol-base"), ctx.seed.get<CohortStream>("base-self-deposit:nadia")];
    const cash = ctx.seed.get<CashDeposit[]>("base-cash");
    const last = Math.max(...streams.map((s) => s.args.location.block_number), ...cash.map((c) => c.args.location.block_number));
    await waitSafe(ctx, last);
    const issuer = ctx.actor("issuer");
    const positions: Registered["positions"] = [];
    for (const s of streams) {
      const payer = s.selfDeposit ? ctx.actor(s.who) : issuer;
      await registerStream(ctx, scope, payer, s.args, `register_base_deposit: stream ${s.streamId} for ${CAST[s.who].name}`);
      const { positionId, classId } = await findBasePosition(s.streamId);
      positions.push({ who: s.who, streamId: s.streamId, positionId, classId, selfDeposit: s.selfDeposit });
    }
    for (const c of cash) await registerCash(ctx, scope, issuer, c.args, `register_base_cash: ${CAST[c.who].baseCash} tUSDC for ${CAST[c.who].name}`);
    const classOf = (who: Who): string => {
      const position = positions.find((p) => p.who === who);
      if (position === undefined) throw new Error(`no position for ${who}`);
      return position.classId;
    };
    return { classes: { "seed-base": classOf("halden"), "kol-base": classOf("teodor") }, positions };
  });
}

async function stepCash(): Promise<void> {
  await ctx.seed.step("near-cash", async (scope) => {
    const bounds = await withRetry("storage_balance_bounds", () => rpc.viewFunction<{ min: string }>(NEAR_CASH_TOKEN, "storage_balance_bounds", {}));
    const registered = async (account: string) => (await withRetry("storage_balance_of", () => rpc.viewFunction<unknown>(NEAR_CASH_TOKEN, "storage_balance_of", { account_id: account }))).value !== null;
    if (!(await registered(ctx.engine))) {
      scope.tx(nearRef(`tUSDC storage_deposit for ${ctx.engine}`, await ctx.funder.call(storageDepositCall(NEAR_CASH_TOKEN, ctx.engine, BigInt(bounds.value.min)))));
    }
    const credited: Record<string, string> = {};
    for (const who of EVERYONE) {
      const target = usdc(CAST[who].nearCash);
      if (target === 0n) continue;
      const actor = ctx.actor(who);
      const cash = await withRetry("get_cash", () => ctx.views.getCash(actor.accountId));
      const current = cash.find((c) => c.venue === "Near")?.amount ?? 0n;
      if (current < target) {
        const amount = target - current;
        const deposit = (await registered(actor.accountId)) ? 0n : BigInt(bounds.value.min);
        if (current === 0n) {
          const storage = await withRetry("storage_balance_of", () => ctx.views.storageBalanceOf(actor.accountId));
          const engineDeposit = storage === null ? await withRetry("storage_balance_bounds", () => ctx.views.storageMinimum()) : CASH_ROW_STORAGE_DEPOSIT;
          scope.tx(nearRef(`${CAST[who].name}: engine storage for the cash row`, await actor.call(ctx.calls.storageDeposit(engineDeposit))));
        }
        scope.tx(nearRef(`${CAST[who].name}: tUSDC mint ${amount / 1_000_000n}`, await actor.call(mintTestUsdcCall(NEAR_CASH_TOKEN, amount, deposit))));
        scope.tx(nearRef(`${CAST[who].name}: ft_transfer_call to the engine`, await actor.call(depositNearCashCall(NEAR_CASH_TOKEN, ctx.engine, amount))));
      }
      credited[actor.accountId] = (target / 1_000_000n).toString();
    }
    return credited;
  });
}

function classIds(): Record<CohortKey, string> {
  const base = ctx.seed.get<Registered>("base-register").classes;
  const strategic = ctx.seed.get<SolPosition>(`sol-deposit:${COHORTS["strategic-sol"].allocations[0][0]}`).classId;
  return { ...base, "strategic-sol": strategic };
}

async function stepRounds(): Promise<void> {
  const classes = classIds();
  const now = BigInt(Date.now()) * 1_000_000n;
  const window = { closesAt: now + BigInt(Math.round(windowMinutes * 60)) * 1_000_000_000n, revealWindow: BigInt(Math.round(revealMinutes * 60)) * 1_000_000_000n };
  const decimals = { "seed-base": 18, "kol-base": 18, "strategic-sol": 9 } as const;

  const t = ROUNDS.tender;
  const tender = await ctx.seed.step<RoundRecord>("round:tender", (scope) =>
    createRound(ctx, scope, "Cindral Foundation: create_tender (Seed Round, Base tUSDC)", ctx.actor("issuer"), "Tender", classes[t.cohort],
      ctx.calls.createTender({ classId: classes[t.cohort], venue: { Base: { token: ctx.deployment.baseTusdc } }, budget: usdc(t.budget), maxPrice: usdc(t.maxPrice), referencePrice: usdc(t.referencePrice), retireTo: ctx.deployer.account.address.toLowerCase(), window }),
    ),
  );
  const e = ROUNDS.exit;
  const exitRound = await ctx.seed.step<RoundRecord>("round:exit", (scope) =>
    createRound(ctx, scope, `${CAST[e.creator].name}: create_exit (Strategic Round, NEAR tUSDC)`, ctx.actor(e.creator), "Exit", classes[e.cohort],
      ctx.calls.createExit({ classId: classes[e.cohort], venue: "Near", maxPrice: usdc(e.maxPrice), window }),
    ),
  );
  const a = ROUNDS.advance;
  const advanceRound = await ctx.seed.step<RoundRecord>("round:advance", (scope) =>
    createRound(ctx, scope, `${CAST[a.holder].name}: create_advance (KOL Round, NEAR tUSDC)`, ctx.actor(a.holder), "Advance", classes[a.cohort],
      ctx.calls.createAdvance({ classId: classes[a.cohort], venue: "Near", units: whole(a.units, 18), claim: whole(a.claim, 18), minFill: whole(a.minFill, 18), maxPrice: usdc(a.maxPrice), window }),
    ),
  );

  await ctx.seed.step<OrderRecord[]>("orders:tender", async (scope) => {
    const out: OrderRecord[] = [];
    for (const ask of t.asks) {
      const units = whole(ask.quantity, decimals[t.cohort]);
      out.push(await placeOrder(ctx, scope, tender, ask.who, ctx.actor(ask.who), "Sell", { quantity: units, price: usdc(ask.price), collateral: units }));
    }
    return out;
  });
  await ctx.seed.step<OrderRecord[]>("orders:exit", async (scope) => {
    const round = await getRound(ctx, exitRound.roundId);
    const pricing = pricingOf(round, decimals[e.cohort]);
    const out: OrderRecord[] = [];
    for (const ask of e.asks) {
      const units = whole(ask.quantity, decimals[e.cohort]);
      out.push(await placeOrder(ctx, scope, exitRound, ask.who, ctx.actor(ask.who), "Sell", { quantity: units, price: usdc(ask.price), collateral: units }));
    }
    for (const bid of e.bids) {
      const quantity = whole(bid.quantity, decimals[e.cohort]);
      out.push(await placeOrder(ctx, scope, exitRound, bid.who, ctx.actor(bid.who), "Buy", { quantity, price: usdc(bid.price), collateral: escrowFor(pricing, quantity, usdc(bid.price)) }));
    }
    const m = e.malformed;
    out.push(await placeOrder(ctx, scope, exitRound, m.who, ctx.actor(m.who), "Buy", { quantity: whole(m.quantity, decimals[e.cohort]), price: usdc(m.price), collateral: usdc(m.escrow), malformed: true }));
    return out;
  });
  await ctx.seed.step<OrderRecord[]>("orders:advance", async (scope) => {
    const pricing = perClaimedToken(decimals[a.cohort]);
    const claim = whole(a.claim, decimals[a.cohort]);
    const out: OrderRecord[] = [await placeOrder(ctx, scope, advanceRound, a.holder, ctx.actor(a.holder), "Sell", { quantity: claim, price: usdc(a.reserve), collateral: claim })];
    for (const bid of a.bids) {
      const quantity = whole(bid.quantity, decimals[a.cohort]);
      out.push(await placeOrder(ctx, scope, advanceRound, bid.who, ctx.actor(bid.who), "Buy", { quantity, price: usdc(bid.price), collateral: escrowFor(pricing, quantity, usdc(bid.price)) }));
    }
    return out;
  });
}

/** Writes the demo mint into `deployments/testnet.json` and the engine env file (`NEXT_PUBLIC_SOLANA_DEMO_MINT`). */
function publishDemoMint(mint: string): void {
  const deploymentsFile = join(ROOT, "deployments", "testnet.json");
  const deployments = JSON.parse(readFileSync(deploymentsFile, "utf8")) as { deployments: Record<string, { solana?: Record<string, string> }> };
  const entry = deployments.deployments[ctx.engine];
  if (entry !== undefined) {
    entry.solana = { ...entry.solana, demo_mint: mint };
    writeFileSync(deploymentsFile, `${JSON.stringify(deployments, null, 2)}\n`);
  }
  const env = readFileSync(ctx.deployment.envFile, "utf8");
  const line = `NEXT_PUBLIC_SOLANA_DEMO_MINT=${mint}`;
  const next = /^NEXT_PUBLIC_SOLANA_DEMO_MINT=.*$/m.test(env) ? env.replace(/^NEXT_PUBLIC_SOLANA_DEMO_MINT=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
  if (next !== env) writeFileSync(ctx.deployment.envFile, next);
}

async function stepSummary(): Promise<void> {
  const classes = classIds();
  const labels: Record<string, unknown> = {};
  for (const key of Object.keys(COHORTS) as CohortKey[]) {
    const cls = await withRetry("get_class", () => ctx.views.getClass(classes[key]));
    labels[key] = { class_id: classes[key], label: COHORTS[key].label, chain: COHORTS[key].chain, total_units: cls?.totalUnits.toString(), positions: cls?.positions };
  }
  ctx.seed.put("classes", labels);
  const rounds: Record<string, unknown> = {};
  for (const key of ["tender", "exit", "advance"] as const) {
    const record = ctx.seed.get<RoundRecord>(`round:${key}`);
    const round = await getRound(ctx, record.roundId);
    rounds[key] = { round_id: record.roundId, kind: round.kind, status: round.status, bids: round.bidCount, closes_at: new Date(Number(round.closesAt / 1_000_000n)).toISOString() };
  }
  ctx.seed.put("rounds", rounds);
  const mint = ctx.identity.get<{ mint: string }>("solana-mint").mint;
  publishDemoMint(mint);
  log(JSON.stringify({ classes: labels, rounds, solana_demo_mint: mint }, null, 2));
}

const steps: Record<string, () => Promise<void>> = {
  fund: stepFund,
  base: stepBase,
  solana: stepSolana,
  register: stepRegister,
  cash: stepCash,
  rounds: stepRounds,
  summary: stepSummary,
};

if (args.step === "all") {
  for (const run of Object.values(steps)) await run();
} else {
  const run = steps[args.step];
  if (run === undefined) throw new Error(USAGE);
  await run();
}
