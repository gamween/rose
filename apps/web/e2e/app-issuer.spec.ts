import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CASH_TX, cashAttemptJson, cashAttemptScript, withCashResume, type CashResume } from "./fixtures/base-cash";
import { MOCK, mockChains, type MockOverrides } from "./fixtures/engine-mock";
import { connectDemoWallet } from "./fixtures/wallets";

/**
 * Issuer console (`/app/issuer`) and the Tender results page: class computation from a schedule
 * with the unlock chart, unit distribution with the registration deposits, the Tender preview
 * and creation through the demo NEAR wallet (mocked `send_tx`), the Sputnik DAO proposal and
 * the Trezu manifest, NEAR funding, and the settled Tender report with its candidate table.
 */

const SEED = "a".repeat(64);
const NOW_SEC = 1_762_200_000;
const DAY = 86_400;
const ns = (seconds: number) => `${String(seconds)}000000000`;
const E18 = "000000000000000000";
const SCREENS = process.env.ROSE_SCREENSHOT_DIR;

const ROUND_7 = {
  round_id: "7",
  kind: "Tender",
  class_id: SEED,
  venue: "Near",
  creator: "",
  status: "Settled",
  app_id: "00",
  opens_at: ns(NOW_SEC - 5 * DAY),
  closes_at: ns(NOW_SEC - 4 * DAY),
  key_timeout: "3600000000000",
  reveal_window: "600000000000",
  max_price: "10000000",
  f_ts: "0",
  remaining_lock_secs: String(278 * DAY),
  bid_count: 2,
  opened_count: 2,
  settled_count: 2,
  created_at: ns(NOW_SEC - 5 * DAY),
  budget: "950000000",
  issuer_escrow: "952850000",
  reference_price: "9500000",
  retire_to: "0x000000000000000000000000000000000000dead",
  key: "bls12381g1:jkl",
  key_source: "Callback",
  key_received_at: ns(NOW_SEC - 4 * DAY + 6),
  reveal_ends_at: ns(NOW_SEC - 4 * DAY + 606),
  ended_at: ns(NOW_SEC - 4 * DAY + 700),
};

const RESULT_7 = {
  price: "9000000",
  volume: `100${E18}`,
  notional: "900000000",
  fee: "2700000",
  issuer_charged: "900000000",
  issuer_refund: "50000000",
  remaining_lock_secs: String(278 * DAY),
  fills: [
    { bid_id: 0, bidder: "halden.testnet", side: "Sell", escrow: "0", locked_units: `100${E18}`, bond: "1000000", fee: "0", cash: "900000000", fill_quantity: `100${E18}`, settled: true, opened: { quantity: `100${E18}`, price: "9000000" }, void: null },
    { bid_id: 1, bidder: "tessaro.testnet", side: "Sell", escrow: "0", locked_units: `10${E18}`, bond: "1000000", fee: "0", cash: "0", fill_quantity: "0", settled: true, opened: { quantity: `10${E18}`, price: "10000000" }, void: null },
  ],
};

/** An open Exit round settled in the Base tUSDC venue. */
const ROUND_8 = { ...ROUND_7, round_id: "8", kind: "Exit", status: "Open", venue: { Base: { token: MOCK.baseTusdc } }, creator: "alice.testnet", f_ts: "250000000000000000", closes_at: ns(NOW_SEC + DAY), opens_at: ns(NOW_SEC - DAY), budget: null, issuer_escrow: null, reference_price: null, retire_to: null, key: null, key_source: null, key_received_at: null, reveal_ends_at: null, ended_at: null, bid_count: 0, opened_count: 0, settled_count: 0 };

const BIDS_7 = RESULT_7.fills.map((fill) => ({ round_id: "7", bid_id: fill.bid_id, bidder: fill.bidder, side: "Sell", status: "Settled", escrow: "0", locked_units: fill.locked_units, bond: fill.bond, fee: "0", cash: fill.cash, fill_quantity: fill.fill_quantity, ciphertext_hex: null, placed_at: ns(NOW_SEC - 5 * DAY + 100), opened: fill.opened, void: null }));

