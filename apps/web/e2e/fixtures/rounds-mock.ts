import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { encryptBid, loadIbeSync } from "@rose/ibe-wasm";
import { exit, tender, type Order } from "@rose/sdk/clearing";
import { ONE } from "@rose/sdk/math";
import { decodeSignedTransaction, KeyPair } from "near-api-js";

/**
 * A stateful engine for the Rounds pages: rounds in every status, real IBE ciphertexts sealed
 * to the live round-1 identity of `rose-ckd-1793753433.testnet` (whose round key is public in
 * `packages/ibe-wasm/test`), and transactions sent by the in-app demo wallet decoded with
 * near-api-js and applied to the state: place_bid, close, open_bid, clear, settle_bid,
 * create_exit, cash deposits and NEP-145 storage. Storage follows the engine's rule (spec 4): a
 * NEAR cash deposit and an Exit bid are refused unless the deposit covers the account's rows
 * plus the new one (record 137 bytes, holding row 310, cash row 172, 1e19 yoctoNEAR per byte).
 * Clearing runs the SDK reference, so the Verify panel sees a consistent on-chain result.
 */

export const ROUNDS_MOCK = {
  engine: "rose-ckd-1793753433.testnet",
  mpk: "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj",
  round1Key: "bls12381g1:6znYwWzn6SVgzXFKy7zEmZA6CR2aS317nJXuWKAmmeEdnrc3Qp6dX7EfE26GZBA889",
  demoAccount: "rose-demo-e2e.testnet",
  demoToken: "0x4444444444444444444444444444444444444444",
  tusdc: "tusdc.rose-app.testnet",
} as const;

const SEED = "a".repeat(64);
const KOL = "b".repeat(64);
const STRATEGIC = "c".repeat(64);
const DAY = 86_400;
const E18 = 10n ** 18n;
const USDC = 1_000_000n;
const QUARTER = 250_000_000_000_000_000n;
/** Units of a class when its rounds were created: the largest buy quantity of an Exit (spec 5.2). */
const CLASS_SUPPLY = 400n * E18;

type Side = "Buy" | "Sell";

interface MockBid {
  bid_id: number;
  bidder: string;
  side: Side;
  status: "Sealed" | "Opened" | "Void" | "Settled";
  escrow: bigint;
  locked_units: bigint;
  bond: bigint;
  fee: bigint;
  cash: bigint;
  fill_quantity: bigint;
  ciphertext_hex: string | null;
  opened: { quantity: bigint; price: bigint } | null;
  void: string | null;
  settled: boolean;
}

interface MockRound {
  round_id: number;
  kind: "Tender" | "Exit" | "Advance";
  class_id: string;
  venue: "Near" | { Base: { token: string } };
  creator: string;
  phase: "Bidding" | "KeyRequested" | "Revealing" | "Settled" | "Cancelled";
  opens_at: number;
  closes_at: number;
  key_timeout: number;
  reveal_window: number;
  max_price: bigint;
  f_ts: bigint;
  remaining_lock_secs: number;
  created_at: number;
  budget: bigint | null;
  issuer_escrow: bigint | null;
  reference_price: bigint | null;
  retire_to: string | null;
  advance_units: bigint | null;
  advance_claim: bigint | null;
  advance_min_fill: bigint | null;
  close_requested_at: number | null;
  key: string | null;
  key_source: "Callback" | "Submitted" | null;
  key_received_at: number | null;
  reveal_ends_at: number | null;
  ended_at: number | null;
  cancel_reason: string | null;
  result: { price: bigint; volume: bigint; notional: bigint; fee: bigint; issuer_charged: bigint; issuer_refund: bigint } | null;
  bids: MockBid[];
  /** Pending key delivery: the key lands after this many `get_round` reads. */
  keyAfterReads: number;
}

function ns(seconds: number): string {
  return `${String(Math.floor(seconds))}000000000`;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function randomHash(): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return base58(bytes);
}

const BLOCK_HASH = "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS";

let ibeLoaded = false;
function ensureIbe(): void {
  if (ibeLoaded) return;
  loadIbeSync(readFileSync(resolve(import.meta.dirname, "../../../../packages/ibe-wasm/pkg/rose_ibe_bg.wasm")));
  ibeLoaded = true;
}

function seal(roundId: number, bidder: string, side: Side, quantity: bigint, price: bigint): string {
  ensureIbe();
  return encryptBid({ mpk: ROUNDS_MOCK.mpk, engineAccount: ROUNDS_MOCK.engine, roundId: BigInt(roundId), bidder, side }, { quantity, limitPrice: price }).ciphertextHex;
}

function bondOfBuyer(escrow: bigint): bigint {
  const pct = escrow / 100n;
  return pct > USDC ? pct : USDC;
}

