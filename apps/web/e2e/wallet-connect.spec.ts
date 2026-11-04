import { expect, test } from "@playwright/test";
import { collectErrors } from "./fixtures/console";

/**
 * Every chain-specific "Connect" entry point opens the connect modal on that chain's tab, every
 * time it opens (the modal stays mounted between openings).
 */

test.describe("connect modal", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
  });

  test("the wallet summary cards open the matching chain tab", async ({ page }) => {
    const errors = collectErrors(page);
    const cards = page.locator("[data-wallet-summary]");
    const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
    const expectations: [number, string][] = [
      [2, "Solana"],
      [1, "Base"],
      [0, "NEAR"],
      [1, "Base"],
    ];
    for (const [index, tab] of expectations) {
      await cards.getByRole("button", { name: "Connect", exact: true }).nth(index).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("tab", { selected: true })).toHaveText(tab);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });

  test("the Get test funds panel opens the Base and Solana tabs", async ({ page }) => {
    for (const [label, tab] of [
      ["Connect a Base Sepolia wallet", "Base"],
      ["Connect a Solana devnet wallet", "Solana"],
    ] as const) {
      await page.locator("[data-get-funds]").click();
      const drawer = page.getByRole("dialog", { name: "Get test funds" });
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button", { name: label }).first().click();
      const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("tab", { selected: true })).toHaveText(tab);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });
});