const TX_HASH = "7yB4Z4yHnm8hsg8sXxQ4vCxk3iCTn2MmiLpSj8YsUvQd";
const DAO = "test.sputnikv2.testnet";
/** A treasury that holds no tUSDC and is not registered on the token yet. */
const EMPTY_DAO = "empty.sputnikv2.testnet";
const isDao = (account: unknown) => account === DAO || account === EMPTY_DAO;

function successOutcome(account: string, receiver: string, value: string) {
  const outcome = { id: "r", outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: receiver, status: { SuccessValue: value } } };
  return { status: { SuccessValue: value }, transaction: { hash: TX_HASH, signer_id: account, receiver_id: receiver, nonce: 8, public_key: "ed25519:11111111111111111111111111111111" }, transaction_outcome: outcome, receipts_outcome: [outcome], final_execution_status: "EXECUTED_OPTIMISTIC" };
}

function overrides(state: { account: string; sent: string[] }): MockOverrides {
  return {
    engineView: (method, args) => {
      switch (method) {
        case "get_limits":
          return { bid_storage_deposit: "20000000000000000000000", round_storage_deposit: "50000000000000000000000", bond_floor: "1000000", fee_bps: 30, max_bids_per_round: 64, max_distribution_receivers: 50, min_key_timeout: ns(60), max_key_timeout: ns(7 * 86_400), min_reveal_window: ns(300), max_reveal_window: ns(7 * 86_400), max_round_horizon: ns(30 * 86_400) };
        case "get_holding":
          return { class_id: args.class_id, balance: `400${E18}`, locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "250000000000000000" };
        case "get_cash":
          return isDao(args.account) ? [] : [{ venue: "Near", amount: "1000000000" }];
        case "storage_balance_of":
          return isDao(args.account_id) ? null : { total: "0", available: "0" };
        case "storage_balance_bounds":
          return { min: "6190000000000000000000", max: null };
        case "get_portfolio":
          if (isDao(args.account)) return { holdings: [], bids: [], liens_held: [], lien_shares: [], cash: [] };
          return { holdings: [{ class_id: SEED, balance: `400${E18}`, locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "250000000000000000" }], bids: [], liens_held: [], lien_shares: [], cash: [{ venue: "Near", amount: "1000000000" }] };
        case "registration_deposit_for":
          return String(args.account).startsWith("halden") ? "15000000000000000000000" : "18360000000000000000000";
        case "compute_base_class_id":
          return SEED;
        case "get_round":
          return String(args.round_id) === "7" ? { ...ROUND_7, creator: state.account || "cindral.testnet" } : null;
        case "get_round_result":
          return String(args.round_id) === "7" ? RESULT_7 : null;
        case "get_bids":
          return String(args.round_id) === "7" ? BIDS_7 : [];
        case "get_rounds": {
          const filter = args.filter as { creator?: string; kind?: string } | null;
          if (filter?.kind === "Tender" && filter.creator === DAO) return { rounds: [{ ...ROUND_7, round_id: "8", status: "Open", creator: DAO }], next: null };
          return filter?.kind === "Tender" && filter.creator === state.account && state.account ? { rounds: [{ ...ROUND_7, creator: state.account }], next: null } : { rounds: [], next: null };
        }
        default:
          return undefined;
      }
    },
    nearRequest: (method, params) => {
      if (method === "query" && params.request_type === "view_access_key") {
        return { nonce: 7, permission: "FullAccess", block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
      }
      if (method === "query" && params.request_type === "call_function") {
        const viewArgs = JSON.parse(Buffer.from(String(params.args_base64 ?? ""), "base64").toString("utf8") || "{}") as { account_id?: string };
        if (params.method_name === "ft_balance_of") return viewArgs.account_id === EMPTY_DAO ? "0" : "5000000000";
        if (params.method_name === "storage_balance_of") return viewArgs.account_id === EMPTY_DAO ? null : { total: "1250000000000000000000", available: "0" };
        if (params.method_name === "get_policy") return { roles: [], default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] }, proposal_bond: "1000000000000000000000000", proposal_period: "604800000000000", bounty_bond: "1000000000000000000000000", bounty_forgiveness_period: "86400000000000" };
        if (params.method_name === "version") return "2.0.0";
      }
      if (method === "block") return { header: { height: 276_200_700, hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS", timestamp: NOW_SEC * 1e9, timestamp_nanosec: ns(NOW_SEC) } };
      if (method === "send_tx" || method === "tx") {
        const signed = String((params as { signed_tx_base64?: string }).signed_tx_base64 ?? "");
        state.sent.push(signed);
        const receiver = state.sent.length === 1 && state.account ? MOCK.engine : MOCK.engine;
        return successOutcome(state.account, receiver, Buffer.from('"9"').toString("base64"));
      }
      return undefined;
    },
    baseRequest: (method, params) => {
      if (method !== "eth_call") return undefined;
      const call = params[0] as { to: string; data: string };
      if (call.data.startsWith("0x70a08231")) return `0x${(10_000_000_000n).toString(16).padStart(64, "0")}`;
      if (call.data.startsWith("0xdd62ed3e")) return `0x${"0".repeat(64)}`;
      return undefined;
    },
  };
}

/**
 * `atFixtureTime` runs the page clock from NOW_SEC: the fixture's classes are still locked then,
 * and the Tender form refuses a class that is fully unlocked at its close time.
 */
async function openConsole(page: Page, hash = "", options: { atFixtureTime?: boolean } = {}): Promise<void> {
  if (options.atFixtureTime) await page.clock.install({ time: NOW_SEC * 1000 });
  await page.goto(`/app/issuer${hash}`);
  await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
  await page.reload();
  await expect(page.locator("[data-issuer-console]")).toBeVisible({ timeout: 60_000 });
}

async function connectNearDemo(page: Page): Promise<string> {
  await connectDemoWallet(page, "near");
  const account = await page.evaluate(() => (JSON.parse(localStorage.getItem("rose.demo.near") ?? "{}") as { accountId?: string }).accountId ?? "");
  expect(account).toMatch(/^rose-demo-/);
  await dismissToasts(page);
  return account;
}

/** Hides the fixed-position toast stack so it never sits over a button on the 375 px viewport (the toast content is asserted through the inline feedback). */
async function dismissToasts(page: Page): Promise<void> {
  await page.addStyleTag({ content: "ol[aria-label='Notifications'] { display: none !important; }" });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENS) return;
  const width = page.viewportSize()?.width ?? 1470;
  await page.screenshot({ path: `${SCREENS}/app-issuer-${name}-${width >= 1000 ? "1470" : "375"}.png`, fullPage: true });
}

