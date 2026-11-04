import type { Page, Route } from "@playwright/test";

/**
 * Deterministic chain responses for the pages that read the engine, Base Sepolia and Solana
 * devnet in the browser: a deployed, keyless engine with three classes of one demo token, settled
 * rounds (two with an issuer-declared reference), key releases and verified deposits.
 */

export const MOCK = {
  engine: "engine.rose-app.testnet",
  vault: "0x1111111111111111111111111111111111111111",
  signer: "0x2222222222222222222222222222222222222222",
  lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e",
  baseTusdc: "0x3333333333333333333333333333333333333333",
  demoToken: "0x4444444444444444444444444444444444444444",
  vaultSol: "5vaultSoLAddress111111111111111111111111111",
  gasSol: "5gasSoLAddress1111111111111111111111111111",
  codeHash: "7JHPYMQ1o7QVhVyMwmzzxS3vVhyqEkcWQrGJUcmubizP",
} as const;

const SEED = "a".repeat(64);
const KOL = "b".repeat(64);
const STRATEGIC = "c".repeat(64);

const NOW_SEC = 1_762_200_000;
const DAY = 86_400;

function ns(seconds: number): string {
  return `${seconds}000000000`;
}

const classes = [
  {
    class_id: SEED,
    chain: "Base",
    token: MOCK.demoToken,
    decimals: 18,
    schedule: { Linear: { start: String(NOW_SEC - 90 * DAY), cliff: String(NOW_SEC - 60 * DAY), end: String(NOW_SEC + 275 * DAY), granularity: "1", start_unlock: "0", cliff_unlock: "1", total: "10", min_deposit: "1" } },
    positions: 4,
    total_units: "400000000000000000000000",
    fraction_now: "250000000000000000",
    created_at: ns(NOW_SEC - 80 * DAY),
  },
  {
    class_id: KOL,
    chain: "Base",
    token: MOCK.demoToken,
    decimals: 18,
    schedule: { Linear: { start: String(NOW_SEC - 30 * DAY), cliff: String(NOW_SEC - 30 * DAY), end: String(NOW_SEC + 150 * DAY), granularity: "1", start_unlock: "0", cliff_unlock: "0", total: "1", min_deposit: "1" } },
    positions: 2,
    total_units: "50000000000000000000000",
    fraction_now: "166000000000000000",
    created_at: ns(NOW_SEC - 25 * DAY),
  },
  {
    class_id: STRATEGIC,
    chain: "Solana",
    token: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w",
    decimals: 9,
    schedule: { Stepped: { start: String(NOW_SEC - 60 * DAY), end: String(NOW_SEC + 305 * DAY), period: "86400", cliff_amount: "0", amount_per_period: "1", total: "365" } },
    positions: 1,
    total_units: "120000000000000",
    fraction_now: "164000000000000000",
    created_at: ns(NOW_SEC - 50 * DAY),
  },
];

const history: Record<string, unknown[]> = {
  [SEED]: [
    { round_id: "1", kind: "Tender", price: "7200000", remaining_lock_secs: String(320 * DAY), volume: "120000000000000000000000", settled_at: ns(NOW_SEC - 45 * DAY) },
    { round_id: "3", kind: "Exit", price: "7850000", remaining_lock_secs: String(300 * DAY), volume: "40000000000000000000000", settled_at: ns(NOW_SEC - 25 * DAY) },
    { round_id: "5", kind: "Exit", price: "8400000", remaining_lock_secs: String(288 * DAY), volume: "25000000000000000000000", settled_at: ns(NOW_SEC - 13 * DAY) },
    { round_id: "7", kind: "Tender", price: "8100000", remaining_lock_secs: String(278 * DAY), volume: "60000000000000000000000", settled_at: ns(NOW_SEC - 3 * DAY) },
  ],
  [KOL]: [
    { round_id: "4", kind: "Exit", price: "9100000", remaining_lock_secs: String(170 * DAY), volume: "8000000000000000000000", settled_at: ns(NOW_SEC - 20 * DAY) },
    { round_id: "6", kind: "Advance", price: "9600000", remaining_lock_secs: String(158 * DAY), volume: "5000000000000000000000", settled_at: ns(NOW_SEC - 8 * DAY) },
  ],
  [STRATEGIC]: [{ round_id: "2", kind: "Exit", price: "6900000", remaining_lock_secs: String(340 * DAY), volume: "30000000000000", settled_at: ns(NOW_SEC - 35 * DAY) }],
};

