import { expect, test } from "@playwright/test";

/**
 * Every response carries the security headers, and the policy breaks nothing: the WebGL landing,
 * the app with its wallet runtime and the docs load without a Content Security Policy violation.
 */

test.describe("security headers", () => {
  for (const path of ["/", "/app", "/docs", "/api/faucet"]) {
    test(`${path} sends the CSP and the hardening headers`, async ({ request }) => {
      const response = await request.get(path);
      const headers = response.headers();
      expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(headers["x-frame-options"]).toBe("DENY");
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    });
  }

  test("the landing, the app and the connect modal run without a policy violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to (load|execute|connect|frame|apply|compile)/i.test(message.text())) violations.push(message.text());
    });
    await page.goto("/");
    await expect(page.locator("[data-mode]")).not.toHaveAttribute("data-mode", "poster", { timeout: 30_000 });
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.locator("[data-connect]").click();
    const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
    await expect(page.getByText("NEAR demo wallet ready")).toBeVisible();
    await page.goto("/docs");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