test.describe("issuer console", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");

  test("computes a class from a schedule, with the normalized schedule, the chart and the existing-class badge", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page);
    await expect(page.getByRole("heading", { name: "Connect a NEAR wallet to act as the issuer" })).toBeVisible({ timeout: 30_000 });
    await shot(page, "gate");
    await page.getByRole("tab", { name: "From a schedule" }).click();
    await page.locator("#class-token").fill(MOCK.demoToken);
    await page.locator("#class-cliff").fill("2026-12-04T00:00");
    await page.locator("#class-cliff-unlock").fill("100");
    await page.locator("[data-compute-class]").click();
    await expect(page.locator("[data-class-result='ok']")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Existing", { exact: true })).toBeVisible();
    await expect(page.locator("[data-unlock-chart] svg")).toBeVisible();
    await expect(page.locator("[data-preview]").first()).toContainText(SEED);
    await expect(page.locator("[data-preview]").first()).toContainText("10 · 0 · 1");
    await shot(page, "class");
    expect(errors).toEqual([]);
  });

  test("distributes units with the receivers' registration deposits through the demo wallet", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#distribute");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-issuer-tab='distribute']")).toBeVisible({ timeout: 30_000 });
    // The empty first row asks for a receiver; it is not an error yet.
    await expect(page.getByText("Add a receiver and its units.")).toBeVisible();
    await expect(page.getByText("Not a valid NEAR account id.")).toHaveCount(0);
    await page.getByLabel("Paste receivers").fill("halden.testnet,100\ntessaro.testnet,150");
    await page.getByLabel("Paste receivers").blur();
    await expect(page.getByText("Your free balance: 400.0000 units")).toBeVisible({ timeout: 30_000 });
    const preview = page.locator("[data-preview]");
    await expect(preview).toContainText("250.0000 CINDR units");
    await expect(preview).toContainText("0.00336 NEAR", { timeout: 30_000 });
    await expect(page.getByText("registered", { exact: true })).toBeVisible();
    await shot(page, "distribute");
    await page.locator("[data-distribute]").click();
    await expect(page.locator("[data-flow-steps] [data-status='done']")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator("[data-flow-steps]")).toContainText("250.0000 units distributed");
    await expect(page.locator("[data-flow-steps]").getByRole("link", { name: /near.rocks/ })).toHaveAttribute("href", `https://testnet.near.rocks/tx/${TX_HASH}`);
    expect(state.sent).toHaveLength(1);
  });

  test("previews and creates a Tender with a declared reference and a max discount", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#tender", { atFixtureTime: true });
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-issuer-tab='tender']")).toBeVisible({ timeout: 30_000 });
    await page.locator("#tender-budget").fill("950");
    await page.getByRole("button", { name: "Max discount", exact: true }).click();
    await page.locator("#tender-ref").fill("10");
    await page.locator("#tender-discount").fill("10");
    await page.getByRole("button", { name: "Burn address" }).click();
    const preview = page.locator("[data-preview]").first();
    await expect(preview).toContainText("952.85 USDC");
    await expect(preview).toContainText("9.000000 USDC per locked token");
    await expect(preview).toContainText("1,000.00 USDC", { timeout: 30_000 });
    await shot(page, "tender");
    await page.locator("[data-create-tender]").click();
    await expect(page.locator("[data-action-success]")).toContainText("Tender #9 created", { timeout: 30_000 });
    await expect(page.locator("[data-action-success]").getByRole("link", { name: "Round #9" })).toHaveAttribute("href", "/app/rounds/9");
    expect(state.sent).toHaveLength(1);
  });

  test("runs a Tender via a DAO: reads it, funds its engine cash and files both proposals, then lists its Tenders", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#dao", { atFixtureTime: true });
    state.account = await connectNearDemo(page);
    const panel = page.locator("[data-dao-panel]");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await page.locator("#tender-budget").fill("950");
    await page.locator("#tender-max").fill("9");
    await page.locator("#tender-retire").fill("0x000000000000000000000000000000000000dEaD");
    await page.locator("#dao-account").fill(DAO);
    await page.locator("[data-read-policy]").scrollIntoViewIfNeeded();
    await page.locator("[data-read-policy]").click();
    await expect(panel.getByText(/Proposal bond 1 NEAR/)).toBeVisible({ timeout: 30_000 });
    const funding = panel.locator("[data-dao-funding]");
    await expect(funding.locator("[data-preview]")).toContainText("952.85 USDC");
    await expect(funding).toContainText("0.00619 NEAR is missing");
    await expect(funding).toContainText("5,000.00 tUSDC, enough for the funding.");
    const fundingJson = page.locator("[data-dao-json='funding']");
    await expect(fundingJson).toContainText('"receiver_id": "tusdc.rose-app.testnet"');
    await expect(fundingJson).toContainText('"method_name": "ft_transfer_call"');
    await expect(fundingJson).toContainText('"deposit": "1"');
    await panel.locator("[data-dao-storage]").click();
    await expect(funding.locator("[data-action-success]").first()).toContainText(`NEAR of engine storage paid for ${DAO}`, { timeout: 30_000 });
    await dismissToasts(page);
    await page.locator("[data-file-proposal='funding']").click();
    await expect(funding.locator("[data-action-success]").last()).toContainText(`Proposal #9 filed to ${DAO}`, { timeout: 30_000 });
    const tenderJson = page.locator("[data-dao-json='tender']");
    await expect(tenderJson).toContainText(`"receiver_id": "${MOCK.engine}"`);
    await expect(tenderJson).toContainText('"method_name": "create_tender"');
    await expect(tenderJson).toContainText('"deposit": "50000000000000000000000"');
    await expect(page.locator("[data-trezu-json]")).toContainText('"budget": "{{budget}}"');
    await shot(page, "dao");
    await page.locator("[data-file-proposal='tender']").click();
    await expect(panel.locator("[data-dao-tender] [data-action-success]")).toContainText(`Proposal #9 filed to ${DAO}`, { timeout: 30_000 });
    expect(state.sent).toHaveLength(3);
    await page.getByRole("tab", { name: "Results" }).click();
    const row = page.locator("[data-tender-row='8']");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(DAO);
    await expect(page.locator("[data-tender-row='7']")).toContainText("You");
    expect(errors).toEqual([]);
  });

  test("sends the missing tUSDC to a treasury that holds none, registering it on the token first", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#dao", { atFixtureTime: true });
    state.account = await connectNearDemo(page);
    const panel = page.locator("[data-dao-panel]");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await page.locator("#tender-budget").fill("950");
    await page.locator("#tender-max").fill("9");
    await page.locator("#tender-retire").fill("0x000000000000000000000000000000000000dEaD");
    await page.locator("#dao-account").fill(EMPTY_DAO);
    await page.locator("[data-read-policy]").click();
    const funding = panel.locator("[data-dao-funding]");
    await expect(funding).toContainText("0.00 tUSDC, 952.85 short of the funding.", { timeout: 30_000 });
    await expect(funding).toContainText("Registers the DAO on the token first (0.00125 NEAR).");
    await dismissToasts(page);
    await panel.locator("[data-dao-send]").click();
    await expect(funding.locator("[data-action-success]").first()).toContainText(`952.85 tUSDC sent to ${EMPTY_DAO}`, { timeout: 30_000 });
    await expect(funding.locator("[data-action-success]").first().getByRole("link", { name: "Token registration on near.rocks" })).toBeVisible();
    expect(state.sent).toHaveLength(2);
  });

  test("funds the NEAR venue and lists the issuer's Tenders with their report", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#fund");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-issuer-tab='fund']")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-preview]")).toContainText("1,000.00 tUSDC", { timeout: 30_000 });
    await expect(page.locator("[data-storage-notice='top_up']")).toContainText("storage top-up of 0.00619 NEAR", { timeout: 30_000 });
    await shot(page, "fund");
    await page.locator("[data-fund-near]").click();
    await expect(page.locator("[data-action-success]")).toContainText("1,000.00 tUSDC credited", { timeout: 30_000 });
    expect(state.sent).toHaveLength(2);
    await expect(page.locator("[data-action-success]").getByRole("link", { name: "Storage deposit on near.rocks" })).toBeVisible();
    await dismissToasts(page);
    await page.getByRole("tab", { name: "Results" }).click();
    const row = page.locator("[data-tender-row='7']");
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Settled");
    await shot(page, "results-list");
    await row.getByRole("link", { name: "Results →" }).click();
    await page.waitForURL("**/app/issuer/results/7");
    const report = page.locator("[data-tender-report]");
    await expect(report).toBeVisible({ timeout: 30_000 });
    await expect(report).toContainText("9.0000");
    await expect(report.locator("[data-candidate='best']")).toContainText("9.0000");
    await expect(report.locator("[data-candidate='other']")).toContainText("95.0000");
    await expect(report.locator("[data-recompute]")).toHaveAttribute("data-recompute", "match");
    await expect(report).toContainText("key requested");
    await shot(page, "results");
    const download = page.waitForEvent("download");
    await page.locator("[data-download-csv]").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("rose-tender-7.csv");
    // Machine-readable: exact decimals, no thousands separators, ISO 8601 times.
    const csv = readFileSync((await file.path())!, "utf8");
    expect(csv).toMatch(/^parameters,closes_at_utc,\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/m);
    expect(csv).toMatch(/^result,clearing_price_usdc_per_locked_token,9$/m);
    expect(csv).not.toMatch(/"\d{1,3}(,\d{3})+/);
    await page.locator("[data-open-printable]").click();
    await page.waitForURL("**/app/issuer/results/7/report");
    await expect(page.locator("[data-print]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-tender-report]")).toContainText("Issuer refund");
    await shot(page, "report");
  });

  test("registers, from the Fund tab, a Base cash deposit a reload left unregistered", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    const resume: CashResume = { creditTo: DAO, amount: 1_000_000_000n, roundId: 0n, registered: false, registerSent: 0 };
    await mockChains(page, withCashResume(overrides(state), resume));
    await page.addInitScript(cashAttemptScript(resume));
    await openConsole(page, "#fund");
    state.account = await connectNearDemo(page);
    await page.locator("[data-fund-venue]").selectOption(`base:${MOCK.baseTusdc}`);
    const pending = page.locator("[data-pending-cash]");
    await expect(pending).toContainText("Cash waiting for registration", { timeout: 30_000 });
    await expect(pending).toContainText(`1,000.00 tUSDC`);
    await expect(pending).toContainText(DAO);
    await expect(pending.getByRole("link", { name: "depositCash ↗" })).toHaveAttribute("href", `https://sepolia.basescan.org/tx/${CASH_TX}`);
    await shot(page, "fund-pending-cash");
    await pending.locator("[data-register-pending-cash]").click();
    const flow = pending.locator("[data-pending-cash-flow]");
    await expect(flow.locator("[data-status='done']")).toHaveCount(3, { timeout: 30_000 });
    await expect(flow).toContainText(`CashDeposited in block 39000000 for ${DAO}.`);
    await expect(flow).toContainText("Final since long ago");
    await expect(flow).toContainText(`Credited to the Base cash of ${DAO}.`);
    await expect(flow.getByRole("link", { name: /near.rocks/ })).toHaveAttribute("href", `https://testnet.near.rocks/tx/${TX_HASH}`);
    await expect(pending.locator("[data-pending-cash-row]")).toHaveCount(0);
    expect(resume.registerSent).toBe(1);
    await shot(page, "fund-pending-cash-done");
  });

  test("explains a missing round on the results page", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await page.goto("/app/issuer/results/42");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await expect(page.getByText("Round #42 does not exist")).toBeVisible({ timeout: 60_000 });
    await shot(page, "results-missing");
  });
});

