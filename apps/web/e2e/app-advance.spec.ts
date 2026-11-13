import { expect, test, type Page } from "@playwright/test";
import { MOCK, MOCK_CONFIG, mockChains, type MockOverrides } from "./fixtures/engine-mock";
import { evmCallRequest } from "./fixtures/evm-calls";

/**
 * Advance (`/app/advance`): funders browse open and scheduled Advances, a holder creates one
 * (live `K <= X (1 - f(ts))`, bond preview) and seals the reserve in the browser; the two NEAR
 * calls go through the demo wallet against a mocked `send_tx`.
 */

const SEED = "a".repeat(64);
const NOW_SEC = 1_762_200_000;
const ns = (seconds: number) => `${String(seconds)}000000000`;
const E18 = "000000000000000000";
const SCREENS = process.env.ROSE_SCREENSHOT_DIR;

function advanceRound(id: string, status: "Open" | "Scheduled" | "Settled", creator: string) {
  return {
    round_id: id,
    kind: "Advance",
    class_id: SEED,
    venue: "Near",
    creator,
    status,
    app_id: "00",
    opens_at: ns(status === "Open" ? NOW_SEC - 3600 : NOW_SEC + 7200),
    closes_at: ns(NOW_SEC + 86_400),
    key_timeout: "3600000000000",
    reveal_window: "600000000000",
    max_price: "8000000",
    f_ts: "260000000000000000",
    remaining_lock_secs: String(270 * 86_400),
    bid_count: status === "Open" ? 2 : 0,
    opened_count: 0,
    settled_count: 0,
    created_at: ns(NOW_SEC - 7200),
    advance_units: `50${E18}`,
    advance_claim: `30${E18}`,
    advance_min_fill: `5${E18}`,
  };
}

const ROUNDS = [advanceRound("10", "Open", "teodor.testnet"), advanceRound("11", "Open", "ines.testnet"), advanceRound("12", "Scheduled", "varick.testnet"), advanceRound("2", "Settled", "teodor.testnet")];

const sent: { method: string; args: Record<string, unknown> }[] = [];

/**
 * The JSON arguments of the single function call inside a borsh `SignedTransaction`: the first
 * `{"` whose balanced braces parse as JSON (a random key or nonce byte can be a `{`).
 */
function jsonArgsOf(signed: Buffer): string {
  const text = signed.toString("latin1");
  for (let start = text.indexOf('{"'); start !== -1; start = text.indexOf('{"', start + 1)) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      if (text[i] === "}") depth -= 1;
      if (depth !== 0) continue;
      const candidate = Buffer.from(text.slice(start, i + 1), "latin1").toString("utf8");
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        break;
      }
    }
  }
  throw new Error("No JSON arguments in the signed transaction");
}

/** The live CKD master public key of the engine's domain (the ibe-wasm vectors), so sealing in the browser works against the mock. */
const CKD_PUBLIC_KEY = "bls12381g2:25NCZcAVKGVLiFjrkVd7cxhSxcahEcDhSZCjeWMuEBbyZkdn9FddJQgXnJLjuvVvWTd1LmSqfrfgeJ8G35vJLWYXPG5UWbKjAiNaD4j76MV8otrTwCcGtft5y1ryN3PvfWAu";

