import { expect, type Page } from "@playwright/test";

/**
 * Runs a command of the app's palette (Cmd/Ctrl+K), the one entry point of the global panels that
 * every viewport and wallet state shares: Get test funds and Activity otherwise live in the wallet
 * menu (connected) and the mobile menu. The shortcut is pressed again until the palette opens: a
 * press that lands before the shell hydrates has no listener yet.
 */
export async function runPaletteCommand(page: Page, query: string): Promise<void> {
  const input = page.locator("[data-palette-input]");
  await expect(async () => {
    if (!(await input.isVisible())) await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
    await expect(input).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await input.fill(query);
  await page.keyboard.press("Enter");
}
