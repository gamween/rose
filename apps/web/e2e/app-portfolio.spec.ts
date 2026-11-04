import { expect, test, type Page } from "@playwright/test";
import { MOCK, mockChains, type MockOverrides } from "./fixtures/engine-mock";
import { evmCallRequest } from "./fixtures/evm-calls";

/**
 * Portfolio (`/app`): a demo NEAR account holding units of two classes with claimable tokens,
 * a sealed ask, a lien as holder and a share as funder, cash in both venues, payouts in every
 * state and a retired Tender lot. Every chain read is mocked; the NEAR tUSDC claim runs end to
 * end through the demo wallet against a mocked `send_tx`.
 */

const SEED = "a".repeat(64);
const STRATEGIC = "c".repeat(64);
const NOW_SEC = 1_762_200_000;
const ns = (seconds: number) => `${String(seconds)}000000000`;
const ONE_E18 = "000000000000000000";

const HOLDINGS = [
  { class_id: SEED, balance: `70${ONE_E18}`, locked_in_rounds: `20${ONE_E18}`, encumbered: `10${ONE_E18}`, claimable: `12500${"0".repeat(15)}`, checkpoint: "200000000000000000" },
  { class_id: STRATEGIC, balance: "40000000000000", locked_in_rounds: "0", encumbered: "0", claimable: "2500000000000", checkpoint: "100000000000000000" },
];

const BID = { round_id: "8", bid_id: 2, bidder: "", side: "Sell", status: "Sealed", escrow: "0", locked_units: `20${ONE_E18}`, bond: "1000000", fee: "0", cash: "0", fill_quantity: "0", ciphertext_hex: "ab".repeat(192), placed_at: ns(NOW_SEC - 3600), opened: null, void: null };

const LIEN_HELD = { lien_id: "4", round_id: "6", class_id: SEED, holder: "", units: `10${ONE_E18}`, claim_total: `4${ONE_E18}`, delivered: `3${ONE_E18}`, pending_excess: "0", created_at: ns(NOW_SEC - 8 * 86_400), released: false };
const LIEN_SHARE = { lien_id: "9", class_id: STRATEGIC, funder: "", claim: "5000000000000", claimed: "1000000000000", claimable: "750000000000" };

const ROUND_8 = { round_id: "8", kind: "Exit", class_id: SEED, venue: "Near", creator: "bob.testnet", status: "Open", app_id: "00", opens_at: ns(NOW_SEC - 7200), closes_at: ns(NOW_SEC + 86_400), key_timeout: "3600000000000", reveal_window: "600000000000", max_price: "9000000", f_ts: "260000000000000000", remaining_lock_secs: String(270 * 86_400), bid_count: 3, opened_count: 0, settled_count: 0, created_at: ns(NOW_SEC - 7200) };

function payout(id: string, status: unknown, extra: Record<string, unknown> = {}) {
  return { id, chain: "Base", kind: { BaseTransfer: { token: MOCK.baseTusdc, to: "0x7d4777cfc6ed48061b0bccae558d29919b412042", amount: "25000000" } }, debit: null, requester: "", status, digest: "ab", base: status === "Signed" ? { r: "11".repeat(32), s: "22".repeat(32), v: 27 } : null, solana: null, created_at: ns(NOW_SEC - 600), updated_at: ns(NOW_SEC - 590), requested_block: "276100000", ...extra };
}

/** `[2] || sig(gas) || sig(vault) || message` of a landed Solana payout. */
const LANDED_WIRE = Buffer.from([2, ...new Array<number>(64).fill(5), ...new Array<number>(64).fill(6), 1, 0, 0]).toString("base64");

