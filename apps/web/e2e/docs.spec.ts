import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("docs", () => {
  test("renders the overview at /docs with navigation, table of contents and pager", async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await page.goto("/docs");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Overview");
    await expect(page).toHaveTitle("Docs · rose");
    const mobile = testInfo.project.name === "mobile";
    if (mobile) {
      await page.getByRole("button", { name: "Open the docs navigation" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("dialog").getByRole("link", { name: "Concepts" }).click();
    } else {
      await expect(page.getByRole("navigation", { name: "Docs" }).getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("navigation", { name: "On this page" }).getByRole("link", { name: "The problem" })).toBeVisible();
      await page.getByRole("navigation", { name: "Docs" }).getByRole("link", { name: "Concepts" }).click();
    }
    await page.waitForURL("**/docs/concepts");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Concepts");
    const pager = page.getByRole("navigation", { name: "Previous and next page" });
    await expect(pager.getByRole("link", { name: /Previous/ })).toHaveAttribute("href", "/docs");
    await pager.getByRole("link", { name: /Next/ }).click();
    await page.waitForURL("**/docs/sealed-rounds");
    expect(errors).toEqual([]);
  });

  test("renders the clearing examples as tables and the lifecycle as a code block", async ({ page }) => {
    await page.goto("/docs/clearing-rules");
    const tables = page.locator("article table");
    expect(await tables.count()).toBeGreaterThanOrEqual(10);
    await expect(tables.first().locator("th").first()).toHaveText("Candidate P");
    // Every table sits in a focusable region that scrolls sideways with an edge cue on a phone (no page overflow).
    const region = page.locator("[data-docs-table]").first();
    await expect(region).toHaveAttribute("tabindex", "0");
    await expect(region).toHaveCSS("overflow-x", "auto");
    expect(await region.evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("radial-gradient");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.goto("/docs/sealed-rounds");
    await expect(page.locator("article pre code")).toContainText("Scheduled -> Open -> KeyRequested");
  });

  test("substitutes deployment placeholders and never shows a raw token", async ({ page }) => {
    await page.goto("/docs/contracts-and-addresses");
    const article = page.locator("article");
    await expect(article).not.toContainText("{{");
    const placeholders = article.locator("[data-placeholder]");
    expect(await placeholders.count()).toBe(7);
    for (const placeholder of await placeholders.all()) {
      const deployed = await placeholder.getAttribute("data-deployed");
      if (deployed === "false") await expect(placeholder).toHaveText("Not deployed yet");
      else expect((await placeholder.textContent())?.length ?? 0).toBeGreaterThan(5);
    }
  });

  test("redirects /docs/contracts to the contracts page and /docs/overview to /docs", async ({ page }) => {
    await page.goto("/docs/contracts");
    await page.waitForURL("**/docs/contracts-and-addresses");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Contracts and addresses");
    await page.goto("/docs/overview");
    await page.waitForURL(/\/docs$/);
  });

  test("searches titles and headings from the keyboard", async ({ page }, testInfo) => {
    await page.goto("/docs");
    if (testInfo.project.name === "mobile") await page.getByRole("button", { name: "Open the docs navigation" }).click();
    const input = page.getByRole("combobox", { name: "Search the docs" });
    await input.fill("rationed");
    const option = page.getByRole("option").first();
    await expect(option).toContainText("rationed");
    await input.press("Enter");
    await page.waitForURL(/\/docs\/clearing-rules#example-2/);
    await expect(page.getByRole("heading", { name: /Example 2/ })).toBeVisible();
  });

  test("anchors in the article resolve to headings on the target page", async ({ page }) => {
    await page.goto("/docs");
    await page.locator("article").getByRole("link", { name: "Why NEAR" }).click();
    await page.waitForURL(/\/docs\/faq#why-near/);
    await expect(page.locator("#why-near")).toBeVisible();
  });

  test("every docs page renders without console errors and with the footer links", async ({ page }) => {
    const errors = collectErrors(page);
    for (const slug of ["concepts", "fees", "guide-issuer", "sdk", "faq", "glossary", "trust-and-security", "cross-chain-custody"]) {
      await page.goto(`/docs/${slug}`);
      await expect(page.getByRole("heading", { level: 1 })).not.toBeEmpty();
    }
    const footer = page.getByRole("navigation", { name: "Footer" });
    await expect(footer.getByRole("link", { name: "Contracts" })).toHaveAttribute("href", "/docs/contracts");
    await page.goto("/docs/faq");
    await expect(page.locator("article")).toContainText("NEAR Connect");
    await expect(page.locator("article")).not.toContainText("Wallet Selector");
    await page.goto("/docs/contracts-and-addresses");
    await expect(page.locator("article").getByRole("link", { name: "NEAR Rocks" })).toHaveAttribute("href", "https://testnet.near.rocks");
    await expect(page.locator("article")).toContainText("The final engine, engine-v2.rose-app.testnet, is keyless after init");
    expect(errors).toEqual([]);
  });
});
