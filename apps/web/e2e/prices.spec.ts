import { expect, test } from "@playwright/test";

test.describe("prices", () => {
  test("renders the page, settles into a data, empty or not-deployed state, and explains its methodology", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/app/prices");
    await expect(page.getByRole("heading", { level: 1, name: "Prices" })).toBeVisible();
    await expect(page).toHaveTitle("Prices · rose");
    const main = page.getByRole("main");
    await expect(main).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
    const outcome = page.getByText(/Protocol not deployed yet|No clearing price yet|Could not read the engine|Clearing price history per class/);
    await expect(outcome.first()).toBeVisible();
    if (await page.getByRole("heading", { name: "Clearing price history per class" }).isVisible()) {
      const charts = page.getByRole("img", { name: /Clearing price history/ });
      expect(await charts.count()).toBeGreaterThan(0);
      await expect(page.getByRole("img", { name: /remaining lock time/ })).toBeVisible();
      await page.getByText("Table view").first().click();
      await expect(page.locator("table").first()).toBeVisible();
      await charts.first().locator("a").first().focus();
      await expect(page.getByRole("status")).toContainText("USDC per locked token");
    }
    if (await page.getByText("Could not read the engine").isVisible()) {
      await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "Methodology" })).toBeVisible();
    await expect(page.getByText(/discount to the issuer.s declaration/)).toBeVisible();
    await expect(page.getByRole("link", { name: "clearing rules" })).toHaveAttribute("href", "/docs/clearing-rules");
    expect(errors).toEqual([]);
  });
});
