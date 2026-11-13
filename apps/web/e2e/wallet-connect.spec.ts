import { expect, test } from "@playwright/test";
import { collectErrors } from "./fixtures/console";

/**
 * The connect modal asks for the network first, then the wallet. The top-bar Connect button opens
 * the network choice; every network-specific entry point opens straight on that network's
 * wallets, every time it opens (the modal stays mounted between openings).
 */

test.describe("connect modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
  });

  test("the Connect button asks for the network, then lists its wallets with a way back", async ({ page }) => {
    const errors = collectErrors(page);
    const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
    await page.locator("[data-connect]").click();
    await expect(dialog.locator("[data-network]")).toHaveCount(3);
    await expect(dialog.locator("[data-network='near']")).toContainText("Required for trading");
    await expect(dialog.locator("[data-network='base']")).not.toContainText("Required for trading");
    for (const network of ["base", "solana", "near"] as const) {
      await dialog.locator(`[data-network='${network}']`).click();
      const step = dialog.locator(`[data-wallet-step='${network}']`);
      await expect(step).toBeVisible();
      await expect(step.locator("[data-demo-wallet]")).toContainText("Demo");
      await dialog.getByRole("button", { name: "Back to networks" }).click();
      await expect(dialog.locator("[data-network-step]")).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.locator("[data-connect]").click();
    await expect(dialog.locator("[data-network-step]")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the portfolio's Connect NEAR opens the NEAR wallets every time", async ({ page }) => {
    test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");
    const errors = collectErrors(page);
    const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.locator("[data-portfolio-connect]").click();
      await expect(dialog.locator("[data-wallet-step='near']")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });

  test("the Get test funds panel opens the Base and Solana wallets", async ({ page }) => {
    for (const [label, network] of [
      ["Connect a Base Sepolia wallet", "base"],
      ["Connect a Solana devnet wallet", "solana"],
    ] as const) {
      await page.locator("[data-get-funds]").click();
      const drawer = page.getByRole("dialog", { name: "Get test funds" });
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button", { name: label }).first().click();
      const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
      await expect(dialog.locator(`[data-wallet-step='${network}']`)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
});
