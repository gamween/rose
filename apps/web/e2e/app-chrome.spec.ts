import { expect, test } from "@playwright/test";
import { collectErrors } from "./fixtures/console";
import { runPaletteCommand } from "./fixtures/chrome";
import { connectDemoWallet, openWalletDrawer } from "./fixtures/wallets";

/**
 * Global app chrome (spec 8.3 "Global") with the in-app demo wallets. Nothing here needs a
 * deployed contract: the demo wallets live in the browser and the panels show their "not
 * deployed" states when the addresses are not configured.
 */

const APP_PAGE = "/app/prices";

test.describe("app chrome", () => {
  test("shows the tour on the first visit, remembers its dismissal and opens from the palette again", async ({ page }) => {
    await page.goto(APP_PAGE);
    const next = page.locator("[data-tour-next]");
    await expect(next).toBeVisible();
    await expect(page.locator("[data-tour-step='0']")).toBeVisible();
    await next.click();
    await expect(page.locator("[data-tour-step='1']")).toBeVisible();
    await page.getByRole("button", { name: "Skip tour" }).click();
    await expect(next).toBeHidden();
    await page.reload();
    await expect(page.getByRole("link", { name: "rose home" })).toBeVisible();
    await expect(next).toBeHidden();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
    const input = page.locator("[data-palette-input]");
    await expect(input).toBeFocused();
    await input.fill("tour");
    await page.keyboard.press("Enter");
    await expect(next).toBeVisible();
  });

  test("connects the three demo wallets and shows them with balances in the top bar", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(APP_PAGE);
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await connectDemoWallet(page, "near");
    await expect(page.getByText("NEAR demo wallet ready")).toBeVisible();
    await connectDemoWallet(page, "base");
    await expect(page.getByText("EVM demo wallet ready")).toBeVisible();
    await connectDemoWallet(page, "solana");
    await expect(page.getByText("Solana demo wallet ready")).toBeVisible();
    const walletButton = page.locator("[data-wallets]");
    await expect(walletButton.locator("[data-logo-stack] > span")).toHaveCount(3);
    await walletButton.click();
    const menu = page.locator("[data-wallet-menu]");
    if (await menu.isVisible()) {
      await expect(walletButton).toContainText("rose-demo-");
      await expect(menu.locator("[data-wallet-row]")).toHaveCount(3);
      await expect(menu.locator("[data-wallet-row='base']")).toContainText("0x");
      await expect(menu.locator("[data-add-network]")).toHaveCount(0);
      await menu.locator("[data-activity]").click();
      await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
      await page.keyboard.press("Escape");
      await walletButton.click();
      await menu.locator("[data-get-funds]").click();
      await expect(page.getByRole("dialog", { name: "Get test funds" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    } else {
      await page.keyboard.press("Escape");
    }
    const drawer = await openWalletDrawer(page);
    await expect(drawer.getByText("Demo", { exact: true })).toHaveCount(3);
    await expect(drawer.getByRole("button", { name: "Export demo key" })).toHaveCount(3);
    await expect(drawer.getByText("Account not created on testnet yet")).toBeVisible();
    await page.reload();
    await expect((await openWalletDrawer(page)).getByText("Demo", { exact: true })).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test("opens the Get test funds panel with every action wired and the deployment states explained", async ({ page }) => {
    await page.goto(APP_PAGE);
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await expect(page.locator("[data-testnet-banner]")).toHaveCount(0);
    await runPaletteCommand(page, "test funds");
    const drawer = page.getByRole("dialog", { name: "Get test funds" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("Create the demo account with test NEAR")).toBeVisible();
    await expect(drawer.getByText("Mint 1,000 tUSDC on NEAR")).toBeVisible();
    await expect(drawer.getByText(/^Send .* ETH for gas$/)).toBeVisible();
    await expect(drawer.getByText("Mint 1,000 tUSDC on Base")).toBeVisible();
    await expect(drawer.getByText("Mint me a demo vesting position")).toBeVisible();
    await expect(drawer.getByText(/^Send .* SOL$/)).toBeVisible();
    await expect(drawer.getByText("Create a demo Streamflow position")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Run" })).toHaveCount(7);
    await expect(drawer.getByText(/Faucet limits: 1 request per address/)).toBeVisible();
    await drawer.getByRole("button", { name: /Connect a NEAR testnet wallet/ }).click();
    await expect(page.getByRole("dialog", { name: /Connect a wallet/ })).toBeVisible();
  });

  test("Enter runs the highlighted palette command, in the order the palette shows them", async ({ page }) => {
    await page.goto(APP_PAGE);
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
    const input = page.locator("[data-palette-input]");
    await expect(input).toBeFocused();
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).toContainText("Connect a wallet");
    await expect(input).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id")) ?? "");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(2)).toContainText("Open the activity feed");
    await expect(input).toHaveAttribute("aria-activedescendant", (await options.nth(2).getAttribute("id")) ?? "");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await expect(page).toHaveURL(/\/app\/prices$/);
  });

  test("the mobile menu opens the test funds, the activity feed and the command palette", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the top bar and the wallet menu cover wider screens");
    await page.goto(APP_PAGE);
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("[data-menu-action='funds']").click();
    await expect(page.getByRole("dialog", { name: "Get test funds" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("[data-menu-action='activity']").click();
    await expect(page.getByRole("dialog", { name: "Activity" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.locator("[data-menu-action='palette']").click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await page.locator("[data-palette-input]").fill("rounds");
    await page.keyboard.press("Enter");
    await page.waitForURL("**/app/rounds");
  });

  test("opens the activity feed and the command palette navigation works", async ({ page }) => {
    await page.goto(APP_PAGE);
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await runPaletteCommand(page, "activity");
    const feed = page.getByRole("dialog", { name: "Activity" });
    await expect(feed).toBeVisible();
    // A live engine shows its latest events (any kind); a fresh or missing one shows its empty state.
    await expect(feed.locator("[data-activity-feed] li").or(feed.getByText(/Engine not deployed yet|No activity yet/)).first()).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
    await page.locator("[data-palette-input]").fill("docs");
    await page.keyboard.press("Enter");
    await page.waitForURL("**/docs");
  });

  test("an unknown URL answers 404 with the site chrome and the ways back", async ({ page }) => {
    // The document itself answers 404, which the console reports as a failed resource: only page errors count here.
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto("/this-page-does-not-exist");
    expect(response?.status()).toBe(404);
    const main = page.locator("[data-not-found]");
    await expect(main.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Back to the app" })).toHaveAttribute("href", "/app");
    await expect(main.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
    await expect(main.getByRole("link", { name: "Status" })).toHaveAttribute("href", "/status");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(7, 6, 5)");
    await main.getByRole("link", { name: "Back to the app" }).click();
    await page.waitForURL("**/app");
    expect(errors).toEqual([]);
  });
});
