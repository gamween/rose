import type { Page } from "@playwright/test";

/**
 * Runs a command of the app's palette (Cmd/Ctrl+K), the one entry point of the global panels that
 * every viewport and wallet state shares: Get test funds and Activity otherwise live in the wallet
 * menu (connected) and the mobile menu.
 */
export async function runPaletteCommand(page: Page, query: string): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK");
  await page.locator("[data-palette-input]").fill(query);
  await page.keyboard.press("Enter");
}
