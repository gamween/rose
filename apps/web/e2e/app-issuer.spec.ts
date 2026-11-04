import { expect, test, type Page } from "@playwright/test";
import { MOCK, mockChains, type MockOverrides } from "./fixtures/engine-mock";

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

const BIDS_7 = RESULT_7.fills.map((fill) => ({ round_id: "7", bid_id: fill.bid_id, bidder: fill.bidder, side: "Sell", status: "Settled", escrow: "0", locked_units: fill.locked_units, bond: fill.bond, fee: "0", cash: fill.cash, fill_quantity: fill.fill_quantity, ciphertext_hex: null, placed_at: ns(NOW_SEC - 5 * DAY + 100), opened: fill.opened, void: null }));

const TX_HASH = "7yB4Z4yHnm8hsg8sXxQ4vCxk3iCTn2MmiLpSj8YsUvQd";

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
          return [{ venue: "Near", amount: "1000000000" }];
        case "storage_balance_of":
          return { total: "0", available: "0" };
        case "storage_balance_bounds":
          return { min: "6190000000000000000000", max: null };
        case "get_portfolio":
          return { holdings: [{ class_id: SEED, balance: `400${E18}`, locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "250000000000000000" }], bids: [], liens_held: [], lien_shares: [], cash: [{ venue: "Near", amount: "1000000000" }] };
        case "registration_deposit_for":
          return String(args.account).startsWith("halden") ? "0" : "3360000000000000000000";
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
        if (params.method_name === "ft_balance_of") return "5000000000";
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

async function openConsole(page: Page, hash = ""): Promise<void> {
  await page.goto(`/app/issuer${hash}`);
  await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
  await page.reload();
  await expect(page.locator("[data-issuer-console]")).toBeVisible({ timeout: 60_000 });
}

async function connectNearDemo(page: Page): Promise<string> {
  await page.locator("[data-connect]").click();
  const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
  await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
  await expect(dialog).toBeHidden();
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
    await page.getByLabel("Paste receivers").fill("halden.testnet,100\ntessaro.testnet,150");
    await page.getByLabel("Paste receivers").blur();
    await expect(page.getByText("Your free balance: 400.0000 units")).toBeVisible({ timeout: 30_000 });
    const preview = page.locator("[data-preview]");
    await expect(preview).toContainText("250.0000 CINDR units");
    await expect(preview).toContainText("0.00336 NEAR", { timeout: 30_000 });
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
    await openConsole(page, "#tender");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-issuer-tab='tender']")).toBeVisible({ timeout: 30_000 });
    await page.locator("#tender-budget").fill("950");
    await page.getByRole("button", { name: "Max discount to a declared reference" }).click();
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

  test("builds the Sputnik DAO proposal with the live bond and the Trezu manifest", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#dao");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-dao-panel]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-preview]").first()).toContainText("1,000.00 USDC", { timeout: 30_000 });
    await page.locator("#tender-budget").fill("950");
    await page.locator("#tender-max").fill("9");
    await page.locator("#tender-retire").fill("0x000000000000000000000000000000000000dEaD");
    await page.locator("#dao-account").fill("test.sputnikv2.testnet");
    await page.locator("[data-read-policy]").scrollIntoViewIfNeeded();
    await page.locator("[data-read-policy]").click();
    await expect(page.getByText(/Proposal bond 1 NEAR/)).toBeVisible({ timeout: 30_000 });
    const json = page.locator("[data-dao-json]");
    await expect(json).toContainText(`"receiver_id": "${MOCK.engine}"`);
    await expect(json).toContainText('"method_name": "create_tender"');
    await expect(json).toContainText('"deposit": "50000000000000000000000"');
    const trezu = page.locator("[data-trezu-json]");
    await expect(trezu).toContainText('"version": 1');
    await expect(trezu).toContainText('"budget": "{{budget}}"');
    await shot(page, "dao");
    await page.locator("[data-file-proposal]").click();
    await expect(page.locator("[data-action-success]")).toContainText("Proposal #9 filed to test.sputnikv2.testnet", { timeout: 30_000 });
  });

  test("funds the NEAR venue and lists the issuer's Tenders with their report", async ({ page }) => {
    const state = { account: "", sent: [] as string[] };
    await mockChains(page, overrides(state));
    await openConsole(page, "#fund");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-issuer-tab='fund']")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-preview]")).toContainText("1,000.00 USDC", { timeout: 30_000 });
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
    expect((await download).suggestedFilename()).toBe("rose-tender-7.csv");
    await page.locator("[data-open-printable]").click();
    await page.waitForURL("**/app/issuer/results/7/report");
    await expect(page.locator("[data-print]")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-tender-report]")).toContainText("Issuer refund");
    await shot(page, "report");
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