function chargeOf(fTs: bigint, decimals: number, qty: bigint, price: bigint, up: boolean): bigint {
  const locked = ONE - fTs;
  const num = qty * locked * price;
  const den = ONE * 10n ** BigInt(decimals);
  return up ? (num + den - 1n) / den : num / den;
}

function bid(bid_id: number, bidder: string, side: Side, collateral: bigint, ciphertext_hex: string | null, extra: Partial<MockBid> = {}): MockBid {
  const valuationBond = side === "Buy" ? bondOfBuyer(collateral) : USDC;
  return {
    bid_id,
    bidder,
    side,
    status: "Sealed",
    escrow: side === "Buy" ? collateral : 0n,
    locked_units: side === "Sell" ? collateral : 0n,
    bond: valuationBond,
    fee: 0n,
    cash: 0n,
    fill_quantity: 0n,
    ciphertext_hex,
    opened: null,
    void: null,
    settled: false,
    ...extra,
  };
}

function round(round_id: number, kind: MockRound["kind"], now: number, overrides: Partial<MockRound>): MockRound {
  return {
    round_id,
    kind,
    class_id: SEED,
    venue: "Near",
    creator: "alice.testnet",
    phase: "Bidding",
    opens_at: now - 3600,
    closes_at: now + 3600,
    key_timeout: 3600,
    reveal_window: 600,
    max_price: 10n * USDC,
    f_ts: QUARTER,
    remaining_lock_secs: 275 * DAY,
    created_at: now - 7200,
    budget: null,
    issuer_escrow: null,
    reference_price: null,
    retire_to: null,
    advance_units: null,
    advance_claim: null,
    advance_min_fill: null,
    close_requested_at: null,
    key: null,
    key_source: null,
    key_received_at: null,
    reveal_ends_at: null,
    ended_at: null,
    cancel_reason: null,
    result: null,
    bids: [],
    keyAfterReads: 0,
    ...overrides,
  };
}

export interface RoundsMockState {
  rounds: Map<number, MockRound>;
  cash: bigint;
  /** NEP-145 deposit of the demo account in the engine; null while it is not registered. */
  storage: bigint | null;
  walletTusdc: bigint;
  /** Units of the seed class (round 1's class). */
  holding: bigint;
  /** Units of other classes, each a holding row the storage pays for. */
  otherHoldings: Record<string, bigint>;
  sent: { method: string; args: Record<string, unknown>; deposit: bigint }[];
}

function settledTender(id: number, now: number): MockRound {
  const asks: Order[] = [
    { id: 0n, qty: 30n * E18, price: 5n * USDC },
    { id: 1n, qty: 40n * E18, price: 8n * USDC },
    { id: 2n, qty: 20n * E18, price: 8n * USDC },
  ];
  const result = tender({ asks, budget: 400n * USDC, maxPrice: 10n * USDC, pricing: { lockedFractionE18: ONE, tokenDecimals: 18 } });
  if (result.outcome !== "cleared") throw new Error("fixture tender must clear");
  const sellers = ["halden.testnet", "tessaro.testnet", "marlow.testnet"];
  const bids = asks.map((ask, index) =>
    bid(index, sellers[index] ?? "x.testnet", "Sell", ask.qty, null, {
      status: "Settled",
      opened: { quantity: ask.qty, price: ask.price },
      fill_quantity: result.asks[index]?.qty ?? 0n,
      cash: result.asks[index]?.cash ?? 0n,
      settled: index !== 2,
    }),
  );
  const fee = (result.charged * 30n + 9_999n) / 10_000n;
  return round(id, "Tender", now, {
    creator: "cindral.testnet",
    phase: "Settled",
    opens_at: now - 3 * DAY,
    closes_at: now - 2 * DAY,
    f_ts: 0n,
    budget: 400n * USDC,
    issuer_escrow: 400n * USDC + fee,
    reference_price: 10n * USDC,
    retire_to: "0x000000000000000000000000000000000000dead",
    close_requested_at: now - 2 * DAY + 20,
    key: "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL",
    key_source: "Callback",
    key_received_at: now - 2 * DAY + 25,
    reveal_ends_at: now - 2 * DAY + 625,
    ended_at: now - 2 * DAY + 700,
    result: { price: result.price, volume: result.volume, notional: result.charged, fee, issuer_charged: result.charged, issuer_refund: result.refund },
    bids,
  });
}