test.describe("Base cash waiting for registration, from the order form", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");

  test("an Exit buyer registers the cash deposit a reload interrupted, then sees it in the venue", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    const resume: CashResume = { creditTo: "", amount: 50_000_000n, roundId: 8n, registered: false, registerSent: 0 };
    const base = overrides(state);
    await mockChains(
      page,
      withCashResume(
        {
          ...base,
          engineView: (method, args) => {
            if (method === "get_round" && String(args.round_id) === "8") return ROUND_8;
            if (method === "get_bids" && String(args.round_id) === "8") return [];
            if (method === "get_order_id") return null;
            if (method === "get_cash") return resume.registered ? [{ venue: { Base: { token: MOCK.baseTusdc } }, amount: resume.amount.toString() }] : [];
            if (method === "get_portfolio") return { holdings: [], bids: [], liens_held: [], lien_shares: [], cash: resume.registered ? [{ venue: { Base: { token: MOCK.baseTusdc } }, amount: resume.amount.toString() }] : [] };
            return base.engineView?.(method, args);
          },
        },
        resume,
      ),
    );
    await page.clock.install({ time: NOW_SEC * 1000 });
    await page.addInitScript(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.goto("/app/rounds/8");
    state.account = await connectNearDemo(page);
    resume.creditTo = state.account;
    await page.evaluate((value) => localStorage.setItem("rose.deposits.attempted", value), cashAttemptJson(resume));
    await page.reload();
    const form = page.locator("[data-order-form]");
    await expect(form).toBeVisible({ timeout: 30_000 });
    const pending = form.locator("[data-pending-cash]");
    await expect(pending).toContainText("50.00 tUSDC", { timeout: 30_000 });
    await expect(pending).toContainText("round label 8");
    await pending.locator("[data-register-pending-cash]").click();
    const flow = pending.locator("[data-pending-cash-flow]");
    await expect(flow.locator("[data-status='done']")).toHaveCount(3, { timeout: 30_000 });
    await expect(flow).toContainText(`Credited to the Base cash of ${state.account}.`);
    await expect(form.locator("[data-order-preview]")).toContainText("50.00 USDC", { timeout: 30_000 });
    expect(resume.registerSent).toBe(1);
  });
});