/** `nearCash`: the holder's NEAR cash in the engine (base units); `registered`: whether it has a NEP-145 storage deposit. */
function overrides(options: { nearCash?: string; registered?: boolean } = {}): MockOverrides {
  const nearCash = options.nearCash ?? "250000000";
  const registered = options.registered ?? true;
  return {
    engineView: (method, args) => {
      switch (method) {
        case "get_config":
          return { ...MOCK_CONFIG, ckd_public_key: CKD_PUBLIC_KEY };
        case "get_limits":
          return { bid_storage_deposit: "20000000000000000000000", round_storage_deposit: "50000000000000000000000", bond_floor: "1000000", fee_bps: 30, max_bids_per_round: 64, max_distribution_receivers: 50, min_key_timeout: ns(60), max_key_timeout: ns(7 * 86_400), min_reveal_window: ns(300), max_reveal_window: ns(7 * 86_400), max_round_horizon: ns(30 * 86_400) };
        case "get_rounds": {
          const filter = args.filter as { status?: string } | null;
          return { rounds: ROUNDS.filter((round) => round.status === filter?.status), next: null };
        }
        case "get_portfolio":
          return { holdings: [{ class_id: SEED, balance: `100${E18}`, locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "0" }], bids: [], liens_held: [], lien_shares: [], cash: [{ venue: "Near", amount: nearCash }] };
        case "storage_balance_of":
          return registered ? { total: "6190000000000000000000", available: "0" } : null;
        case "storage_balance_bounds":
          return { min: "6190000000000000000000", max: null };
        case "get_liens":
          return [[{ lien_id: "4", round_id: "6", class_id: SEED, holder: String(args.account), units: `10${E18}`, claim_total: `4${E18}`, delivered: `1${E18}`, pending_excess: "0", created_at: ns(NOW_SEC - 8 * 86_400), released: false }], []];
        default:
          return undefined;
      }
    },
    nearRequest: (method, params) => {
      if (method === "query" && params.request_type === "view_access_key") return { nonce: 7, permission: "FullAccess", block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
      if (method === "query" && params.request_type === "call_function" && params.method_name === "ft_balance_of") return "250000000";
      if (method === "block") return { header: { height: 276_200_700, hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS", timestamp: NOW_SEC * 1e9, timestamp_nanosec: ns(NOW_SEC) } };
      if (method === "send_tx") {
        const signed = Buffer.from(String(params.signed_tx_base64), "base64");
        const method_name = ["create_advance", "place_ask", "storage_deposit", "ft_transfer_call"].find((name) => signed.includes(name)) ?? "unknown";
        sent.push({ method: method_name, args: JSON.parse(jsonArgsOf(signed)) as Record<string, unknown> });
        const value = Buffer.from(method_name === "create_advance" ? JSON.stringify("13") : "0").toString("base64");
        const outcome = { id: "r", outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: MOCK.engine, status: { SuccessValue: value } } };
        return { status: { SuccessValue: value }, transaction: { hash: `tx${method_name}`, signer_id: "x", receiver_id: MOCK.engine, nonce: 8, public_key: "ed25519:11111111111111111111111111111111" }, transaction_outcome: outcome, receipts_outcome: [outcome], final_execution_status: "EXECUTED_OPTIMISTIC" };
      }
      return undefined;
    },
    baseRequest: evmCallRequest(),
  };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENS) return;
  await page.screenshot({ path: `${SCREENS}/app-advance-${name}-${String(page.viewportSize()?.width ?? 0)}.png`, fullPage: true });
}

async function connectNearDemo(page: Page): Promise<void> {
  await page.locator("[data-advance-connect]").click();
  const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
  await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Dismiss notification" }).click();
}

test.describe("advance", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");
  test.describe.configure({ timeout: 180_000 });

  test("lists open and scheduled Advances with links into the round detail", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockChains(page, overrides());
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    const list = page.locator("[data-advance-list]");
    await expect(list.locator("[data-advance-round]")).toHaveCount(3, { timeout: 60_000 });
    const first = list.locator("[data-advance-round='10']");
    await expect(first).toContainText("Advance #10 · CINDR");
    await expect(first).toContainText("30.0000 tokens");
    await expect(first).toContainText("8.00 / claimed token");
    await expect(first.getByRole("link", { name: /Bid on this Advance/ })).toHaveAttribute("href", "/app/rounds/10");
    await expect(list.locator("[data-advance-round='12']")).toContainText("Scheduled");
    const past = page.locator("[data-advance-past] [data-advance-round='2']");
    await expect(past).toContainText("Settled");
    await expect(past.getByRole("link", { name: /View round/ })).toHaveAttribute("href", "/app/rounds/2");
    await shot(page, "browse");
    expect(errors).toEqual([]);
  });

  test("creates an Advance: live K bound, bond preview, create_advance then the sealed ask", async ({ page }) => {
    sent.length = 0;
    await mockChains(page, overrides());
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("tab", { name: "Create an Advance" }).click();
    await connectNearDemo(page);
    const form = page.locator("[data-advance-form]");
    await expect(form).toBeVisible({ timeout: 60_000 });
    await form.getByRole("textbox", { name: /Units to encumber/ }).fill("40");
    await expect(form.getByText(/K ≤ X · \(1 − f\(ts\)\) = /)).toBeVisible();
    await form.getByRole("textbox", { name: /Claim \(K\)/ }).fill("1000");
    await form.getByRole("textbox", { name: /Sealed reserve/ }).fill("5");
    await form.getByRole("textbox", { name: /Public price ceiling/ }).fill("9");
    await form.getByRole("textbox", { name: /Minimum fill/ }).fill("1");
    await form.locator("[data-advance-submit]").click();
    await expect(form.getByText(/At most .* tokens are still locked/)).toBeVisible();
    await form.getByRole("textbox", { name: /Claim \(K\)/ }).fill("10");
    await expect(form.getByText(/Values your bond: 1.00 USDC/)).toBeVisible();
    await shot(page, "create");
    await form.locator("[data-advance-submit]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow).toHaveAttribute("data-flow-status", "completed", { timeout: 90_000 });
    await expect(flow.locator("[data-step='create']")).toContainText("Advance #13 created");
    await expect(flow.locator("[data-step='seal']")).toContainText("Reserve sealed and placed");
    await shot(page, "flow-done");
    expect(sent.map((call) => call.method)).toEqual(["create_advance", "place_ask"]);
    const created = sent[0]!.args.params as Record<string, string>;
    expect(created.units).toBe(`40${E18}`);
    expect(created.claim).toBe(`10${E18}`);
    expect(created.max_price).toBe("9000000");
    const ask = sent[1]!.args as { round_id: string; units: string; ciphertext_hex: string };
    expect(ask.round_id).toBe("13");
    expect(ask.units).toBe(`10${E18}`);
    expect(ask.ciphertext_hex).toHaveLength(384);
    await page.locator("[data-flow-close]").click();
    await expect(page.locator("[data-advance-created]").getByRole("link")).toHaveAttribute("href", "/app/rounds/13");
  });

  test("funds a short bond from the form: registration first, then the tUSDC deposit, from one click", async ({ page }) => {
    sent.length = 0;
    await mockChains(page, overrides({ nearCash: "0", registered: false }));
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("tab", { name: "Create an Advance" }).click();
    await connectNearDemo(page);
    const form = page.locator("[data-advance-form]");
    await expect(form).toBeVisible({ timeout: 60_000 });
    await form.getByRole("textbox", { name: /Claim \(K\)/ }).fill("10");
    await form.getByRole("textbox", { name: /Public price ceiling/ }).fill("9");
    const shortfall = form.locator("[data-bond-shortfall]");
    await expect(shortfall).toContainText("short by 1.00 USDC");
    await expect(shortfall.locator("[data-storage-notice='register']")).toContainText("storage deposit of 0.00619 NEAR", { timeout: 30_000 });
    await shot(page, "bond-storage");
    await shortfall.locator("[data-deposit-bond]").click();
    await expect(page.getByRole("status").filter({ hasText: "1.00 tUSDC credited to your cash" })).toBeVisible({ timeout: 30_000 });
    expect(sent.map((call) => call.method)).toEqual(["storage_deposit", "ft_transfer_call"]);
  });

  test("points a Base-venue bond shortfall to the Fund tab, which credits any NEAR account", async ({ page }) => {
    await mockChains(page, overrides({ nearCash: "0", registered: true }));
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("tab", { name: "Create an Advance" }).click();
    await connectNearDemo(page);
    const form = page.locator("[data-advance-form]");
    await expect(form).toBeVisible({ timeout: 60_000 });
    await form.getByRole("textbox", { name: /Claim \(K\)/ }).fill("10");
    await form.getByRole("textbox", { name: /Public price ceiling/ }).fill("9");
    await form.getByText(/^Advanced: cash venue/).click();
    await form.getByRole("combobox", { name: "Cash venue" }).selectOption({ index: 1 });
    const shortfall = form.locator("[data-bond-shortfall]");
    await expect(shortfall).toContainText("short by 1.00 USDC");
    await expect(shortfall.getByRole("link", { name: "Issuer → Fund" })).toHaveAttribute("href", "/app/issuer#fund");
  });

  test("checks the round bounds inline", async ({ page }) => {
    await mockChains(page, overrides());
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("tab", { name: "Create an Advance" }).click();
    await connectNearDemo(page);
    const form = page.locator("[data-advance-form]");
    await expect(form).toBeVisible({ timeout: 60_000 });
    await form.getByText(/^Advanced: cash venue/).click();
    await expect(form.locator("[data-key-timeout]")).toHaveValue("60");
    await expect(form.locator("[data-reveal-window]")).toHaveValue("10");
    await form.locator("[data-reveal-window]").fill("2");
    await form.locator("[data-advance-submit]").click();
    await expect(form.getByText("The reveal window must be at least 5 min.")).toBeVisible();
    await expect(page.locator("[data-flow-dialog]")).toBeHidden();
  });

  test("shows the account's liens", async ({ page }) => {
    await mockChains(page, overrides());
    await page.goto("/app/advance");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await page.getByRole("tab", { name: "Create an Advance" }).click();
    await connectNearDemo(page);
    await page.getByRole("tab", { name: "My liens" }).click();
    await expect(page.locator("[data-liens-held]")).toContainText("Lien #4", { timeout: 60_000 });
    await expect(page.locator("[data-liens-held]")).toContainText("1.0000 of 4.0000 delivered");
    await shot(page, "liens");
  });
});