function buildState(now: number): RoundsMockState {
  const rounds = new Map<number, MockRound>();
  rounds.set(
    1,
    round(1, "Exit", now, {
      bids: [bid(0, "halden.testnet", "Buy", 500n * USDC, seal(1, "halden.testnet", "Buy", 50n * E18, 8n * USDC)), bid(1, "tessaro.testnet", "Sell", 100n * E18, seal(1, "tessaro.testnet", "Sell", 80n * E18, 6_500_000n), { bond: 7_500_000n })],
    }),
  );
  rounds.set(2, settledTender(2, now));
  rounds.set(
    3,
    round(3, "Exit", now, {
      class_id: KOL,
      phase: "Cancelled",
      cancel_reason: "NoCrossing",
      opens_at: now - 5 * DAY,
      closes_at: now - 4 * DAY,
      close_requested_at: now - 4 * DAY + 10,
      key: "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL",
      key_source: "Submitted",
      key_received_at: now - 4 * DAY + 40,
      reveal_ends_at: now - 4 * DAY + 640,
      ended_at: now - 4 * DAY + 700,
      bids: [bid(0, "ines.testnet", "Buy", 60n * USDC, null, { status: "Settled", opened: { quantity: 10n * E18, price: 5n * USDC }, settled: true }), bid(1, "varick.testnet", "Sell", 10n * E18, null, { status: "Settled", opened: { quantity: 10n * E18, price: 8n * USDC }, settled: true })],
    }),
  );
  rounds.set(
    4,
    round(4, "Advance", now, {
      creator: "teodor.testnet",
      class_id: KOL,
      max_price: 12n * USDC,
      advance_units: 200n * E18,
      advance_claim: 100n * E18,
      advance_min_fill: 40n * E18,
      closes_at: now + 2 * DAY,
      bids: [bid(0, "teodor.testnet", "Sell", 100n * E18, "cd".repeat(192), { bond: 12n * USDC })],
    }),
  );
  rounds.set(
    5,
    round(5, "Exit", now, {
      phase: "KeyRequested",
      opens_at: now - DAY,
      closes_at: now - 60,
      close_requested_at: now - 55,
      bids: [bid(0, "halden.testnet", "Buy", 120n * USDC, "ab".repeat(192)), bid(1, "ines.testnet", "Buy", 80n * USDC, "ac".repeat(192)), bid(2, "tessaro.testnet", "Sell", 40n * E18, "ad".repeat(192))],
    }),
  );
  rounds.set(
    6,
    round(6, "Tender", now, {
      creator: "cindral.testnet",
      phase: "Revealing",
      budget: 1_000n * USDC,
      issuer_escrow: 1_003n * USDC,
      opens_at: now - DAY,
      closes_at: now - 120,
      close_requested_at: now - 110,
      key: "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL",
      key_source: "Callback",
      key_received_at: now - 105,
      reveal_ends_at: now - 105 + 600,
      bids: [
        bid(0, "halden.testnet", "Sell", 100n * E18, "ae".repeat(192), { status: "Opened", opened: { quantity: 100n * E18, price: 7n * USDC }, bond: 7_500_000n }),
        bid(1, "tessaro.testnet", "Sell", 50n * E18, "af".repeat(192), { status: "Opened", opened: { quantity: 40n * E18, price: 9n * USDC }, bond: 3_750_000n }),
        bid(2, "marlow.testnet", "Sell", 20n * E18, "b0".repeat(192), { bond: 1_500_000n }),
        bid(3, "varick.testnet", "Sell", 10n * E18, "b1".repeat(192)),
      ],
    }),
  );
  rounds.set(7, round(7, "Exit", now, { class_id: STRATEGIC, opens_at: now + 2 * 3600, closes_at: now + DAY, created_at: now - 600 }));
  for (let id = 8; id <= 20; id += 1) {
    rounds.set(
      id,
      round(id, "Exit", now, {
        class_id: id % 2 === 0 ? SEED : KOL,
        phase: "Settled",
        opens_at: now - (30 - id) * DAY,
        closes_at: now - (29 - id) * DAY,
        ended_at: now - (29 - id) * DAY + 800,
        result: { price: BigInt(6_000_000 + id * 100_000), volume: 10n * E18, notional: 45n * USDC, fee: 135_000n, issuer_charged: 0n, issuer_refund: 0n },
        bids: [bid(0, "ines.testnet", "Buy", 60n * USDC, null, { status: "Settled", opened: { quantity: 10n * E18, price: 7n * USDC }, fill_quantity: 10n * E18, cash: 45n * USDC, settled: true }), bid(1, "varick.testnet", "Sell", 10n * E18, null, { status: "Settled", opened: { quantity: 10n * E18, price: 5n * USDC }, fill_quantity: 10n * E18, cash: 45n * USDC, settled: true })],
      }),
    );
  }
  return { rounds, cash: 0n, storage: null, walletTusdc: 1_000n * USDC, holding: 0n, otherHoldings: {}, sent: [] };
}