const tenders = [
  { round_id: "1", kind: "Tender", status: "Settled", reference_price: "10000000" },
  { round_id: "7", kind: "Tender", status: "Settled", reference_price: "9500000" },
];

function event(seq: number, seconds: number, name: string, data: Record<string, unknown>) {
  return { seq: String(seq), block_height: String(276_000_000 + seq * 7), timestamp: ns(seconds), predecessor: "alice.testnet", event: name, data };
}

const events = [
  event(0, NOW_SEC - 80 * DAY, "class_created", { class_id: SEED }),
  event(1, NOW_SEC - 79 * DAY, "position_registered", { position_id: "0", class_id: SEED, depositor: "halden.testnet", allocation: "100000000000000000000000" }),
  event(2, NOW_SEC - 78 * DAY, "position_registered", { position_id: "1", class_id: SEED, depositor: "tessaro.testnet", allocation: "150000000000000000000000" }),
  event(3, NOW_SEC - 46 * DAY, "key_requested", { round_id: "1" }),
  event(4, NOW_SEC - 46 * DAY + 5, "key_received", { round_id: "1", source: "Callback", key: "bls12381g1:abc" }),
  event(5, NOW_SEC - 36 * DAY, "key_requested", { round_id: "2" }),
  event(6, NOW_SEC - 36 * DAY + 4, "key_received", { round_id: "2", source: "Callback", key: "bls12381g1:def" }),
  event(7, NOW_SEC - 26 * DAY, "key_requested", { round_id: "3" }),
  event(8, NOW_SEC - 26 * DAY + 2, "key_request_failed", { round_id: "3" }),
  event(9, NOW_SEC - 26 * DAY + 30, "key_requested", { round_id: "3" }),
  event(10, NOW_SEC - 26 * DAY + 35, "key_received", { round_id: "3", source: "Submitted", key: "bls12381g1:ghi" }),
  event(11, NOW_SEC - 21 * DAY, "position_registered", { position_id: "2", class_id: STRATEGIC, depositor: "varick.testnet", allocation: "120000000000000" }),
  event(12, NOW_SEC - 4 * DAY, "key_requested", { round_id: "7" }),
  event(13, NOW_SEC - 4 * DAY + 6, "key_received", { round_id: "7", source: "Callback", key: "bls12381g1:jkl" }),
  event(14, NOW_SEC - 1 * DAY, "key_requested", { round_id: "8" }),
];

const config = {
  mpc_account: "v1.signer-prod.testnet",
  sign_secp256k1_domain: 0,
  sign_ed25519_domain: 1,
  ckd_domain: 2,
  foreign_tx_domain: 3,
  ckd_public_key: "bls12381g2:abc",
  fee_recipient: "treasury.rose-app.testnet",
  near_cash_token: "tusdc.rose-app.testnet",
  base_cash_tokens: [MOCK.baseTusdc],
  rose_vault: MOCK.vault,
  sablier_lockup: MOCK.lockup,
  streamflow_program: "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ",
  default_key_timeout: "3600000000000",
  default_reveal_window: "600000000000",
  derived_addresses: { vault_base: MOCK.signer, vault_sol: MOCK.vaultSol, gas_sol: MOCK.gasSol },
};

