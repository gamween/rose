import { expect, test, type Page } from "@playwright/test";

const PHRASE = "What was locked, rose.";

async function opacityOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((element) => Number(getComputedStyle(element).opacity));
}

test.describe("landing", () => {
  test("exposes the phrase as the page heading and has the expected metadata", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PHRASE);
    await expect(page).toHaveTitle("rose: What was locked, rose.");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /opengraph-image/);
  });

  test("reaches the Launch app button by keyboard and navigates to the app", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-mode]")).not.toHaveAttribute("data-mode", "poster");
    let found = false;
    for (let i = 0; i < 40 && !found; i += 1) {
      await page.keyboard.press("Tab");
      found = await page.evaluate(() => document.activeElement?.matches("[data-launch]") ?? false);
    }
    expect(found).toBe(true);
    await expect.poll(() => opacityOf(page, "[data-launch]")).toBe(1);
    await page.keyboard.press("Enter");
    await page.waitForURL("**/app");
  });

  test("ends with the sequence, the top bar and its Launch app button staying on screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-mode]")).not.toHaveAttribute("data-mode", "poster");
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const sectionBottom = await page.locator("[data-landing]").evaluate((element) => element.getBoundingClientRect().bottom);
    expect(Math.abs(sectionBottom - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(0);
    const topBar = page.getByRole("banner");
    await expect(topBar.getByRole("link", { name: "rose home" })).toBeInViewport();
    await expect(topBar.getByRole("link", { name: "Launch app" })).toBeInViewport();
  });

  test("scrolls through the sequence without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("[data-mode]")).not.toHaveAttribute("data-mode", "poster");
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      await page.evaluate((p) => {
        const section = document.querySelector<HTMLElement>("[data-landing]")!;
        window.scrollTo(0, (section.offsetHeight - window.innerHeight) * p);
      }, progress);
      await page.waitForTimeout(300);
    }
    expect(errors).toEqual([]);
  });

  test("tells a mouse user to hover the dragon once the sequence ends, and never shows the hint on touch", async ({ page }) => {
    await page.goto("/");
    const stage = page.locator("[data-mode]");
    await expect(stage).not.toHaveAttribute("data-mode", "poster", { timeout: 20_000 });
    test.skip((await stage.getAttribute("data-mode")) !== "live", "the hint belongs to the live WebGL sequence");
    const hint = page.locator("[data-launch-hint]");
    await expect(hint).toBeHidden();
    await page.evaluate(() => {
      const section = document.querySelector<HTMLElement>("[data-landing]")!;
      window.scrollTo(0, section.offsetHeight - window.innerHeight);
    });
    await expect(stage).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
    const finePointer = await page.evaluate(() => window.matchMedia("(hover: hover) and (pointer: fine)").matches);
    if (finePointer) {
      await expect(hint).toBeVisible();
      await expect(hint).toHaveText("Hover the dragon to launch the app");
    } else {
      await expect(hint).toBeHidden();
      await expect.poll(() => opacityOf(page, "[data-launch]")).toBe(1);
    }
  });
});

test.describe("landing with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("shows a static final frame with the phrase and the Launch app button", async ({ page }) => {
    await page.goto("/");
    const stage = page.locator("[data-mode]");
    await expect(stage).toHaveAttribute("data-mode", /static|fallback/);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(PHRASE);
    const box = await heading.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(150);
    await expect.poll(() => opacityOf(page, "[data-launch]")).toBe(1);
    const sectionHeight = await page.locator("[data-landing]").evaluate((element) => element.getBoundingClientRect().height);
    expect(sectionHeight).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await page.locator("[data-launch]").click();
    await page.waitForURL("**/app");
  });
});
