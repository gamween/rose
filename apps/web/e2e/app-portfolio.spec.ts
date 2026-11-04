import { expect, test, type Page } from "@playwright/test";
import { MOCK, mockChains, type MockOverrides } from "./fixtures/engine-mock";
import { evmCallRequest } from "./fixtures/evm-calls";

/**
 * Portfolio (`/app`): a demo NEAR account holding units of two classes with claimable tokens,
 * a sealed ask, a lien as holder and a share as funder, cash in both venues, payouts in every
 * state and a retired Tender lot. Every chain read is mocked; the NEAR tUSDC claim runs end to
 * end through the demo wallet against a mocked `send_tx`.
 */

const SEED = "a".repeat(64);
const STRATEGIC = "c".repeat(64);
const NOW_SEC = 1_762_200_000;
const ns = (seconds: number) => `${String(seconds)}000000000`;
const ONE_E18 = "000000000000000000";

const HOLDINGS = [
  { class_id: SEED, balance: `70${ONE_E18}`, locked_in_rounds: `20${ONE_E18}`, encumbered: `10${ONE_E18}`, claimable: `12500${"0".repeat(15)}`, checkpoint: "200000000000000000" },
  { class_id: STRATEGIC, balance: "40000000000000", locked_in_rounds: "0", encumbered: "0", claimable: "2500000000000", checkpoint: "100000000000000000" },
];

const BID = { round_id: "8", bid_id: 2, bidder: "", side: "Sell", status: "Sealed", escrow: "0", locked_units: `20${ONE_E18}`, bond: "1000000", fee: "0", cash: "0", fill_quantity: "0", ciphertext_hex: "ab".repeat(192), placed_at: ns(NOW_SEC - 3600), opened: null, void: null };

const LIEN_HELD = { lien_id: "4", round_id: "6", class_id: SEED, holder: "", units: `10${ONE_E18}`, claim_total: `4${ONE_E18}`, delivered: `3${ONE_E18}`, pending_excess: "0", created_at: ns(NOW_SEC - 8 * 86_400), released: false };
const LIEN_SHARE = { lien_id: "9", class_id: STRATEGIC, funder: "", claim: "5000000000000", claimed: "1000000000000", claimable: "750000000000" };

const ROUND_8 = { round_id: "8", kind: "Exit", class_id: SEED, venue: "Near", creator: "bob.testnet", status: "Open", app_id: "00", opens_at: ns(NOW_SEC - 7200), closes_at: ns(NOW_SEC + 86_400), key_timeout: "3600000000000", reveal_window: "600000000000", max_price: "9000000", f_ts: "260000000000000000", remaining_lock_secs: String(270 * 86_400), bid_count: 3, opened_count: 0, settled_count: 0, created_at: ns(NOW_SEC - 7200) };

function payout(id: string, status: unknown, extra: Record<string, unknown> = {}) {
  return { id, chain: "Base", kind: { BaseTransfer: { token: MOCK.baseTusdc, to: "0x7d4777cfc6ed48061b0bccae558d29919b412042", amount: "25000000" } }, debit: null, requester: "", status, digest: "ab", base: status === "Signed" ? { r: "11".repeat(32), s: "22".repeat(32), v: 27 } : null, solana: null, created_at: ns(NOW_SEC - 600), updated_at: ns(NOW_SEC - 590), requested_block: "276100000", ...extra };
}