const PAYOUTS = [
  payout("14", "Landed", { chain: "Solana", kind: { SolTransfer: { mint: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w", to_owner: "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n", amount: "1000000000000" } }, base: null, solana: { message: "00", draws: [], authority_path: "vault/sol", authority: "v", cancel: false, nonce_account: "9vaultNonce111111111111111111111111111111111", nonce_value: "H1", transaction: LANDED_WIRE } }),
  payout("13", "Requested", { requested_block: "276200500" }),
  payout("12", "Signed"),
  payout("11", "Requested", { requested_block: "276000000" }),
  payout("10", { Failed: { reason: "authority signature not produced" } }),
  payout("9", "AwaitingGasSignature", { chain: "Solana", kind: { SolTransfer: { mint: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w", to_owner: "6uMy1iYdq9EpL6W3EjsKdUZfrJ5G1shD1Da1QNe8gH7n", amount: "1000000000000" } }, base: null, solana: { message: "00", withdraws: [], pool_used: "0", pool_credit: "0", authority_path: "vault/sol", nonce_account: "9vaultNonce111111111111111111111111111111111", nonce_value: "H1", authority_signature: "aa", gas_signature: null, transaction: null } }),
];

const OUTCOME_HASH = "7yB4Z4yHnm8hsg8sXxQ4vCxk3iCTn2MmiLpSj8YsUvQd";

/** Vault streams of the Strategic class: one paying claims, one ended and auto-claimed, one ended under an unconfirmed payout. */
const ENDED_METADATA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DRAWN_METADATA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const AUTO_CLAIM_TX = "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7";
function solStream(position: string, metadata: string, endTime: number, engineWithdrawn: string, extra: Record<string, unknown> = {}) {
  return { metadata, mint: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w", start_time: NOW_SEC - 30 * 86_400, end_time: endTime, net_amount_deposited: "120000000000000", period: 1, amount_per_period: "1000", cliff: 0, cliff_amount: "0", engine_withdrawn: engineWithdrawn, registered_withdrawn: "0", checkpoint: "0", drawing: null, pending_withdraw: "0", ...extra };
}
const SOL_STREAMS = [
  { position_id: "2", withdrawable: "1500000000000", redeem_claimable: "3000000000000", stream: solStream("2", "J2MxStreamMetadata111111111111111111111111111", NOW_SEC + 30 * 86_400, "0") },
  { position_id: "6", withdrawable: "0", redeem_claimable: "0", stream: solStream("6", ENDED_METADATA, NOW_SEC - 600, "60000000000000") },
  { position_id: "7", withdrawable: "0", redeem_claimable: "0", stream: solStream("7", DRAWN_METADATA, NOW_SEC - 600, "60000000000000", { drawing: "15" }) },
];

/** The 32 bytes of a base58 Solana address (the spec cannot load web3.js, whose websocket dependency breaks the test loader). */
function base58Bytes(address: string): Buffer {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  return Buffer.from(value.toString(16).padStart(64, "0"), "hex");
}

/** 1,104 metadata bytes of a stream at the vault whose whole deposit Streamflow's auto-claim withdrew. */
function autoClaimedMetadata(): string {
  const data = Buffer.alloc(1104);
  data.writeBigUInt64LE(120_000_000_000_000n, 17);
  base58Bytes(MOCK.vaultSol).copy(data, 113);
  return data.toString("base64");
}
const SCREENS = process.env.ROSE_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENS) return;
  await page.screenshot({ path: `${SCREENS}/app-portfolio-${name}-${String(page.viewportSize()?.width ?? 0)}.png`, fullPage: true });
}

/** Mocked views of whichever account the page asks about (the demo account is created during the test). */
function overrides(state: { account: string; withdrawn: boolean; synced?: boolean }): MockOverrides {
  const withAccount = <T extends { bidder?: string; holder?: string; funder?: string; requester?: string }>(item: T): T => ({ ...item, ...("bidder" in item ? { bidder: state.account } : {}), ...("holder" in item ? { holder: state.account } : {}), ...("funder" in item ? { funder: state.account } : {}), ...("requester" in item ? { requester: state.account } : {}) });
  return {
    engineView: (method, args) => {
      if (typeof args.account === "string" && args.account.startsWith("rose-demo-")) state.account = args.account;
      switch (method) {
        case "get_portfolio":
          return {
            holdings: HOLDINGS,
            bids: [withAccount(BID)],
            liens_held: [withAccount(LIEN_HELD)],
            lien_shares: [withAccount(LIEN_SHARE)],
            cash: [
              { venue: "Near", amount: state.withdrawn ? "0" : "150000000" },
              { venue: { Base: { token: MOCK.baseTusdc } }, amount: "42000000" },
            ],
          };
        case "get_payouts":
          return Number(args.from_index ?? 0) === 0 ? PAYOUTS.map(withAccount) : [];
        case "get_payout":
          return PAYOUTS.map(withAccount).find((item) => item.id === String(args.payout_id)) ?? null;
        case "storage_balance_of":
          return { total: "9000000000000000000000", available: "2810000000000000000000" };
        case "storage_balance_bounds":
          return { min: "6190000000000000000000", max: null };
        case "get_positions":
          return Number(args.from_index ?? 0) === 0
            ? [
                { position_id: "0", class_id: SEED, source: { BaseStream: { lockup: MOCK.lockup, stream_id: "82" } }, allocation: `50${ONE_E18}`, depositor: "halden.testnet", deposited_at: ns(NOW_SEC - 79 * 86_400), state: "Held" },
                { position_id: "1", class_id: SEED, source: { BaseStream: { lockup: MOCK.lockup, stream_id: "83" } }, allocation: `150${ONE_E18}`, depositor: "tessaro.testnet", deposited_at: ns(NOW_SEC - 78 * 86_400), state: "Held" },
                { position_id: "2", class_id: STRATEGIC, source: { SolanaStream: { metadata: "J2MxStreamMetadata111111111111111111111111111" } }, allocation: "120000000000000", depositor: "varick.testnet", deposited_at: ns(NOW_SEC - 21 * 86_400), state: "Held" },
              ]
            : [];
        case "get_rounds": {
          const filter = args.filter as { creator?: string } | null;
          return filter?.creator ? { rounds: [{ ...ROUND_8, round_id: "1", kind: "Tender", status: "Settled", creator: state.account, budget: "950000000", retire_to: "0x000000000000000000000000000000000000dead" }], next: null } : { rounds: [], next: null };
        }
        case "get_retired_lot":
          return String(args.round_id) === "1" ? { round_id: "1", class_id: SEED, retire_to: "0x000000000000000000000000000000000000dead", units: `100${ONE_E18}`, claimable: `9${ONE_E18}` } : null;
        case "get_round":
          return String(args.round_id) === "8" ? ROUND_8 : null;
        case "get_sol_streams":
          return args.class_id === STRATEGIC ? SOL_STREAMS.filter((entry) => !(state.synced && entry.position_id === "6")) : [];
        case "get_sol_swept":
          return args.class_id === STRATEGIC ? { balance: state.synced ? "65000000000000" : "5000000000000", pending: "0" } : { balance: "0", pending: "0" };
        default:
          return undefined;
      }
    },
    nearRequest: (method, params) => {
      if (method === "query" && params.request_type === "view_access_key") {
        return { nonce: 7, permission: "FullAccess", block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
      }
      if (method === "query" && params.request_type === "call_function" && params.method_name === "ft_balance_of") return "150000000";
      if (method === "block") return { header: { height: 276_200_700, hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS", timestamp: NOW_SEC * 1e9, timestamp_nanosec: ns(NOW_SEC) } };
      if (method === "send_tx" || method === "tx") {
        const sync = Buffer.from(String(params.signed_tx_base64 ?? ""), "base64").toString("latin1").includes("sync_sol_stream");
        const log = sync
          ? `EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"sol_stream_swept","data":{"position_id":"6","class_id":"${STRATEGIC}","amount":"60000000000000"}}`
          : `EVENT_JSON:{"standard":"rose","version":"1.0.0","event":"cash_withdrawn","data":{"account":"${state.account}","venue":"Near","amount":"150000000"}}`;
        if (sync) state.synced = true;
        else state.withdrawn = true;
        const outcome = { id: "r", outcome: { logs: [log], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: MOCK.engine, status: { SuccessValue: "" } } };
        return { status: { SuccessValue: "" }, transaction: { hash: OUTCOME_HASH, signer_id: state.account, receiver_id: MOCK.engine, nonce: 8, public_key: "ed25519:11111111111111111111111111111111" }, transaction_outcome: outcome, receipts_outcome: [outcome], final_execution_status: "EXECUTED_OPTIMISTIC" };
      }
      return undefined;
    },
    baseRequest: evmCallRequest(),
    solanaRequest: (method, params) => {
      if (method === "getAccountInfo") {
        return params[0] === ENDED_METADATA || params[0] === DRAWN_METADATA
          ? { context: { slot: 1 }, value: { data: [autoClaimedMetadata(), "base64"], owner: "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ", lamports: 8_574_720, executable: false, rentEpoch: 0, space: 1104 } }
          : { context: { slot: 1 }, value: null };
      }
      if (method === "getSignaturesForAddress") return [{ signature: AUTO_CLAIM_TX, slot: 1, err: null, memo: "Auto-Claim", blockTime: NOW_SEC - 599, confirmationStatus: "finalized" }];
      return undefined;
    },
  };
}

async function connectNearDemo(page: Page): Promise<string> {
  await page.goto("/app");
  await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
  await page.reload();
  await page.locator("[data-portfolio-connect]").click();
  const dialog = page.getByRole("dialog", { name: /Connect a wallet/ });
  await dialog.getByRole("button", { name: /Create a demo wallet/ }).click();
  await expect(dialog).toBeHidden();
  const account = await page.evaluate(() => (JSON.parse(localStorage.getItem("rose.demo.near") ?? "{}") as { accountId?: string }).accountId ?? "");
  expect(account).toMatch(/^rose-demo-/);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  return account;
}

test.describe("portfolio", () => {
  test.skip(!process.env.NEXT_PUBLIC_ENGINE_ACCOUNT, "NEXT_PUBLIC_ENGINE_ACCOUNT is not set for this build");
  test.describe.configure({ timeout: 180_000 });

  test("asks for a NEAR wallet, then shows holdings, claims, orders, liens, history and storage", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    await page.goto("/app");
    await page.evaluate(() => localStorage.setItem("rose.tour.dismissed", "1"));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Connect a NEAR wallet" })).toBeVisible({ timeout: 60_000 });
    await shot(page, "connect");
    state.account = await connectNearDemo(page);
    await expect(page.locator("[data-portfolio-stats]")).toBeVisible({ timeout: 60_000 });
    const holdings = page.locator("[data-holdings]");
    await expect(holdings.locator("tbody tr")).toHaveCount(2);
    await expect(holdings).toContainText("CINDR");
    await expect(holdings).toContainText("12.5000");
    await holdings.getByRole("button", { name: "Timeline" }).first().click();
    await expect(page.locator("[data-unlock-chart] svg")).toBeVisible();
    await expect(page.locator("[data-unlock-chart]").getByText("cliff")).toBeVisible();
    await shot(page, "loaded");
    const claims = page.locator("[data-claims]");
    await expect(claims.locator("[data-cash]")).toHaveCount(2);
    await expect(claims.locator("[data-token-claim='base']")).toHaveCount(2);
    await expect(claims.locator("[data-token-claim='solana']")).toHaveCount(2);
    await expect(claims.locator("[data-payout='12']")).toHaveAttribute("data-payout-state", "signed");
    await expect(claims.locator("[data-payout='11']")).toHaveAttribute("data-payout-state", "stale");
    await expect(claims.locator("[data-payout='9']")).toHaveAttribute("data-payout-state", "awaiting_gas");
    await expect(claims.getByRole("button", { name: "Submit on Base" })).toBeVisible();
    await expect(page.locator("[data-orders]")).toContainText("#8 Exit");
    await expect(page.locator("[data-orders]").getByRole("link", { name: /#8 Exit/ })).toHaveAttribute("href", "/app/rounds/8");
    await expect(page.locator("[data-lien='4']")).toContainText("3.0000 of 4.0000 delivered");
    await expect(page.locator("[data-lien-share='9']")).toBeVisible();
    await expect(page.locator("[data-history]")).toContainText("Failed: authority signature not produced");
    await expect(claims.locator("[data-payout='13']")).toHaveAttribute("data-payout-state", "requested");
    await expect(claims.locator("[data-payout='13']")).toContainText('"Retry signature" opens at block 276201100');
    const landed = page.locator("[data-history-payout='14']");
    await expect(landed).toContainText("Executed");
    await expect(landed.getByRole("link", { name: "Solana transaction ↗" })).toHaveAttribute("href", /^https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]{64,88}\?cluster=devnet$/);
    await expect(page.locator("[data-orders]")).toContainText("Bids and asks");
    if ((page.viewportSize()?.width ?? 0) < 768) {
      await expect(page.locator("[data-orders] thead")).toBeHidden();
      await expect(page.locator("[data-orders] [data-label='Escrow']").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await expect(page.locator("[data-storage]")).toContainText("Registered");
    expect(errors).toEqual([]);
  });

  test("claims NEAR tUSDC end to end through the demo wallet", async ({ page }) => {
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    const claims = page.locator("[data-claims]");
    await claims.locator("[data-cash='near']").getByRole("button", { name: "Claim" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: "Claim NEAR tUSDC" });
    await expect(dialog).toContainText("Claimable: 150.0000 tUSDC");
    await shot(page, "claim-dialog");
    await dialog.locator("[data-claim-confirm]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow).toHaveAttribute("data-flow-status", "completed", { timeout: 60_000 });
    await shot(page, "flow-done");
    await expect(flow.locator("[data-step='withdraw']")).toHaveAttribute("data-status", "done");
    await expect(flow.getByRole("link", { name: /near.rocks/ })).toHaveAttribute("href", `https://testnet.near.rocks/tx/${OUTCOME_HASH}`);
    await page.locator("[data-flow-close]").click();
    await expect(claims.locator("[data-cash='near']")).toHaveCount(0, { timeout: 60_000 });
  });

  test("opens the Base token claim with the destination prefilled and the withdrawMax step listed", async ({ page }) => {
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    await page.locator("[data-holdings] tbody tr").first().getByRole("button", { name: "Claim" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: /Claim CINDR on Base Sepolia/ });
    await expect(dialog).toContainText("Claimable: 12.5000 CINDR");
    await expect(dialog.getByRole("textbox", { name: /Destination/ })).toHaveValue("");
    await expect(dialog.locator("[data-claim-confirm]")).toBeDisabled();
    await dialog.getByRole("textbox", { name: /Destination/ }).fill("0x7d4777cfC6ed48061B0BcCae558D29919b412042");
    await dialog.locator("[data-claim-confirm]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow.locator("[data-step='withdraw-max']")).toBeVisible();
    await expect(flow.locator("[data-step='request']")).toBeVisible();
    await expect(flow.locator("[data-step='sign']")).toBeVisible();
    await expect(flow.locator("[data-step='submit']")).toBeVisible();
    await shot(page, "flow-base");
  });

  test("shows the Strategic streams and the swept balance, explains the 5-minute window, and syncs an ended stream", async ({ page }) => {
    const state = { account: "", withdrawn: false, synced: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    const section = page.locator("[data-sol-streams]");
    await expect(section).toBeVisible({ timeout: 60_000 });
    await expect(section).toContainText("except from 5 minutes before a stream's end");
    await expect(section.locator("[data-swept]")).toContainText("Swept balance 5,000.0000");
    await expect(section.locator("[data-sol-stream='2']")).toHaveAttribute("data-sol-stream-phase", "open");
    await expect(section.locator("[data-sol-stream='2'] [data-sol-stream-hint]")).toContainText("Draws stop 5 minutes before the end");
    const drawn = section.locator("[data-sol-stream='7']");
    await expect(drawn.locator("[data-sync-blocker]")).toContainText("Payout #15 draws on this stream and is not confirmed yet");
    await expect(drawn.locator("[data-sync]")).toBeDisabled();
    const ended = section.locator("[data-sol-stream='6']");
    await expect(ended.locator("[data-sol-stream-hint]")).toContainText("Streamflow's auto-claim moved 60,000.0000");
    if ((page.viewportSize()?.width ?? 0) < 768) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, "sol-streams");
    await ended.locator("[data-sync]").click();
    const flow = page.locator("[data-flow-dialog]");
    await expect(flow).toHaveAttribute("data-flow-status", "completed", { timeout: 60_000 });
    await expect(flow.locator("[data-step='read']")).toContainText("60,000.0000 withdrawn by the auto-claim, not booked yet");
    await expect(flow.locator("[data-step='read']").getByRole("link", { name: /explorer\.solana\.com|Solana/ }).first()).toHaveAttribute("href", `https://explorer.solana.com/tx/${AUTO_CLAIM_TX}?cluster=devnet`);
    await expect(flow.locator("[data-step='sync']")).toContainText("60,000.0000 booked in the swept balance");
    await expect(flow.getByRole("link", { name: /near.rocks/ })).toHaveAttribute("href", `https://testnet.near.rocks/tx/${OUTCOME_HASH}`);
    await shot(page, "sync-done");
    await page.locator("[data-flow-close]").click();
    await expect(section.locator("[data-sol-stream='6']")).toHaveCount(0, { timeout: 60_000 });
    await expect(section.locator("[data-swept]")).toContainText("Swept balance 65,000.0000");
  });

  test("tells a Solana claimant about the swept balance and the 5-minute window", async ({ page }) => {
    const state = { account: "", withdrawn: false };
    await mockChains(page, overrides(state));
    state.account = await connectNearDemo(page);
    await page.locator("[data-claims] [data-token-claim='solana']").first().getByRole("button", { name: "Claim" }).click({ timeout: 60_000 });
    const dialog = page.getByRole("dialog", { name: /on Solana devnet/ });
    await expect(dialog).toContainText("the class's swept balance first");
    await expect(dialog).toContainText("A stream pays nothing from 5 minutes before its end until its auto-claim is synced");
  });
});
