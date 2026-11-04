import { expect, test } from "@playwright/test";
import { MOCK, mockChains } from "./fixtures/engine-mock";

/**
 * The chain reads are routed to a fixture (a deployed, keyless engine with settled rounds), so
 * the charts and the live blocks are exercised deterministically. The pages only read the engine
 * when a build has NEXT_PUBLIC_ENGINE_ACCOUNT set, so these tests skip otherwise.
 */
test.describe("pages with a deployed engine (mocked chain reads)", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");

  test.beforeEach(async ({ page }) => {
    // These pages are under test, not the first-visit tour (app-chrome covers it): it would take the focus.
    await page.addInitScript(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await mockChains(page);
  });

  test("prices: per-class history, scatter, declared-reference discount, tooltip and table twin", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/app/prices");
    await expect(page.getByRole("heading", { name: "Clearing price history per class" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /CINDR/ })).toHaveAttribute("aria-pressed", "true");
    const charts = page.getByRole("img", { name: /Clearing price history/ });
    // Seed (Tender + Exit), KOL per locked token (Exit #4) and KOL per claimed token (Advance #6): never one line for both units.
    await expect(charts).toHaveCount(3);
    await expect(page.locator("[data-price-series='claimed']")).toHaveCount(1);
    await expect(page.locator("[data-price-series='claimed']")).toContainText("USDC per claimed token at settlement");
    await expect(page.locator("[data-price-series='claimed']")).toContainText("· Advance");
    await expect(page.locator("[data-price-series='locked']").first()).toContainText("USDC per locked token at settlement");
    await expect(page.getByRole("img", { name: /remaining lock/ })).toBeVisible();
    await expect(page.locator("[data-advance-note]")).toContainText("1 Advance round is left out");
    await expect(page.getByRole("img", { name: /remaining lock/ })).toHaveAttribute("aria-label", /5 settled rounds/);
    // The declared references come from get_rounds (string ids) and match the numeric price-history ids.
    await expect(page.getByText("Issuer-declared reference (Tender)")).toBeVisible();
    await charts.first().getByRole("link", { name: /^Round 7:/ }).focus();
    const tooltip = page.getByRole("status");
    await expect(tooltip).toContainText("8.1000");
    await expect(tooltip).toContainText("discount to declared reference");
    await expect(tooltip).toContainText("14.7%");
    await page.getByText("Table view").first().click();
    const table = page.locator("table").first();
    await expect(table.locator("tbody tr")).toHaveCount(4);
    await expect(table).toContainText("10.0000");
    await page.getByRole("button", { name: /Solana/ }).click();
    await expect(page.getByRole("img", { name: /Clearing price history/ })).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("status: keyless engine, versions, latency from events, vault signer check, balances and verifications", async ({ page }) => {
    await page.goto("/status");
    const engine = page.getByRole("region", { name: "Engine account" });
    await expect(engine).toHaveAttribute("data-status", "ok", { timeout: 20_000 });
    await expect(engine.getByText("Keyless", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Contract versions" })).toContainText(MOCK.codeHash);
    const latency = page.getByRole("region", { name: "MPC latency" });
    await expect(latency).toContainText("4 measured");
    await expect(latency).toContainText("median 5.0 s");
    await expect(latency).toContainText("#8 since");
    await expect(latency.getByRole("link", { name: "#3" })).toHaveAttribute("href", "/app/rounds/3");
    const vault = page.getByRole("region", { name: "RoseVault (Base Sepolia)" });
    await expect(vault.getByText("Signer matches engine")).toBeVisible();
    await expect(vault.getByRole("link", { name: MOCK.vault })).toHaveAttribute("href", `https://sepolia.basescan.org/address/${MOCK.vault}`);
    const solana = page.getByRole("region", { name: "Solana devnet" });
    await expect(solana).toContainText("9.6471 SOL");
    await expect(page.getByRole("region", { name: "Test USDC" })).toContainText("10,000.00 tUSDC");
    const verifications = page.getByRole("region", { name: "Recent ForeignTx verifications" });
    await expect(verifications.locator("tbody tr")).toHaveCount(3);
    await expect(verifications).toContainText("150,000.00");
  });

  test("docs: the contracts page shows the deployed addresses", async ({ page }) => {
    await page.goto("/docs/contracts-and-addresses");
    await expect(page.locator("[data-placeholder='ENGINE_ACCOUNT']")).toHaveText(process.env.NEXT_PUBLIC_ENGINE_ACCOUNT!);
  });
});
