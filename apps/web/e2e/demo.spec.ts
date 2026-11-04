import { expect, test, type Page } from "@playwright/test";
import { collectErrors } from "./fixtures/console";
import { DEMO_RECORDING, mockDemoEngine } from "./fixtures/demo-mock";

/**
 * "Watch a full round" (spec 9). The demo exists only for an engine with a committed manifest,
 * so the suite needs a build configured with a seeded staging engine that has a recording
 * (`deployments/engine-s4.rose-app.testnet.env`); the engine views are served from
 * that recording (`fixtures/demo-mock.ts`), the explorer links come from the manifest.
 */

const DEMO_BUILD = process.env.NEXT_PUBLIC_ENGINE_ACCOUNT === DEMO_RECORDING.engine;

async function open(page: Page, query: string): Promise<void> {
  await mockDemoEngine(page);
  await page.goto(`/app/demo${query}`);
  await expect(page.locator("[data-demo-live='ok']")).toBeVisible({ timeout: 20_000 });
}

test.describe("guided demo", () => {
  test.skip(!DEMO_BUILD, `NEXT_PUBLIC_ENGINE_ACCOUNT must be ${DEMO_RECORDING.engine} for this suite`);

  test("is reachable from the landing, the testnet banner and the rounds list", async ({ page }) => {
    const errors = collectErrors(page);
    await mockDemoEngine(page);
    await page.goto("/");
    await expect(page.locator("[data-watch-demo]")).toHaveAttribute("href", "/app/demo");
    await page.goto("/app/rounds");
    await expect(page.locator("[data-testnet-banner] [data-watch-demo]")).toHaveAttribute("href", "/app/demo");
    // The first-visit tour is open over the list; a DOM click follows the link client-side while the
    // tour is still due, which is exactly when it must not cover the demo.
    await expect(page.locator("[data-tour-step='0']")).toBeVisible();
    await page.locator("[data-rounds-page] [data-watch-demo]").evaluate((link: HTMLAnchorElement) => link.click());
    await expect(page).toHaveURL(/\/app\/demo/);
    await expect(page.getByRole("heading", { name: "Watch a full round" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("walks the Exit round on Solana step by step with live views, explorer links and the malformed bid", async ({ page }) => {
    const errors = collectErrors(page);
    await open(page, "?round=exit");
    await expect(page.locator("[data-demo-scenario='exit']")).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "custody");
    await expect(page.locator("[data-demo-tx='solana'] a").first()).toHaveAttribute("href", /^https:\/\/explorer\.solana\.com\/tx\/.+\?cluster=devnet$/);
    await expect(page.locator("[data-demo-panel='class']")).toContainText("Solana");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "deposit");
    await expect(page.locator("[data-demo-position]")).toHaveCount(2);
    await expect(page.locator("[data-demo-tx='near'] a").first()).toHaveAttribute("href", /^https:\/\/testnet\.near\.rocks\/tx\//);
    await expect(page).toHaveURL(/round=exit&step=deposit/);

    await page.locator("[data-demo-next]").click();
    await page.locator("[data-demo-next]").click();
    await page.locator("[data-demo-next]").click();
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "seal");
    await expect(page.locator("[data-demo-sealed]")).toHaveCount(5);
    await expect(page.locator("[data-demo-hash]").first()).toHaveAttribute("title", new RegExp(`^${DEMO_RECORDING.expected.exitFirstSealedHash}`));
    await expect(page.getByText("as posted", { exact: true })).toHaveCount(5);
    await expect(page.locator("[data-demo-step]")).toContainText("Nadia Solvik posted a deliberately malformed ciphertext");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-latency]")).toHaveText(DEMO_RECORDING.expected.exitKeyLatency);
    await expect(page.locator("[data-demo-event='key_received']")).toHaveCount(1);

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "open");
    await expect(page.locator("[data-demo-check='match']")).toHaveCount(4);
    await expect(page.locator("[data-demo-opening='4'] [data-demo-check='unopenable']")).toBeVisible();
    await expect(page.locator("[data-demo-opening='0']")).toContainText(DEMO_RECORDING.expected.exitFirstOpeningGas);
    await expect(page.getByText("refused on chain, as intended")).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-clearing-chart]")).toBeVisible();
    await expect(page.locator("[data-demo-price]")).toHaveText("0.027 USDC");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-verify]")).toHaveAttribute("data-demo-verify", "match");

    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-fill='4'] [data-demo-bond]")).toHaveAttribute("data-demo-bond", "slashed");
    await expect(page.locator("[data-demo-event='bid_settled']")).toHaveCount(5);

    await page.keyboard.press("End");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "payout");
    await expect(page.locator("[data-demo-next]")).toBeDisabled();
    await page.keyboard.press("Home");
    await expect(page.locator("[data-demo-prev]")).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test("keyboard shortcuts stay with an open dialog, and the activity feed keeps the price decimals", async ({ page, isMobile }) => {
    const errors = collectErrors(page);
    await open(page, "?round=exit");
    const step = page.locator("[data-demo-step]");
    await expect(step).toHaveAttribute("data-demo-step", "custody");
    if (isMobile) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.locator("[data-menu-action='activity']").click();
    } else {
      await page.locator("[data-activity]").click();
    }
    const feed = page.getByRole("dialog", { name: "Activity" });
    await expect(feed).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("End");
    await expect(step).toHaveAttribute("data-demo-step", "custody");
    // engine-s4 rounds #0 and #2 cleared at 36000 and 37500 base units: 0.036 and 0.0375, never "0.03".
    await expect(feed.locator("[data-activity-feed]")).toContainText("Round #0 cleared at 0.036 USDC", { timeout: 20_000 });
    await expect(feed.locator("[data-activity-feed]")).toContainText("Round #2 cleared at 0.0375 USDC");
    await page.keyboard.press("Escape");
    await expect(feed).toBeHidden();
    await page.keyboard.press("ArrowRight");
    await expect(step).toHaveAttribute("data-demo-step", "deposit");
    await page.keyboard.press("End");
    await expect(step).toHaveAttribute("data-demo-step", "payout");
    await expect(page.locator("[data-demo-step]")).toContainText("claim_sol_tokens");
    await expect(page.locator("[data-demo-tx='solana'] a").last()).toHaveAttribute("href", /^https:\/\/explorer\.solana\.com\/tx\/44Jfunex.+\?cluster=devnet$/);
    expect(errors).toEqual([]);
  });

  test("switches rounds, deep-links a step and autoplays with reduced motion", async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, "?round=tender&step=payout");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "payout");
    await expect(page.locator("[data-demo-tx='base'] a").first()).toHaveAttribute("href", /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}$/);

    await page.locator("[data-demo-scenario='no-key']").click();
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "create");
    await expect(page.locator("[data-demo-position]")).toHaveCount(0);
    await expect(page.locator("[data-demo-panel='parameters']")).toContainText(`Round #${DEMO_RECORDING.expected.noKeyRoundId}`);
    await page.locator("[data-demo-play]").click();
    await expect(page.locator("[data-demo-play]")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/autoplay=1/);
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "seal", { timeout: 15_000 });
    await page.keyboard.press(" ");
    await expect(page.locator("[data-demo-play]")).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("[data-demo-panel='cancel']")).toContainText("no key before the timeout");

    await page.locator("[data-demo-scenario='advance']").click();
    await page.keyboard.press("End");
    await expect(page.locator("[data-demo-step]")).toHaveAttribute("data-demo-step", "redeem");
    await expect(page.locator(`[data-demo-position='${DEMO_RECORDING.expected.redeemedPositionId}']`)).toContainText("Released");
    expect(errors).toEqual([]);
  });
});