function viewResult(value: unknown) {
  const bytes = [...new TextEncoder().encode(JSON.stringify(value))];
  return { result: bytes, logs: [], block_height: 276_200_000, block_hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" };
}

function engineView(method: string, args: Record<string, unknown>): unknown {
  switch (method) {
    case "version":
      return "3.18.0";
    case "ft_metadata":
      return { spec: "ft-1.0.0", name: "Test USDC", symbol: "tUSDC", decimals: 6 };
    case "ft_total_supply":
      return "1000000000";
    case "get_config":
      return config;
    case "get_classes": {
      const from = Number(args.from_index ?? 0);
      return classes.slice(from, from + Number(args.limit ?? 50));
    }
    case "get_class":
      return classes.find((cls) => cls.class_id === args.class_id) ?? null;
    case "get_price_history":
      return history[String(args.class_id)] ?? [];
    case "get_rounds": {
      const from = Number(args.from_index ?? 0);
      return tenders.slice(from, from + Number(args.limit ?? 50));
    }
    case "get_events": {
      const from = Number(args.from_seq ?? 0);
      return { events: events.filter((item) => Number(item.seq) >= from).slice(0, Number(args.limit ?? 200)), total: String(events.length), oldest: "0" };
    }
    case "stats":
      return { rounds_total: 8, rounds_settled: 7, volume_settled_usdc: "2184000000", classes: 3, positions: 3 };
    default:
      throw new Error(`Unmocked view ${method}`);
  }
}

function word(hex: string): string {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function abiString(text: string): string {
  const bytes = [...new TextEncoder().encode(text)];
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `0x${word("20")}${word(bytes.length.toString(16))}${hex.padEnd(64, "0")}`;
}

function baseCall(to: string, data: string): string {
  const selector = data.slice(0, 10);
  switch (selector) {
    case "0x582abd12":
      return `0x${word(MOCK.signer)}`;
    case "0x845aef4b":
      return `0x${word(MOCK.lockup)}`;
    case "0x95d89b41":
      return abiString(to.toLowerCase() === MOCK.demoToken ? "CINDR" : "tUSDC");
    case "0x313ce567":
      return `0x${word("6")}`;
    case "0x18160ddd":
      return `0x${word("2540be400")}`;
    default:
      throw new Error(`Unmocked selector ${selector}`);
  }
}

async function fulfil(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

/** Routes every chain RPC the pages call to the fixture above. */
export async function mockChains(page: Page): Promise<void> {
  await page.route("https://test.rpc.fastnear.com/**", async (route) => {
    const request = route.request().postDataJSON() as { id: string; params: Record<string, string> };
    const params = request.params;
    if (params.request_type === "view_access_key_list") {
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { block_hash: "h", block_height: 276_200_000, keys: [] } });
    }
    if (params.request_type === "view_account") {
      return fulfil(route, {
        jsonrpc: "2.0",
        id: request.id,
        result: { amount: "2999853133514356400000000", locked: "0", code_hash: MOCK.codeHash, storage_usage: 160_793, block_height: 276_200_000, block_hash: "h" },
      });
    }
    const args = JSON.parse(Buffer.from(params.args_base64!, "base64").toString("utf8")) as Record<string, unknown>;
    return fulfil(route, { jsonrpc: "2.0", id: request.id, result: viewResult(engineView(params.method_name!, args)) });
  });
  await page.route("https://sepolia.base.org/**", async (route) => {
    const request = route.request().postDataJSON() as { id: number; method: string; params: [{ to: string; data: string } | string] };
    if (request.method === "eth_getCode") return fulfil(route, { jsonrpc: "2.0", id: request.id, result: "0x6080" });
    const call = request.params[0] as { to: string; data: string };
    return fulfil(route, { jsonrpc: "2.0", id: request.id, result: baseCall(call.to, call.data) });
  });
  await page.route("https://api.devnet.solana.com/**", async (route) => {
    const request = route.request().postDataJSON() as { id: number; params: [string] };
    const value = request.params[0] === MOCK.gasSol ? 9_647_107_580 : 2_039_280;
    return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { context: { slot: 518_422_893, apiVersion: "4.4.0" }, value } });
  });
}
