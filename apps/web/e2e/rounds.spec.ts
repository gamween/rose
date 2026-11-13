import { expect, test, type Page } from "@playwright/test";
import { BYTE_COST, demoWalletScript, mockRounds, ROUNDS_MOCK } from "./fixtures/rounds-mock";

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
    // Newest first: rounds 20 down to 9, then the older ones below #9.
    await expect(cards).toHaveCount(12, { timeout: 20_000 });
    await expect(cards.first()).toHaveAttribute("data-round-card", "20");
    await expect(page.locator("[data-round-card='1']")).toHaveCount(0);
    await expect(page.locator("[data-load-more]")).toHaveText("Load older rounds (before #9)");
    await page.locator("[data-load-more]").click();
    await expect(cards).toHaveCount(20);
    await expect(cards.last()).toHaveAttribute("data-round-card", "1");
    await expect(page.locator("[data-load-more]")).toHaveCount(0);
    await expect(page.locator("[data-round-card='1']")).toContainText("Closes in");
    await expect(page.locator("[data-round-card='1'] [data-round-book] dd")).toHaveText("500.00 USDC escrowed · 100 units locked");
    await expect(page.locator("[data-round-card='2']")).toContainText("Cleared at");
    await expect(page.locator("[data-round-card='3']")).toContainText("No crossing");
    await expect(page.locator("[data-round-card='3']")).not.toContainText("Cleared at");
    await expect(page.locator("[data-round-card='5']")).toContainText("Key requested");

    await page.getByRole("button", { name: "Tender", exact: true }).click();
    await expect(cards).toHaveCount(2, { timeout: 20_000 });
    await expect(cards.first()).toContainText("Budget");
    await page.getByRole("combobox", { name: "Status" }).selectOption("Settled");
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
    await expect(dialog.locator("[data-key-timeout]")).toHaveValue("60");
    await expect(dialog.locator("[data-reveal-window]")).toHaveValue("10");
    await expect(dialog.locator("[data-round-timing]")).toContainText("Key timeout 1 min to 7 d; reveal window 5 min to 7 d.");
    await dialog.locator("[data-reveal-window]").fill("4");
    await expect(dialog.getByRole("alert")).toHaveText("The reveal window must be at least 5 min.");
    await dialog.locator("[data-reveal-window]").fill("1440");
    await dialog.locator("[data-key-timeout]").fill("10081");
    await expect(dialog.getByRole("alert")).toHaveText("The key timeout must be at most 7 d.");
    await dialog.locator("[data-key-timeout]").fill("60");
    await dialog.getByRole("button", { name: "Custom" }).click();
    const far = new Date(Date.now() + 31 * 86_400_000);
    const local = new Date(far.getTime() - far.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await dialog.locator("input[type='datetime-local']").fill(local);
    await expect(dialog.getByRole("alert")).toHaveText("A round closes at most 30 d after it is created: pick an earlier close.");
    await expect(dialog.locator("[data-create-exit-submit]")).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("a settled Tender shows the curves, fills, settlement links and a matching verification", async ({ page }) => {
    const errors = await collectErrors(page);
    await mockRounds(page);
    await page.goto("/app/rounds/2");
    await expect(page.locator("[data-round-detail='2']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-progress] [data-step='settle']")).toHaveAttribute("data-state", "done");
    // A settled round opens on its results; the parameters wait in Details.
    await expect(page.locator("[data-tab='results']")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-parameters]")).toHaveCount(0);
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
    await page.getByRole("button", { name: "Chart view" }).click();
    const ticks = await page.locator("[data-price-tick]").allTextContents();
    expect(ticks.length).toBeGreaterThan(2);
    expect(new Set(ticks).size).toBe(ticks.length);
    await page.locator("[data-tab='details']").click();
    await expect(page).toHaveURL(/#details$/);
    await expect(page.locator("[data-parameters]")).toContainText("400.00 USDC");
    await expect(page.locator("[data-key-release]")).toContainText("5.0 s after the close request");
    await expect(page.locator("[data-settlement]")).toContainText("Claim cash and units in the Portfolio");
    await expect(page.locator("[data-participants]").getByRole("link", { name: /halden\.testnet/ })).toHaveAttribute("href", "https://testnet.near.rocks/account/halden.testnet");
    await expect(page.locator("[data-participants]")).toContainText("ask #0 settled");
    await expect(page.locator("[data-parameters]").getByRole("link", { name: "cindral.testnet" })).toHaveAttribute("href", "https://testnet.near.rocks/account/cindral.testnet");
    // Settled orders lose their ciphertext in the engine (storage refund); the book says so.
    await page.locator("[data-tab='book']").click();
    await expect(page.locator("[data-sealed-book] [data-bid-row='0']")).toContainText("pruned at settlement");
    // The hash keeps the picked tab across a reload.
    await page.locator("[data-tab='details']").click();
    await page.reload();
    await expect(page.locator("[data-parameters]")).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test("a cancelled round shows its refunds, never a clearing at 0.00", async ({ page }) => {
    const errors = await collectErrors(page);
    await mockRounds(page);
    await page.goto("/app/rounds/3");
    await expect(page.locator("[data-round-detail='3']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-fills-summary='cancelled']")).toContainText("Cancelled (no crossing)");
    await expect(page.locator("[data-curves]")).toContainText("The curves never meet");
    await page.locator("[data-tab='overview']").click();
    await expect(page.locator("[data-timeline] [data-step='clear']")).toContainText("no price crossed the book");
    await expect(page.locator("main")).not.toContainText("Cleared at 0.00");
    await expect(page.locator("main")).not.toContainText("P* 0.00");
    expect(errors).toEqual([]);
  });

  test("an Open round past its key timeout offers cancel_no_key, and the cancelled round says so", async ({ page }) => {
    const errors = await collectErrors(page);
    const state = await mockRounds(page);
    const round1 = state.rounds.get(1)!;
    round1.closes_at = Math.floor(Date.now() / 1000) - round1.key_timeout - 60;
    await page.addInitScript(demoWalletScript());
    await page.goto("/app/rounds/1");
    await expect(page.locator("[data-next-action='cancel_no_key']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-next-action='cancel_no_key']")).toHaveText("Key timeout passed without a close");
    await expect(page.locator("[data-action='close']")).toHaveCount(0);
    await page.locator("[data-action='cancel_no_key']").click();
    await expect(page.locator("[data-round-status='Cancelled']")).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => s.method)).toEqual(["cancel_no_key"]);
    await expect(page.locator("[data-fills-summary='cancelled']")).toContainText("Cancelled (no key)");
    await expect(page.locator("[data-verify='cancelled']")).toContainText("Nothing to verify");
    expect(errors).toEqual([]);
  });

  test("the key can be submitted by anyone from the public CKD response", async ({ page }) => {
    const errors = await collectErrors(page);
    const state = await mockRounds(page);
    const now = Math.floor(Date.now() / 1000);
    Object.assign(state.rounds.get(1)!, { phase: "KeyRequested", closes_at: now - 60, close_requested_at: now - 50, keyAfterReads: 1_000_000 });
    await page.addInitScript(demoWalletScript());
    await page.goto("/app/rounds/1");
    await expect(page.locator("[data-next-action='waiting_key']")).toBeVisible({ timeout: 20_000 });
    await page.locator("[data-submit-key-open]").click();
    const input = page.locator("[data-submit-key-input]");
    await input.fill("not a key");
    await expect(page.locator("[data-submit-key]").getByRole("alert")).toContainText("Paste a bls12381g1: key");
    await input.fill("bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL");
    await page.locator("[data-submit-key-run]").click();
    await expect(page.locator("[data-submit-key]").getByRole("alert")).toContainText("does not open round #1", { timeout: 20_000 });
    expect(state.sent).toEqual([]);
    await input.fill(JSON.stringify({ request: { app_id: "305bd2a1" }, response: { big_y: ROUNDS_MOCK.round1BigY, big_c: ROUNDS_MOCK.round1BigC } }));
    await page.locator("[data-submit-key-run]").click();
    await expect(page.locator("[data-next-action='finalize']")).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => [s.method, s.args.key])).toEqual([["submit_key", ROUNDS_MOCK.round1Key]]);
    await page.locator("[data-tab='details']").click();
    await expect(page.locator("[data-key-release]")).toContainText("submitted by a participant");
    expect(errors).toEqual([]);
  });

  test("an Advance holder's reserve seals exactly the claim, and a Tender issuer gets no ask form", async ({ page }) => {
    const errors = await collectErrors(page);
    const state = await mockRounds(page);
    Object.assign(state.rounds.get(4)!, { creator: ROUNDS_MOCK.demoAccount, bids: [] });
    state.cash = 50n * 1_000_000n;
    const now = Math.floor(Date.now() / 1000);
    Object.assign(state.rounds.get(7)!, { kind: "Tender", creator: ROUNDS_MOCK.demoAccount, opens_at: now - 60, budget: 100n * 1_000_000n, issuer_escrow: 100_300_000n });
    await page.addInitScript(demoWalletScript());
    await page.goto("/app/rounds/4");
    const form = page.locator("[data-order-form]");
    await expect(form.getByRole("heading", { name: "Place your reserve" })).toBeVisible({ timeout: 20_000 });
    const claim = form.locator("[data-fixed-claim]");
    await expect(claim).toHaveValue("100");
    await expect(claim).toHaveAttribute("readonly", "");
    await expect(form).toContainText("Fixed to the claim K");
    await form.locator("[data-order-price]").fill("10");
    await expect(form.locator("[data-order-preview]")).toContainText("12.00 USDC");
    await expect(form.locator("[data-order-submit]")).toBeEnabled({ timeout: 20_000 });
    await form.locator("[data-order-submit]").click();
    await expect(page.getByRole("status").filter({ hasText: "Sealed ask #0 placed" })).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => [s.method, s.args.units])).toEqual([["place_ask", (100n * 10n ** 18n).toString()]]);

    await page.goto("/app/rounds/7");
    await expect(page.locator("[data-order-form='issuer']")).toContainText("You are the buyer of this Tender", { timeout: 20_000 });
    await expect(page.locator("[data-order-submit]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("every lifecycle state has its next action", async ({ page }) => {
    await mockRounds(page);
    await page.goto("/app/rounds/5");
    await expect(page.locator("[data-next-action='waiting_key']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-round-action]")).toContainText("cancel possible in");
    await page.goto("/app/rounds/6");
    await expect(page.locator("[data-next-action='finalize']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-finalize]")).toContainText("2 / 4");
    await expect(page.locator("[data-finalize]")).toContainText("0.0132 per order");
    await page.goto("/app/rounds/3");
    await expect(page.locator("[data-next-action='done']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-progress] [data-step='clear']")).toHaveAttribute("data-state", "failed");
    await page.goto("/app/rounds/7");
    await expect(page.locator("[data-next-action='wait_open']")).toBeVisible({ timeout: 20_000 });
    await page.goto("/app/rounds/999");
    await expect(page.getByText("Round #999 does not exist")).toBeVisible({ timeout: 20_000 });
    await page.goto("/app/rounds/abc");
    await expect(page.getByText("Not a round id")).toBeVisible();
  });

  test("the order form asks a visitor without a wallet for NEAR, on the NEAR wallets", async ({ page }) => {
    await mockRounds(page);
    await page.goto("/app/rounds/1");
    const form = page.locator("[data-order-form]");
    await expect(form.locator("[data-connect-prompt='near']")).toBeVisible({ timeout: 20_000 });
    await form.locator("[data-connect-prompt='near']").click();
    const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
    await expect(dialog.locator("[data-wallet-step='near']")).toBeVisible();
    await dialog.locator("[data-demo-wallet]").click();
    await expect(dialog).toBeHidden();
    await expect(form.locator("[data-connect-prompt='near']")).toBeHidden();
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
    await expect(form.locator("[data-storage-notice='register']")).toContainText("storage deposit of 0.00619 NEAR", { timeout: 20_000 });
    await form.locator("[data-deposit-near]").click();
    await expect(page.getByRole("status").filter({ hasText: "credited to your cash" })).toBeVisible({ timeout: 20_000 });
    await expect(form).not.toContainText("Cash short", { timeout: 20_000 });
    await expect(form.locator("[data-order-preview]")).not.toContainText("NEP-145");
    await expect(form.locator("[data-order-submit]")).toBeEnabled({ timeout: 20_000 });
    await expect(form.locator("[data-order-submit]")).toHaveText("Seal and place bid");
    await form.locator("[data-order-submit]").click();
    await expect(page.getByRole("status").filter({ hasText: "Sealed bid #2 placed" })).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => s.method)).toEqual(["storage_deposit", "ft_transfer_call", "place_bid"]);
    expect(state.sent[0]?.deposit).toBe(619n * BYTE_COST);
    const mine = page.locator("[data-my-order='2']");
    await page.locator("[data-tab='mine']").click();
    await expect(mine).toContainText("20 @ 7.50 USDC", { timeout: 20_000 });
    await page.locator("[data-tab='book']").click();
    await expect(page.locator("[data-sealed-book] tbody tr")).toHaveCount(3);

    await expect(page.locator("[data-next-action='close']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-round-action]")).toContainText("80 Tgas prepaid");
    await page.locator("[data-action='close']").click();
    await expect(page.locator("[data-next-action='finalize']")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-tab='details']").click();
    await expect(page.locator("[data-key-release]")).toContainText(ROUNDS_MOCK.round1Key);
    await page.locator("[data-finalize-run]").click();
    // A second click where "Open every order" sat lands on the disabled run button, never on a pause.
    await page.locator("[data-finalize-run]").click({ force: true });
    await expect(page.locator("[data-open-status='opened']")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator("[data-next-action='clear']")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-action='clear']").click();
    await expect(page.locator("[data-round-status='Settled']")).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-tab='results']").click();
    const fills = page.locator("[data-fills]");
    await expect(fills).toContainText("Cleared at 7.00 USDC");
    await expect(fills.locator("tbody tr")).toHaveCount(3);
    await fills.locator("[data-settle-all]").click();
    await expect(fills).toContainText("all settled", { timeout: 60_000 });
    await expect(page.locator("[data-next-action='done']")).toBeVisible({ timeout: 20_000 });
    await page.locator("[data-verify-run]").click();
    await expect(page.locator("[data-verify-status='match']")).toBeVisible();
    await page.locator("[data-tab='mine']").click();
    await expect(mine).toContainText("filled 20");
    await page.locator("[data-tab='details']").click();
    await expect(page.locator("[data-receipts] li")).toHaveCount(11);
    expect(state.sent.map((s) => s.method)).toEqual(["storage_deposit", "ft_transfer_call", "place_bid", "close", "open_bid", "open_bid", "open_bid", "clear", "settle_bid", "settle_bid", "settle_bid"]);
    expect(errors).toEqual([]);
  });

  test("an account holding other classes tops up its storage from the deposit and bid buttons", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await collectErrors(page);
    const state = await mockRounds(page);
    state.otherHoldings = { ["b".repeat(64)]: 5n * 10n ** 18n, ["c".repeat(64)]: 7n * 10n ** 18n };
    state.storage = (137n + 2n * 310n) * BYTE_COST;
    await page.addInitScript(demoWalletScript());
    await page.goto("/app/rounds/1");
    await expect(page.locator("[data-next-action='bid']")).toBeVisible({ timeout: 20_000 });
    const form = page.locator("[data-order-form]");
    await form.getByRole("tab", { name: "Bid (buy units)" }).click();
    await expect(form).toContainText("At most 400 per bid");
    await form.locator("[data-order-quantity]").fill("401");
    await expect(form.getByRole("alert")).toContainText("At most 400 units (the class supply when the round was created)");
    await form.locator("[data-order-quantity]").fill("300");
    await form.locator("[data-order-price]").fill("5");
    await form.locator("[data-show-deposit]").click();
    const amount = form.getByRole("textbox", { name: "Amount to deposit" });
    await expect(amount).toHaveValue("1139.65875");
    await expect(form.locator("[data-cash-deposit]").getByRole("alert")).toHaveText("Not enough tUSDC in the wallet: mint some with Get test funds, then retry.");
    await form.locator("[data-order-quantity]").fill("10");
    await expect(amount).toHaveValue("38.6125");
    await expect(form.locator("[data-storage-notice='top_up']")).toContainText("storage top-up of 0.00172 NEAR", { timeout: 20_000 });
    await form.locator("[data-deposit-near]").click();
    await expect(page.getByRole("status").filter({ hasText: "credited to your cash" })).toBeVisible({ timeout: 20_000 });
    await expect(form.locator("[data-order-preview]")).toContainText("Engine storage top-up (NEP-145)", { timeout: 20_000 });
    await expect(form.locator("[data-order-preview]")).toContainText("0.00310 NEAR");
    await expect(form.locator("[data-order-submit]")).toHaveText("Add storage, seal and place bid");
    await form.locator("[data-order-submit]").click();
    await expect(page.getByRole("status").filter({ hasText: "Sealed bid #2 placed" })).toBeVisible({ timeout: 30_000 });
    expect(state.sent.map((s) => [s.method, s.deposit])).toEqual([
      ["storage_deposit", 172n * BYTE_COST],
      ["ft_transfer_call", 1n],
      ["storage_deposit", 310n * BYTE_COST],
      ["place_bid", 20_000_000_000_000_000_000_000n],
    ]);
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
