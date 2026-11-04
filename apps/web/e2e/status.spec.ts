import { expect, test } from "@playwright/test";

const BLOCKS = ["Engine account", "Contract versions", "MPC latency", "RoseVault (Base Sepolia)", "Solana devnet", "Test USDC", "Recent ForeignTx verifications"];

test.describe("status", () => {
  test("renders every block with a settled state and a visible refresh timestamp", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/status");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Status");
    await expect(page).toHaveTitle("Status · rose");
    for (const name of BLOCKS) {
      const block = page.getByRole("region", { name });
      await expect(block).toBeVisible();
      await expect(block).not.toHaveAttribute("data-status", "loading", { timeout: 30_000 });
      const status = await block.getAttribute("data-status");
      expect(["ok", "not_deployed", "error"]).toContain(status);
      if (status === "error") await expect(block.getByRole("button", { name: "Retry" })).toBeVisible();
      if (status === "not_deployed") await expect(block.getByText("Not deployed yet")).toBeVisible();
    }
    await expect(page.getByText(/Refreshed at/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("reads the MPC contract version and tUSDC metadata live", async ({ page }) => {
    await page.goto("/status");
    const versions = page.getByRole("region", { name: "Contract versions" });
    await expect(versions).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
    await expect(versions.getByText(/^\d+\.\d+\.\d+$/)).toBeVisible();
    const tokens = page.getByRole("region", { name: "Test USDC" });
    await expect(tokens).toHaveAttribute("data-status", "ok", { timeout: 30_000 });
    await expect(tokens.getByRole("link", { name: "tusdc.rose-app.testnet" })).toHaveAttribute("href", "https://testnet.near.rocks/account/tusdc.rose-app.testnet");
    await expect(tokens.getByText(/tUSDC/).first()).toBeVisible();
  });

  test("shows the raw access key list when the engine is deployed, or a clear not-deployed state", async ({ page }) => {
    await page.goto("/status");
    const engine = page.getByRole("region", { name: "Engine account" });
    await expect(engine).not.toHaveAttribute("data-status", "loading", { timeout: 30_000 });
    if ((await engine.getAttribute("data-status")) === "ok") {
      await engine.getByText("Raw view_access_key_list result").click();
      await expect(engine.locator("pre")).toContainText('"keys"');
    } else {
      await expect(engine.getByText("Not deployed yet")).toBeVisible();
    }
  });

  test("refresh now re-reads every block", async ({ page }) => {
    await page.goto("/status");
    const before = await page.getByText(/Refreshed at/).textContent();
    await page.waitForTimeout(1_100);
    await page.getByRole("button", { name: "Refresh now" }).click();
    await expect.poll(async () => page.getByText(/Refreshed at/).textContent()).not.toBe(before);
  });
});