function status(r: MockRound, now: number): string {
  switch (r.phase) {
    case "Bidding":
      return now < r.opens_at ? "Scheduled" : "Open";
    case "KeyRequested":
      return "KeyRequested";
    case "Revealing":
      return r.reveal_ends_at !== null && now < r.reveal_ends_at ? "Revealing" : "Clearing";
    case "Settled":
      return "Settled";
    case "Cancelled":
      return "Cancelled";
  }
}

function bidView(r: MockRound, b: MockBid): Record<string, unknown> {
  return {
    round_id: String(r.round_id),
    bid_id: b.bid_id,
    bidder: b.bidder,
    side: b.side,
    status: b.settled ? "Settled" : b.void ? "Void" : b.opened ? "Opened" : "Sealed",
    escrow: b.escrow.toString(),
    locked_units: b.locked_units.toString(),
    bond: b.bond.toString(),
    fee: b.fee.toString(),
    cash: b.cash.toString(),
    fill_quantity: b.fill_quantity.toString(),
    ciphertext_hex: b.ciphertext_hex,
    placed_at: ns(r.opens_at + 10),
    opened: b.opened ? { quantity: b.opened.quantity.toString(), price: b.opened.price.toString() } : null,
    void: b.void,
  };
}

function roundView(r: MockRound, now: number): Record<string, unknown> {
  const st = status(r, now);
  return {
    round_id: String(r.round_id),
    kind: r.kind,
    class_id: r.class_id,
    venue: r.venue,
    creator: r.creator,
    status: st,
    app_id: "305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5",
    opens_at: ns(r.opens_at),
    closes_at: ns(r.closes_at),
    key_timeout: ns(r.key_timeout),
    reveal_window: ns(r.reveal_window),
    max_price: r.max_price.toString(),
    f_ts: r.f_ts.toString(),
    remaining_lock_secs: String(r.remaining_lock_secs),
    bid_count: r.bids.length,
    opened_count: r.bids.filter((b) => b.opened !== null).length,
    settled_count: r.bids.filter((b) => b.settled).length,
    created_at: ns(r.created_at),
    budget: r.budget?.toString() ?? null,
    issuer_escrow: r.issuer_escrow?.toString() ?? null,
    reference_price: r.reference_price?.toString() ?? null,
    retire_to: r.retire_to,
    advance_units: r.advance_units?.toString() ?? null,
    advance_claim: r.advance_claim?.toString() ?? null,
    advance_min_fill: r.advance_min_fill?.toString() ?? null,
    max_buy_quantity: r.kind === "Exit" ? CLASS_SUPPLY.toString() : r.kind === "Advance" ? (r.advance_claim?.toString() ?? null) : null,
    lien_id: null,
    close_requested_at: r.close_requested_at === null ? null : ns(r.close_requested_at),
    key: r.key,
    key_source: r.key_source,
    key_received_at: r.key_received_at === null ? null : ns(r.key_received_at),
    reveal_ends_at: r.reveal_ends_at === null ? null : ns(r.reveal_ends_at),
    ended_at: r.ended_at === null ? null : ns(r.ended_at),
    cancel_reason: r.cancel_reason,
    result: r.result
      ? {
          price: r.result.price.toString(),
          volume: r.result.volume.toString(),
          notional: r.result.notional.toString(),
          fee: r.result.fee.toString(),
          issuer_charged: r.result.issuer_charged.toString(),
          issuer_refund: r.result.issuer_refund.toString(),
          remaining_lock_secs: String(r.remaining_lock_secs),
          fills: r.bids.map((b) => ({ ...bidView(r, b), settled: b.settled })),
        }
      : null,
  };
}

const classes = (now: number) => [
  {
    class_id: SEED,
    chain: "Base",
    token: ROUNDS_MOCK.demoToken,
    token_risk: "",
    decimals: 18,
    schedule: { Linear: { start: String(now - 90 * DAY), cliff: String(now - 60 * DAY), end: String(now + 275 * DAY), granularity: "1", start_unlock: "0", cliff_unlock: "1", total: "10", min_deposit: "1" } },
    positions: 4,
    total_units: "400000000000000000000000",
    fraction_now: QUARTER.toString(),
    created_at: ns(now - 80 * DAY),
  },
  {
    class_id: KOL,
    chain: "Base",
    token: ROUNDS_MOCK.demoToken,
    token_risk: "",
    decimals: 18,
    schedule: { Linear: { start: String(now - 30 * DAY), cliff: String(now - 30 * DAY), end: String(now + 150 * DAY), granularity: "1", start_unlock: "0", cliff_unlock: "0", total: "1", min_deposit: "1" } },
    positions: 2,
    total_units: "50000000000000000000000",
    fraction_now: "166000000000000000",
    created_at: ns(now - 25 * DAY),
  },
  {
    class_id: STRATEGIC,
    chain: "Solana",
    token: "3q81mxTA7rricmjJQaiZk9HbZzF2Pt8aN5SJaJcXvZ4w",
    token_risk: "",
    decimals: 9,
    schedule: { Stepped: { start: String(now - 60 * DAY), end: String(now + 305 * DAY), period: "86400", cliff_amount: "0", amount_per_period: "1", total: "365" } },
    positions: 1,
    total_units: "120000000000000",
    fraction_now: "164000000000000000",
    created_at: ns(now - 50 * DAY),
  },
];