const PAYOUTS = [
  payout("12", "Signed"),
  payout("11", "Requested", { requested_block: "276000000" }),
  payout("10", { Failed: { reason: "authority signature not produced" } }),
  payout("9", "AwaitingGasSignature", { chain: "Solana", kind: { SolTransfer: { mint: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w", to_owner: "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n", amount: "1000000000000" } }, base: null, solana: { message: "00", withdraws: [], pool_used: "0", pool_credit: "0", authority_path: "vault/sol", nonce_account: "9vaultNonce111111111111111111111111111111111", nonce_value: "H1", authority_signature: "aa", gas_signature: null, transaction: null } }),
];

const OUTCOME_HASH = "7yB4Z4yHnm8hsg8sXxQ4vCxk3iCTn2MmiLpSj8YsUvQd";
const SCREENS = process.env.ROSE_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENS) return;
  await page.screenshot({ path: `${SCREENS}/app-portfolio-${name}-${String(page.viewportSize()?.width ?? 0)}.png`, fullPage: true });
}

/** Mocked views of whichever account the page asks about (the demo account is created during the test). */
function overrides(state: { account: string; withdrawn: boolean }): MockOverrides {
  const withAccount = <T extends { bidder?: string; holder?: string; funder?: string; requester?: string }>(item: T): T => ({ ...item, ...("bidder" in item ? { bidder: state.account } : {}), ...("holder" in item ? { holder: state.account } : {}), ...("funder" in item ? { funder: state.account } : {}), ...("requester" in item ? { requester: state.account } : {}) });
  return {
    engineView: (method, args) => {
      if (typeof args.account === "string" && args.account.startsWith("rose-demo-")) state.account = args.account;
      switch (method) {
        case "get_portfolio":
          return {
            holdings: HOLDINGS,
            bids: [withAccount(BID)],
            liens_held: [withAccount(LIEN_HELD)],
            lien_shares: [withAccount(LIEN_SHARE)],
            cash: [
              { venue: "Near", amount: state.withdrawn ? "0" : "150000000" },
              { venue: { Base: { token: MOCK.baseTusdc } }, amount: "42000000" },
            ],
          };
        case "get_payouts":
          return Number(args.from_index ?? 0) === 0 ? PAYOUTS.map(withAccount) : [];
        case "get_payout":
          return PAYOUTS.map(withAccount).find((item) => item.id === String(args.payout_id)) ?? null;
        case "storage_balance_of":
          return { total: "5000000000000000000000", available: "2840000000000000000000" };
        case "storage_balance_bounds":
          return { min: "2160000000000000000000", max: null };
        case "get_positions":
          return Number(args.from_index ?? 0) === 0
            ? [
                { position_id: "0", class_id: SEED, source: { BaseStream: { lockup: MOCK.lockup, stream_id: "82" } }, allocation: `50${ONE_E18}`, depositor: "halden.testnet", deposited_at: ns(NOW_SEC - 79 * 86_400), state: "Held" },
                { position_id: "1", class_id: SEED, source: { BaseStream: { lockup: MOCK.lockup, stream_id: "83" } }, allocation: `150${ONE_E18}`, depositor: "tessaro.testnet", deposited_at: ns(NOW_SEC - 78 * 86_400), state: "Held" },
                { position_id: "2", class_id: STRATEGIC, source: { SolanaStream: { metadata: "J2MxStreamMetadata111111111111111111111111111" } }, allocation: "120000000000000", depositor: "varick.testnet", deposited_at: ns(NOW_SEC - 21 * 86_400), state: "Held" },
              ]
            : [];
        case "get_rounds": {
          const filter = args.filter as { creator?: string } | null;
          return filter?.creator ? { rounds: [{ ...ROUND_8, round_id: "1", kind: "Tender", status: "Settled", creator: state.account, budget: "950000000", retire_to: "0x000000000000000000000000000000000000dead" }], next: null } : { rounds: [], next: null };
        }
        case "get_retired_lot":
          return String(args.round_id) === "1" ? { round_id: "1", class_id: SEED, retire_to: "0x000000000000000000000000000000000000dead", units: `100${ONE_E18}`, claimable: `9${ONE_E18}` } : null;
        case "get_round":
          return String(args.round_id) === "8" ? ROUND_8 : null;
        default:
          return undefined;
      }
    },
    nearRequest: (method, params) => {
      if (method === "query" && params.request_type === "view_access_key") {
        return { nonce: 7, permission: "FullAccess", block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
      }
      if (method === "query" && params.request_type === "call_function" && params.method_name === "ft_balance_of") return "150000000";
      if (method === "block") return { header: { height: 276_200_700, hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS", timestamp: NOW_SEC * 1e9, timestamp_nanosec: ns(NOW_SEC) } };
      if (method === "send_tx" || method === "tx") {
        state.withdrawn = true;
        const outcome = { id: "r", outcome: { logs: [`EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"cash_withdrawn","data":{"account":"${state.account}","venue":"Near","amount":"150000000"}}`], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: MOCK.engine, status: { SuccessValue: "" } } };
        return { status: { SuccessValue: "" }, transaction: { hash: OUTCOME_HASH, signer_id: state.account, receiver_id: MOCK.engine, nonce: 8, public_key: "ed25519:11111111111111111111111111111111" }, transaction_outcome: outcome, receipts_outcome: [outcome], final_execution_status: "EXECUTED_OPTIMISTIC" };
      }
      return undefined;
    },
    baseRequest: evmCallRequest(),
    solanaRequest: (method) => (method === "getAccountInfo" ? { context: { slot: 1 }, value: null } : undefined),
  };
}

async function connectNearDemo(page: Page): Promise<string> {
  await page.goto("/app");
  await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
  await page.reload();
  await page.locator("[data-portfolio-connect]").click();
  const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
  await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
  await expect(dialog).toBeHidden();
  const account = await page.evaluate(() => (JSON.parse(localStorage.getItem("rose.demo.near") ?? "{}") as { accountId?: string }).accountId ?? "");
  expect(account).toMatch(/^rose-demo-/);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  return account;
}

test.describe("portfolio", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");
  test.describe.configure({ timeout: 180_000 });

  test("asks for a NEAR wallet, then shows holdings, claims, orders, liens, history and storage", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Connect a NEAR wallet" })).toBeVisible({ timeout: 60_000 });
    await shot(page, "connect");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-portfolio-stats]")).toBeVisible({ timeout: 60_000 });
    const holdings = page.locator("[data-holdings]");
    await expect(holdings.locator("tbody tr")).toHaveCount(2);
    await expect(holdings).toContainText("CINDR");
    await expect(holdings).toContainText("12.5000");
    await holdings.getByRole("button", { name: "Timeline" }).first().click();
    await expect(page.locator("[data-unlock-chart] svg")).toBeVisible();
    await expect(page.locator("[data-unlock-chart]").getByText("cliff")).toBeVisible();
    await shot(page, "loaded");
    const claims = page.locator("[data-claims]");
    await expect(claims.locator("[data-cash]")).toHaveCount(2);
    await expect(claims.locator("[data-token-claim='base']")).toHaveCount(2);
    await expect(claims.locator("[data-token-claim='solana']")).toHaveCount(2);
    await expect(claims.locator("[data-payout='12']")).toHaveAttribute("data-payout-state", "signed");
    await expect(claims.locator("[data-payout='11']")).toHaveAttribute("data-payout-state", "stale");
    await expect(claims.locator("[data-payout='9']")).toHaveAttribute("data-payout-state", "awaiting_gas");
    await expect(claims.getByRole("button", { name: "Submit on Base" })).toBeVisible();
    await expect(page.locator("[data-orders]")).toContainText("#8 Exit");
    await expect(page.locator("[data-orders]").getByRole("link", { name: /#8 Exit/ })).toHaveAttribute("href", "/app/rounds/8");
    await expect(page.locator("[data-lien='4']")).toContainText("3.0000 of 4.0000 delivered");
    await expect(page.locator("[data-lien-share='9']")).toBeVisible();
    await expect(page.locator("[data-history]")).toContainText("Failed: authority signature not produced");
    await expect(page.locator("[data-storage]")).toContainText("Registered");
    expect(errors).toEqual([]);
  });

  test("claims NEAR tUSDC end to end through the demo wallet", async ({ page }) => {
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    const claims = page.locator("[data-claims]");
    await claims.locator("[data-cash='near']").getByRole("button", { name: "Claim" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Claim NEAR tUSDC" });
    await expect(dialog).toContainText("Claimable: 150.0000 tUSDC");
    await shot(page, "claim-dialog");
    await dialog.locator("[data-claim-confirm]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow).toHaveAttribute("data-flow-status", "completed", { timeout: 60_000 });
    await shot(page, "flow-done");
    await expect(flow.locator("[data-step='withdraw']")).toHaveAttribute("data-status", "done");
    await expect(flow.getByRole("link", { name: /near.rocks/ })).toHaveAttribute("href", `https://testnet.near.rocks/tx/${OUTCOME_HASH}`);
    await page.locator("[data-flow-close]").click();
    await expect(claims.locator("[data-cash='near']")).toHaveCount(0, { timeout: 60_000 });
  });

  test("opens the Base token claim with the destination prefilled and the withdrawMax step listed", async ({ page }) => {
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    await page.locator("[data-holdings] tbody tr").first().getByRole("button", { name: "Claim" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: /Claim CINDR on Base Sepolia/ });
    await expect(dialog).toContainText("Claimable: 12.5000 CINDR");
    await expect(dialog.getByRole("textbox", { name: /Destination/ })).toHaveValue("");
    await expect(dialog.locator("[data-claim-confirm]")).toBeDisabled();
    await dialog.getByRole("textbox", { name: /Destination/ }).fill("0x7d4777cfC6ed48061B0BcCae558D29919b412042");
    await dialog.locator("[data-claim-confirm]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow.locator("[data-step='withdraw-max']")).toBeVisible();
    await expect(flow.locator("[data-step='request']")).toBeVisible();
    await expect(flow.locator("[data-step='sign']")).toBeVisible();
    await expect(flow.locator("[data-step='submit']")).toBeVisible();
    await shot(page, "flow-base");
  });
});
