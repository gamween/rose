import { expect, type Locator, type Page } from "@playwright/test";

export type WalletNetwork = "near" | "base" | "solana";

/**
 * Opens the connect modal from the top bar on one network's wallets, the way a visitor does:
 * without a wallet, the Connect button then that network; with one, the wallet button then
 * "Connect another network" (in the menu on a desktop, in the wallets drawer on a phone).
 */
export async function openConnectFor(page: Page, network: WalletNetwork): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
  const connect = page.locator("[data-connect]");
  const walletButton = page.locator("[data-wallets]");
  await expect(connect.or(walletButton)).toBeVisible({ timeout: 30_000 });
  if (await connect.isVisible()) {
    await connect.click();
    await dialog.locator(`[data-network='${network}']`).click();
  } else {
    await walletButton.click();
    await page.locator(`[data-add-network='${network}']:visible`).click();
  }
  await expect(dialog.locator(`[data-wallet-step='${network}']`)).toBeVisible();
  return dialog;
}

/** Creates (or reuses) the in-browser demo wallet of a network from the top bar. */
export async function connectDemoWallet(page: Page, network: WalletNetwork): Promise<void> {
  const dialog = await openConnectFor(page, network);
  await dialog.locator("[data-demo-wallet]").click();
  await expect(dialog).toBeHidden();
}

/** Opens the wallets drawer (balances and demo keys): through the wallet menu on a desktop, directly on a phone. */
export async function openWalletDrawer(page: Page): Promise<Locator> {
  await page.locator("[data-wallets]").click();
  const details = page.locator("[data-wallet-details]");
  const drawer = page.getByRole("dialog", { name: "Wallets" });
  await expect(details.or(drawer)).toBeVisible();
  if (await details.isVisible()) await details.click();
  await expect(drawer).toBeVisible();
  return drawer;
}