function leU128(hex: string): bigint {
  let value = 0n;
  for (let i = 15; i >= 0; i -= 1) value = value * 256n + BigInt(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return value;
}

function clearExit(r: MockRound): void {
  const bids: Order[] = [];
  const asks: Order[] = [];
  for (const b of r.bids) {
    if (!b.opened) {
      b.void = "Unopened";
      continue;
    }
    if (b.opened.price > r.max_price) continue;
    (b.side === "Buy" ? bids : asks).push({ id: BigInt(b.bid_id), qty: b.opened.quantity, price: b.opened.price });
  }
  const result = exit({ bids, asks, pricing: { lockedFractionE18: ONE - r.f_ts, tokenDecimals: 18 } });
  const now = Math.floor(Date.now() / 1000);
  r.ended_at = now;
  if (result.outcome === "no_crossing") {
    r.phase = "Cancelled";
    r.cancel_reason = "NoCrossing";
    return;
  }
  r.phase = "Settled";
  const fee = (result.notional * 30n + 9_999n) / 10_000n;
  r.result = { price: result.price, volume: result.volume, notional: result.notional, fee, issuer_charged: 0n, issuer_refund: 0n };
  for (const fill of [...result.bids, ...result.asks]) {
    const b = r.bids[Number(fill.id)];
    if (!b) continue;
    b.fill_quantity = fill.qty;
    b.cash = fill.cash;
    if (b.side === "Buy") b.fee = (fill.cash * 30n + 9_999n) / 10_000n;
  }
}

export const BYTE_COST = 10n ** 19n;
export const STORAGE_MIN = 619n * BYTE_COST;

/** Bytes the engine charges the demo account for: its record, holding rows and cash row. */
function usedBytes(state: RoundsMockState): bigint {
  const holdings = (state.holding > 0n ? 1n : 0n) + BigInt(Object.values(state.otherHoldings).filter((units) => units > 0n).length);
  return 137n + holdings * 310n + (state.cash > 0n ? 172n : 0n);
}

/** The engine's `require_storage_capacity`. */
function requireCapacity(state: RoundsMockState, extraBytes: bigint): void {
  if (state.storage === null) throw new Error(`Account ${ROUNDS_MOCK.demoAccount} is not registered: call storage_deposit first`);
  if ((usedBytes(state) + extraBytes) * BYTE_COST > state.storage) throw new Error(`Insufficient storage deposit for ${ROUNDS_MOCK.demoAccount}: top up with storage_deposit`);
}

function storageView(state: RoundsMockState): { total: string; available: string } | null {
  if (state.storage === null) return null;
  const floor = usedBytes(state) * BYTE_COST > STORAGE_MIN ? usedBytes(state) * BYTE_COST : STORAGE_MIN;
  return { total: state.storage.toString(), available: (state.storage > floor ? state.storage - floor : 0n).toString() };
}

/** Applies one decoded function call to the state and returns the JSON return value. */
function apply(state: RoundsMockState, method: string, args: Record<string, unknown>, receiver: string, deposit: bigint): unknown {
  const now = Math.floor(Date.now() / 1000);
  state.sent.push({ method, args, deposit });
  const roundOf = () => {
    const r = state.rounds.get(Number(args.round_id));
    if (!r) throw new Error(`Round ${String(args.round_id)} does not exist`);
    return r;
  };
  if (receiver === ROUNDS_MOCK.tusdc && method === "ft_transfer_call") {
    const amount = BigInt(String(args.amount));
    requireCapacity(state, state.cash > 0n ? 0n : 172n);
    state.walletTusdc -= amount;
    state.cash += amount;
    return "0";
  }
  switch (method) {
    case "storage_deposit":
      if (state.storage === null && deposit < STORAGE_MIN) throw new Error(`Attach the storage deposit for ${ROUNDS_MOCK.demoAccount}: ${STORAGE_MIN.toString()} yoctoNEAR`);
      state.storage = (state.storage ?? 0n) + deposit;
      return storageView(state);
    case "place_bid": {
      const r = roundOf();
      if (r.kind === "Exit") requireCapacity(state, (r.class_id === SEED ? state.holding : (state.otherHoldings[r.class_id] ?? 0n)) > 0n ? 0n : 310n);
      const escrow = BigInt(String(args.escrow));
      const b = bid(r.bids.length, ROUNDS_MOCK.demoAccount, "Buy", escrow, String(args.ciphertext_hex));
      state.cash -= escrow + b.bond;
      r.bids.push(b);
      r.closes_at = now - 1;
      return b.bid_id;
    }
    case "place_ask": {
      const r = roundOf();
      const units = BigInt(String(args.units));
      const b = bid(r.bids.length, ROUNDS_MOCK.demoAccount, "Sell", units, String(args.ciphertext_hex), { bond: bondOfBuyer(chargeOf(r.f_ts, 18, units, r.max_price, true)) });
      state.cash -= b.bond;
      state.holding -= units;
      r.bids.push(b);
      return b.bid_id;
    }
    case "close": {
      const r = roundOf();
      r.phase = "KeyRequested";
      r.close_requested_at = now;
      r.keyAfterReads = 2;
      return null;
    }
    case "cancel_no_key":
    case "cancel_round": {
      const r = roundOf();
      r.phase = "Cancelled";
      r.cancel_reason = method === "cancel_round" ? "Creator" : "NoKey";
      r.ended_at = now;
      return null;
    }
    case "open_bid": {
      const r = roundOf();
      const b = r.bids[Number(args.bid_id)];
      if (!b) throw new Error("no such bid");
      const plaintext = String(args.plaintext_hex);
      b.opened = { quantity: leU128(plaintext.slice(0, 32)), price: leU128(plaintext.slice(32, 64)) };
      b.status = "Opened";
      if (r.bids.every((x) => x.opened !== null)) r.reveal_ends_at = now - 1;
      return null;
    }
    case "clear": {
      clearExit(roundOf());
      return null;
    }
    case "settle_bid": {
      const r = roundOf();
      const b = r.bids[Number(args.bid_id)];
      if (!b) throw new Error("no such bid");
      b.settled = true;
      b.status = "Settled";
      if (b.side === "Buy") state.cash += b.escrow - b.cash - b.fee + (b.void ? 0n : b.bond);
      else state.cash += b.cash + (b.void ? 0n : b.bond);
      return null;
    }
    case "create_exit": {
      const params = args.params as { class_id: string; venue: MockRound["venue"]; max_price: string; window: { closes_at: string } };
      const id = Math.max(...state.rounds.keys()) + 1;
      state.rounds.set(id, round(id, "Exit", now, { class_id: params.class_id, venue: params.venue, creator: ROUNDS_MOCK.demoAccount, max_price: BigInt(params.max_price), opens_at: now, closes_at: Number(BigInt(params.window.closes_at) / 1_000_000_000n), created_at: now }));
      return String(id);
    }
    default:
      throw new Error(`Unmocked change method ${method}`);
  }
}

function view(state: RoundsMockState, method: string, args: Record<string, unknown>, account: string): unknown {
  const now = Math.floor(Date.now() / 1000);
  if (account === ROUNDS_MOCK.tusdc) {
    if (method === "ft_balance_of") return state.walletTusdc.toString();
    if (method === "ft_metadata") return { spec: "ft-1.0.0", name: "Test USDC", symbol: "tUSDC", decimals: 6 };
    throw new Error(`Unmocked tUSDC view ${method}`);
  }
  switch (method) {
    case "get_config":
      return {
        mpc_account: "v1.signer-prod.testnet",
        sign_secp256k1_domain: 0,
        sign_ed25519_domain: 1,
        ckd_domain: 2,
        foreign_tx_domain: 3,
        ckd_public_key: ROUNDS_MOCK.mpk,
        fee_recipient: "treasury.rose-app.testnet",
        rose_vault: "0x1111111111111111111111111111111111111111",
        sablier_lockup: "0xa65a1ecef02c2b9bdc604951c6a6d02335d4532e",
        base_cash_tokens: ["0x3333333333333333333333333333333333333333"],
        base_chain_id: 84532,
        streamflow_program: "HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ",
        near_cash_token: ROUNDS_MOCK.tusdc,
        default_key_timeout: ns(3600),
        default_reveal_window: ns(600),
        derived_addresses: null,
      };
    case "get_limits":
      return { bid_storage_deposit: "20000000000000000000000", round_storage_deposit: "50000000000000000000000", bond_floor: "1000000", fee_bps: 30, max_bids_per_round: 64, max_distribution_receivers: 50, min_key_timeout: ns(60), max_key_timeout: ns(7 * 86_400), min_reveal_window: ns(300), max_reveal_window: ns(7 * 86_400), max_round_horizon: ns(30 * 86_400) };
    case "get_classes": {
      const from = Number(args.from_index ?? 0);
      return classes(now).slice(from, from + Number(args.limit ?? 50));
    }
    case "get_class":
      return classes(now).find((cls) => cls.class_id === args.class_id) ?? null;
    case "get_round": {
      const r = state.rounds.get(Number(args.round_id));
      if (!r) return null;
      if (r.phase === "KeyRequested" && r.keyAfterReads > 0) {
        r.keyAfterReads -= 1;
        if (r.keyAfterReads === 0) {
          r.phase = "Revealing";
          r.key = r.round_id === 1 ? ROUNDS_MOCK.round1Key : "bls12381g1:7KUB3YJyD2SdDtLWzNsnPEiWRtSigsAZVoVXLjnj9HHKic9TP1AbWjqoshCMk1HhGL";
          r.key_source = "Callback";
          r.key_received_at = now;
          r.reveal_ends_at = now + r.reveal_window;
        }
      }
      return roundView(r, now);
    }
    case "get_rounds": {
      const filter = (args.filter ?? {}) as { kind?: string; class_id?: string; status?: string };
      const from = Number(args.from_index ?? 0);
      const limit = Number(args.limit ?? 20);
      const ids = [...state.rounds.keys()].sort((a, b) => a - b).filter((id) => id >= from);
      const rounds: unknown[] = [];
      let next: string | null = null;
      for (const id of ids) {
        if (rounds.length === limit) {
          next = String(id);
          break;
        }
        const r = state.rounds.get(id);
        if (!r) continue;
        if (filter.kind && r.kind !== filter.kind) continue;
        if (filter.class_id && r.class_id !== filter.class_id) continue;
        if (filter.status && status(r, now) !== filter.status) continue;
        rounds.push(roundView(r, now));
      }
      return { rounds, next };
    }
    case "get_bids": {
      const r = state.rounds.get(Number(args.round_id));
      return r ? r.bids.map((b) => bidView(r, b)) : [];
    }
    case "get_order_id": {
      const r = state.rounds.get(Number(args.round_id));
      const found = r?.bids.find((b) => b.bidder === args.account && b.side === args.side);
      return found ? found.bid_id : null;
    }
    case "get_cash":
      return args.account === ROUNDS_MOCK.demoAccount ? [{ venue: "Near", amount: state.cash.toString() }] : [];
    case "storage_balance_of":
      return args.account_id === ROUNDS_MOCK.demoAccount ? storageView(state) : null;
    case "storage_balance_bounds":
      return { min: STORAGE_MIN.toString(), max: null };
    case "get_portfolio": {
      if (args.account !== ROUNDS_MOCK.demoAccount) return { holdings: [], bids: [], liens_held: [], lien_shares: [], cash: [{ venue: "Near", amount: "0" }] };
      const held: [string, bigint][] = [[SEED, state.holding], ...Object.entries(state.otherHoldings)];
      return {
        holdings: held.filter(([, units]) => units > 0n).map(([class_id, units]) => ({ class_id, balance: units.toString(), locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "0" })),
        bids: [],
        liens_held: [],
        lien_shares: [],
        cash: [{ venue: "Near", amount: state.cash.toString() }],
      };
    }
    case "get_holding":
      return { class_id: args.class_id, balance: (args.class_id === SEED ? state.holding : (state.otherHoldings[String(args.class_id)] ?? 0n)).toString(), locked_in_rounds: "0", encumbered: "0", claimable: "0", checkpoint: "0" };
    case "get_events":
      return { events: [], total: "0", oldest: "0" };
    case "stats":
      return { rounds_total: state.rounds.size, rounds_settled: 15, volume_settled_usdc: "2184000000", classes: 3, positions: 7 };
    case "get_price_history":
      return { points: [], total: 0 };
    default:
      throw new Error(`Unmocked view ${method}`);
  }
}

function viewResult(value: unknown) {
  return { result: [...new TextEncoder().encode(JSON.stringify(value))], logs: [], block_height: 276_200_000, block_hash: BLOCK_HASH };
}

async function fulfil(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

function rpcError(id: string, message: string) {
  return { jsonrpc: "2.0", id, error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: message } };
}

/** The demo NEAR wallet the pages restore from localStorage. */
export function demoWalletScript(): string {
  const pair = KeyPair.fromRandom("ed25519");
  const wallet = { accountId: ROUNDS_MOCK.demoAccount, publicKey: pair.getPublicKey().toString(), secretKey: pair.toString(), createdAt: Date.now() };
  return `localStorage.setItem("rose.demo.near", ${JSON.stringify(JSON.stringify(wallet))}); localStorage.setItem("rose.wallet.near.preferred", ${JSON.stringify(JSON.stringify("demo"))});`;
}

/** Routes every chain RPC the Rounds pages call to the stateful engine above. */
export async function mockRounds(page: Page): Promise<RoundsMockState> {
  const state = buildState(Math.floor(Date.now() / 1000));
  await page.addInitScript(`localStorage.setItem("rose.tour.dismissed", "1");`);
  let nonce = 100;
  const handle = async (route: Route) => {
    const request = route.request().postDataJSON() as { id: string; method: string; params: Record<string, unknown> };
    const params = request.params;
    if (request.method === "block") {
      const now = Math.floor(Date.now() / 1000);
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { header: { height: 276_200_000, hash: BLOCK_HASH, timestamp: now * 1e9, timestamp_nanosec: ns(now) } } });
    }
    if (request.method === "send_tx") {
      const bytes = Buffer.from(String(params.signed_tx_base64), "base64");
      const signed = decodeSignedTransaction(new Uint8Array(bytes));
      const action = signed.transaction.actions[0];
      const call = action?.functionCall;
      if (!call) return fulfil(route, rpcError(request.id, "unsupported action"));
      const args = JSON.parse(Buffer.from(call.args).toString("utf8")) as Record<string, unknown>;
      const hash = randomHash();
      let value: unknown;
      try {
        value = apply(state, call.methodName, args, signed.transaction.receiverId, BigInt(call.deposit.toString()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fulfil(route, {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            final_execution_status: "EXECUTED_OPTIMISTIC",
            status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } } } } },
            transaction: { hash, signer_id: signed.transaction.signerId, receiver_id: signed.transaction.receiverId, nonce: nonce++, public_key: signed.transaction.publicKey.toString(), actions: [] },
            transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: signed.transaction.signerId, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } } } } } } },
            receipts_outcome: [],
          },
        });
      }
      const encoded = value === null || value === undefined ? "" : Buffer.from(JSON.stringify(value)).toString("base64");
      return fulfil(route, {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          final_execution_status: "EXECUTED_OPTIMISTIC",
          status: { SuccessValue: encoded },
          transaction: { hash, signer_id: signed.transaction.signerId, receiver_id: signed.transaction.receiverId, nonce: nonce++, public_key: signed.transaction.publicKey.toString(), actions: [] },
          transaction_outcome: { id: hash, outcome: { logs: [], receipt_ids: [randomHash()], gas_burnt: 2_428_000_000_000, tokens_burnt: "242800000000000000000", executor_id: signed.transaction.signerId, status: { SuccessReceiptId: randomHash() } } },
          receipts_outcome: [{ id: randomHash(), outcome: { logs: [], receipt_ids: [], gas_burnt: 3_000_000_000_000, tokens_burnt: "300000000000000000000", executor_id: signed.transaction.receiverId, status: { SuccessValue: encoded } } }],
        },
      });
    }
    if (params.request_type === "view_access_key") {
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { nonce: nonce++, permission: "FullAccess", block_height: 276_200_000, block_hash: BLOCK_HASH } });
    }
    if (params.request_type === "view_access_key_list") {
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { block_hash: BLOCK_HASH, block_height: 276_200_000, keys: [] } });
    }
    if (params.request_type === "view_account") {
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { amount: "9999853133514356400000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1000, storage_paid_at: 0, block_height: 276_200_000, block_hash: BLOCK_HASH } });
    }
    if (params.request_type === "call_function") {
      const args = JSON.parse(Buffer.from(String(params.args_base64), "base64").toString("utf8")) as Record<string, unknown>;
      try {
        return await fulfil(route, { jsonrpc: "2.0", id: request.id, result: viewResult(view(state, String(params.method_name), args, String(params.account_id))) });
      } catch (error) {
        return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { error: `wasm execution failed with error: ${error instanceof Error ? error.message : String(error)}`, logs: [], block_height: 276_200_000, block_hash: BLOCK_HASH } });
      }
    }
    return fulfil(route, rpcError(request.id, `unmocked ${request.method}`));
  };
  await page.route("https://test.rpc.fastnear.com/**", handle);
  await page.route("https://rpc.testnet.near.org/**", handle);
  await page.route("https://sepolia.base.org/**", async (route) => {
    const request = route.request().postDataJSON() as { id: number; method: string; params: unknown[] };
    if (request.method === "eth_call") {
      const text = "CINDR";
      const hex = Buffer.from(text).toString("hex").padEnd(64, "0");
      return fulfil(route, { jsonrpc: "2.0", id: request.id, result: `0x${"20".padStart(64, "0")}${text.length.toString(16).padStart(64, "0")}${hex}` });
    }
    if (request.method === "eth_chainId") return fulfil(route, { jsonrpc: "2.0", id: request.id, result: "0x14a34" });
    return fulfil(route, { jsonrpc: "2.0", id: request.id, result: "0x0" });
  });
  await page.route("https://api.devnet.solana.com/**", async (route) => {
    const request = route.request().postDataJSON() as { id: number };
    return fulfil(route, { jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value: 0 } });
  });
  return state;
}