test.describe("values at 375 px", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");
  test.use({ viewport: { width: 375, height: 812 } });

  /** Text cut with an ellipsis that carries no title (only long identifiers may be shortened, with the full value in a title), and the page's own scroll width. */
  async function clipped(page: Page): Promise<{ texts: string[]; scrollWidth: number }> {
    return page.evaluate(() => {
      const texts: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        if (getComputedStyle(element).textOverflow !== "ellipsis" || element.offsetParent === null) continue;
        if (element.scrollWidth > element.clientWidth + 1 && !element.closest("[title]")) texts.push((element.textContent ?? "").trim());
      }
      return { texts, scrollWidth: document.documentElement.scrollWidth };
    });
  }

  test("numbers and dates read in full on the rounds list, a round, the Tender report, prices, the landing stats and the docs", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    const base = overrides(state);
    await mockChains(page, {
      ...base,
      engineView: (method, args) => {
        if (method === "get_round" && String(args.round_id) === "8") return ROUND_8;
        if (method === "get_bids" && String(args.round_id) === "8") return [];
        if (method === "get_rounds" && !(args.filter as { creator?: string } | null)?.creator) return { rounds: [ROUND_8, ROUND_7], next: null };
        return base.engineView?.(method, args);
      },
    });
    await page.clock.install({ time: NOW_SEC * 1000 });
    await page.addInitScript(() => localStorage.setItem("rose.tour.dismissed", "1"));
    const pages: [string, string][] = [
      ["/app/rounds", "[data-round-card='7']"],
      ["/app/rounds/8", "[data-key-stats]"],
      ["/app/rounds/8#details", "[data-parameters]"],
      ["/app/issuer/results/7", "[data-report-parameters]"],
      ["/app/prices", "figure"],
      ["/", "[data-landing]"],
      ["/docs/cross-chain-custody", "article"],
    ];
    for (const [path, ready] of pages) {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const result = await clipped(page);
      expect(result.texts, path).toEqual([]);
      expect(result.scrollWidth, path).toBeLessThanOrEqual(375);
    }
    // The close date is in the round's Details tab, in full; its row stacks label over value at 375 px.
    await page.goto("/app/rounds/8");
    await page.locator("[data-tab='details']").click();
    const closes = page.locator("[data-parameters] [data-detail='closes']");
    await expect(closes.locator("dd")).toHaveText("4 Nov 2025, 20:00 UTC");
    await expect(closes.locator("dd")).toBeVisible();
    await expect(closes).toHaveCSS("grid-template-columns", /^\d+(\.\d+)?px$/);
  });
});

test.describe("issuer console without a deployed engine", () => {
  test.skip(Boolean(process.env.NEXT_PUBLIC_ENGINE_ACCOUNT), "the engine is configured for this build");

  test("shows the not-deployed state", async ({ page }) => {
    await page.goto("/app/issuer");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Engine not deployed yet" })).toBeVisible({ timeout: 60_000 });
    await shot(page, "not-deployed");
  });
});
