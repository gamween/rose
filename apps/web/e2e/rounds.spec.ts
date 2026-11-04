import { expect, test, type Page } from "@playwright/test";
import { demoWalletScript, mockRounds, ROUNDS_MOCK } from "./fixtures/rounds-mock";

/**
 * Rounds list and round detail (spec 8.3). The mocked suite needs a build whose engine account
 * is the live CKD spike account, because the fixture seals orders to its round-1 identity and
 * the browser opens them with that round's public key; it runs the whole lifecycle from a bid
 * placed with the in-app demo wallet to the claim, on mocked RPC responses.
 */

const MOCK_ENGINE_BUILD = process.env.NEXT_PUBLIC_ENGINE_ACCOUNT === ROUNDS_MOCK.engine;

async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|ERR_INTERNET|net::ERR|Failed to fetch|429|Rate limit/i.test(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("rounds without a deployed engine", () => {
  test.skip(Boolean(process.env.NEXT_PUBLIC_ENGINE_ACCOUNT), "NEXT_PUBLIC_ENGINE_ACCOUNT is set for this build");

  test("list and detail show the not-deployed state with a way forward", async ({ page }) => {
    const errors = await collectErrors(page);
    await page.goto("/app/rounds");
    await expect(page.getByRole("heading", { name: "Engine not deployed yet" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Deployment status" })).toHaveAttribute("href", "/status");
    await expect(page.getByRole("button", { name: "Create Exit round" })).toBeDisabled();
    await page.goto("/app/rounds/1");
    await expect(page.getByRole("heading", { name: "Engine not deployed yet" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("rounds with a mocked engine", () => {
  test.skip(!MOCK_ENGINE_BUILD, `NEXT_PUBLIC_ENGINE_ACCOUNT must be ${ROUNDS_MOCK.engine} for this suite`);

  test("the list filters, paginates and opens the Create Exit form", async ({ page }) => {
    const errors = await collectErrors(page);
    await mockRounds(page);
    await page.goto("/app/rounds");
    const cards = page.locator("[data-round-card]");
    await expect(cards).toHaveCount(12, { timeout: 20_000 });
    await expect(page.locator("[data-round-card='1']")).toContainText("Closes in");
    await expect(page.locator("[data-round-card='1']")).toContainText("500.00 USDC escrowed");
    await expect(page.locator("[data-round-card='2']")).toContainText("Cleared at");
    await expect(page.locator("[data-round-card='5']")).toContainText("Key requested");
    await page.locator("[data-load-more]").click();
    await expect(cards).toHaveCount(20);
    await expect(page.locator("[data-load-more]")).toHaveCount(0);

    await page.getByRole("button", { name: "Tender", exact: true }).click();
    await expect(cards).toHaveCount(2, { timeout: 20_000 });
    await expect(cards.first()).toContainText("Budget");
    await page.getByRole("button", { name: "Settled", exact: true }).click();
    await expect(cards).toHaveCount(1);
    await page.getByRole("button", { name: "Advance", exact: true }).click();
    await expect(page.getByText("No round matches these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(cards).toHaveCount(20);

    await page.locator("[data-create-exit]").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("0.05 NEAR");
    await expect(dialog.getByRole("combobox").first()).toContainText("CINDR");
    await dialog.getByPlaceholder("8.50").fill("9");
    await expect(dialog.locator("[data-create-exit-submit]")).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("a settled Tender shows the curves, fills, settlement links and a matching verification", async ({ page }) => {
    const errors = await collectErrors(page);
    await mockRounds(page);
    await page.goto("/app/rounds/2");
    await expect(page.locator("[data-round-detail='2']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-parameters]")).toContainText("400.00 USDC");
    await expect(page.locator("[data-timeline] [data-step='settle']")).toHaveAttribute("data-state", "done");
    await expect(page.locator("[data-key-release]")).toContainText("5.0 s after the close request");
    await expect(page.locator("[data-clearing-chart]")).toBeVisible();
    await expect(page.getByRole("img", { name: /Issuer can afford and Supply/ })).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page.locator("[data-clearing-chart] table")).toContainText("P* here");
    const fills = page.locator("[data-fills]");
    await expect(fills.locator("tbody tr")).toHaveCount(3);
    await expect(fills).toContainText("8.00 USDC");
    await expect(fills).toContainText("refunded");
    await expect(fills.locator("[data-settle='2']")).toBeDisabled();
    await page.locator("[data-verify-run]").click();
    await expect(page.locator("[data-verify-status='match']")).toBeVisible();
    await expect(page.locator("[data-settlement]")).toContainText("Claim cash and units in the Portfolio");
    expect(errors).toEqual([]);
  });

  test("every lifecycle state has its next action", async ({ page }) => {
    await mockRounds(page);
    await page.goto("/app/rounds/5");
    await expect(page.locator("[data-next-action='waiting_key']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-timeline]")).toContainText("cancel possible in");
    await page.goto("/app/rounds/6");
    await expect(page.locator("[data-next-action='finalize']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-finalize]")).toContainText("2 / 4");
    await expect(page.locator("[data-finalize]")).toContainText("0.0132 per order");
    await page.goto("/app/rounds/3");
    await expect(page.locator("[data-next-action='done']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-timeline] [data-step='clear']")).toHaveAttribute("data-state", "failed");
    await page.goto("/app/rounds/7");
    await expect(page.locator("[data-next-action='wait_open']")).toBeVisible({ timeout: 20_000 });
    await page.goto("/app/rounds/999");
    await expect(page.getByText("Round #999 does not exist")).toBeVisible({ timeout: 20_000 });
    await page.goto("/app/rounds/abc");
    await expect(page.getByText("Not a round id")).toBeVisible();
  });

  test("full round from a sealed bid to the claim with the demo wallet", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await collectErrors(page);
    const state = await mockRounds(page);
    await page.addInitScript(demoWalletScript());
    await page.goto("/app/rounds/1");
    await expect(page.locator("[data-next-action='bid']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-sealed-book] tbody tr")).toHaveCount(2);

    const form = page.locator("[data-order-form]");
    await form.getByRole("tab", { name: "Bid (buy units)" }).click();
    await form.locator("[data-order-quantity]").fill("20");
    await form.locator("[data-order-price]").fill("7.5");
    const preview = form.locator("[data-order-preview]");
    await expect(preview).toContainText("112.50 USDC");
    await expect(preview).toContainText("0.3375 USDC");
    await expect(preview).toContainText("113.965875 USDC");
    await expect(form).toContainText("Cash short by 113.965875 USDC");

    await form.locator("[data-show-deposit]").click();
    await form.locator("[data-deposit-near]").click();
    await expect(page.getByRole("status").filter({ hasText: "credited to your cash" })).toBeVisible({ timeout: 20_000 });
    await expect(form).not.toContainText("Cash short", { timeout: 20_000 });
    await form.locator("[data-register]").click();
    await expect(page.getByRole("status").filter({ hasText: "Account registered" })).toBeVisible({ timeout: 20_000 });
    await expect(form.locator("[data-order-submit]")).toBeEnabled({ timeout: 20_000 });
    await form.locator("[data-order-submit]").click();
    await expect(page.getByRole("status").filter({ hasText: "Sealed bid #2 placed" })).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => s.method)).toEqual(["ft_transfer_call", "storage_deposit", "place_bid"]);
    const mine = page.locator("[data-my-order='2']");
    await expect(mine).toContainText("20 @ 7.50 USDC", { timeout: 20_000 });
    await expect(page.locator("[data-sealed-book] tbody tr")).toHaveCount(3);

    await expect(page.locator("[data-next-action='close']")).toBeVisible({ timeout: 20_000 });
    await page.locator("[data-action='close']").click();
    await expect(page.locator("[data-next-action='finalize']")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-key-release]")).toContainText(ROUNDS_MOCK.round1Key);
    await page.locator("[data-action='finalize']").click();
    await expect(page.locator("[data-open-status='opened']")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator("[data-next-action='clear']")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-action='clear']").click();
    await expect(page.locator("[data-round-status='Settled']")).toBeVisible({ timeout: 30_000 });
    const fills = page.locator("[data-fills]");
    await expect(fills).toContainText("Cleared at 7.00 USDC");
    await expect(fills.locator("tbody tr")).toHaveCount(3);
    await expect(mine).toContainText("filled 20");
    await fills.locator("[data-settle-all]").click();
    await expect(fills).toContainText("all settled", { timeout: 60_000 });
    await expect(page.locator("[data-next-action='done']")).toBeVisible({ timeout: 20_000 });
    await page.locator("[data-verify-run]").click();
    await expect(page.locator("[data-verify-status='match']")).toBeVisible();
    await expect(page.locator("[data-receipts] li")).toHaveCount(11);
    expect(state.sent.map((s) => s.method)).toEqual(["ft_transfer_call", "storage_deposit", "place_bid", "close", "open_bid", "open_bid", "open_bid", "clear", "settle_bid", "settle_bid", "settle_bid"]);
    expect(errors).toEqual([]);
  });

  test("a configured account without a contract shows the not-deployed state", async ({ page }) => {
    await page.route("https://test.rpc.fastnear.com/**", async (route) => {
      const request = route.request().postDataJSON() as { id: string };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error", data: "account does not exist" } }) });
    });
    await page.goto("/app/rounds");
    await expect(page.getByRole("heading", { name: "Engine not deployed yet" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("does not exist on NEAR testnet")).toBeVisible();
  });
});
