import { expect, test, type Page } from "@playwright/test";
import { collectErrors } from "./fixtures/console";
import { connectDemoWallet, openWalletDrawer } from "./fixtures/wallets";

/**
 * Live smoke test of a deployed build against NEAR testnet, Base Sepolia and Solana devnet: no
 * chain is mocked. Opt-in with `ROSE_LIVE_SMOKE=1`; the engine account is the one the build uses
 * (`NEXT_PUBLIC_ENGINE_ACCOUNT`, loaded from `.env.local` by the config). Runs against any URL:
 *
 *   ROSE_LIVE_SMOKE=1 PLAYWRIGHT_BASE_URL=https://example.vercel.app pnpm exec playwright test e2e/live-smoke.spec.ts
 *
 * Read-only: the demo wallets are created in the browser but no transaction is sent.
 */

const ENGINE = process.env.NEXT_PUBLIC_ENGINE_ACCOUNT ?? "";

/** Every page of the site, including a round detail and a docs page. */
const ROUTES = ["/", "/app", "/app/rounds", "/app/rounds/0", "/app/deposit", "/app/issuer", "/app/advance", "/app/prices", "/docs", "/docs/contracts-and-addresses", "/status"];

async function skipTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("rose.tour.dismissed", "1");
    } catch {
      // Storage blocked: the tour then shows and is dismissed by the tests that need it.
    }
  });
}

test.describe("live smoke", () => {
  test.skip(!process.env.ROSE_LIVE_SMOKE, "set ROSE_LIVE_SMOKE=1 to run against live testnets");
  test.skip(!ENGINE, "the build has no NEXT_PUBLIC_ENGINE_ACCOUNT");
  test.describe.configure({ timeout: 120_000 });

  test("every route renders without a console error", async ({ page }) => {
    await skipTour(page);
    const errors = collectErrors(page);
    for (const route of ROUTES) {
      await page.goto(route);
      await expect(page.locator("body")).not.toContainText("This page couldn’t load");
      await page.waitForLoadState("networkidle");
      expect(errors, `console errors on ${route}`).toEqual([]);
    }
  });

  test("landing: the phrase and the launch button", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/");
    await expect(page).toHaveTitle(/rose/);
    await expect(page.locator("[data-launch]").first()).toHaveAttribute("href", "/app");
    expect(errors).toEqual([]);
  });

  test("docs: the contracts page shows the deployed engine", async ({ page }) => {
    await page.goto("/docs/contracts-and-addresses");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("[data-placeholder='ENGINE_ACCOUNT']").first()).toHaveText(ENGINE);
  });

  test("status: every block reads the live chains", async ({ page }) => {
    await page.goto("/status");
    for (const name of ["Engine account", "Contract versions", "MPC latency", "RoseVault (Base Sepolia)", "Solana devnet", "Test USDC", "Recent ForeignTx verifications"]) {
      const block = page.getByRole("region", { name });
      await expect(block, name).toHaveAttribute("data-status", "ok", { timeout: 45_000 });
    }
    await expect(page.getByRole("region", { name: "Engine account" })).toContainText(ENGINE);
    await expect(page.getByRole("region", { name: "RoseVault (Base Sepolia)" })).toContainText("Signer matches engine");
    await expect(page.getByRole("region", { name: "Contract versions" })).toContainText("v1.signer-prod.testnet");
  });

  test("rounds: the list loads from the engine and a round opens", async ({ page }) => {
    await skipTour(page);
    await page.goto("/app/rounds");
    const cards = page.locator("[data-round-card]");
    await expect(cards.first()).toBeVisible({ timeout: 45_000 });
    const id = await cards.first().getAttribute("data-round-card");
    await cards.first().getByRole("link").first().click();
    await expect(page.locator(`[data-round-detail='${id ?? ""}']`)).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("[data-key-stats]")).toBeVisible();
    await page.locator("[data-tab='details']").click();
    await expect(page.locator("[data-parameters]")).toBeVisible();
  });

  test("rounds: a glossary definition in the round header shows in full", async ({ page, isMobile }) => {
    await skipTour(page);
    await page.goto("/app/rounds/0");
    const term = page.locator("[data-key-stats] [data-term]").first();
    await expect(term).toBeVisible({ timeout: 45_000 });
    if (isMobile) await term.tap();
    else await term.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toBeInViewport({ ratio: 1 });
    const box = await tooltip.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(24);
  });

  test("prices: settled rounds plot a clearing price history", async ({ page }) => {
    await skipTour(page);
    await page.goto("/app/prices");
    await expect(page.locator("[data-markets]")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("img", { name: /Clearing price history/ })).toHaveCount(1);
  });

  test("wallets: the three demo wallets connect and show in the top bar", async ({ page }) => {
    await skipTour(page);
    const errors = collectErrors(page);
    await page.goto("/app");
    for (const network of ["near", "base", "solana"] as const) await connectDemoWallet(page, network);
    const drawer = await openWalletDrawer(page);
    await expect(drawer.getByText("Demo", { exact: true })).toHaveCount(3);
    await expect(drawer).toContainText("rose-demo-");
    expect(errors).toEqual([]);
  });
});
