import { USDC_DECIMALS } from "@/lib/engine";
import { formatUnits } from "@/lib/format";

export type RoundKind = "Tender" | "Exit" | "Advance";

/**
 * `PricePoint` of `get_price_history` (`contracts/engine/src/types.rs`), JSON shape. `round_id` is
 * a `RoundId` (u64) serialized as a JSON number, unlike `get_rounds` whose `round_id` is a `U64`
 * string: every lookup across the two goes through `String(...)`.
 */
export type PricePoint = {
  round_id: string | number;
  kind: RoundKind;
  /** Clearing price per whole locked token (per claimed token in an Advance), cash base units. */
  price: string;
  /** Remaining lock duration at settlement, seconds. */
  remaining_lock_secs: string;
  /** Units traded (token base units). */
  volume: string;
  /** Settlement time (`closes_at`), nanoseconds. */
  settled_at: string;
};

export type ScheduleView =
  | { Linear: { start: string; cliff: string; end: string; granularity: string; start_unlock: string; cliff_unlock: string; total: string; min_deposit: string } }
  | { Stepped: { start: string; end: string; period: string; cliff_amount: string; amount_per_period: string; total: string } };

/** `ClassView` of `get_classes` (`contracts/engine/src/views.rs`), JSON shape. */
export type ClassView = {
  class_id: string;
  chain: "Base" | "Solana";
  token: string;
  decimals: number;
  schedule: ScheduleView;
  positions: number;
  total_units: string;
  fraction_now: string;
  created_at: string;
};

/** What a price is quoted per: a locked token (Tender, Exit) or a claimed token (Advance, spec 5.4). */
export type PriceUnit = "locked" | "claimed";

export const PRICE_UNIT_LABEL: Record<PriceUnit, string> = { locked: "USDC per locked token", claimed: "USDC per claimed token" };

export function priceUnitOf(kind: RoundKind): PriceUnit {
  return kind === "Advance" ? "claimed" : "locked";
}

export type PlottedPoint = {
  roundId: string;
  kind: RoundKind;
  /** USDC per locked token (per claimed token for an Advance), for plotting. */
  price: number;
  priceText: string;
  remainingLockDays: number;
  volumeText: string;
  settledAtMs: number;
  /** Issuer-declared reference price (Tender only), USDC per locked token. */
  referencePrice: number | null;
  referenceText: string | null;
  /** `1 - price / reference` when a reference exists. */
  discount: number | null;
};

export type ClassSeries = {
  /** `classId` for the locked-token line, `classId:claimed` for the Advance line of the same class. */
  key: string;
  unit: PriceUnit;
  classId: string;
  chain: "Base" | "Solana";
  token: string;
  tokenKey: string;
  decimals: number;
  label: string;
  scheduleEndMs: number;
  points: PlottedPoint[];
};

export type TokenGroup = { tokenKey: string; chain: "Base" | "Solana"; token: string; symbol: string; series: ClassSeries[] };

const SECONDS_PER_DAY = 86_400;

function nanosToMs(value: string): number {
  return Number(BigInt(value) / 1_000_000n);
}

export function scheduleEndSeconds(schedule: ScheduleView): number {
  return Number("Linear" in schedule ? schedule.Linear.end : schedule.Stepped.end);
}

export function tokenKeyOf(cls: Pick<ClassView, "chain" | "token">): string {
  return `${cls.chain}:${cls.token.toLowerCase()}`;
}

export function shortToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : token;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Fraction of the allocation that is unlocked now, as a percentage string. */
export function unlockedPercent(fractionNow: string): string {
  return `${(Number(BigInt(fractionNow) / 10n ** 15n) / 10).toFixed(1)}%`;
}

/** Human label of a class: the schedule end date and how much is unlocked today. */
export function classLabel(cls: ClassView): string {
  return `${cls.chain} · unlocks until ${formatDate(scheduleEndSeconds(cls.schedule) * 1_000)} · ${unlockedPercent(cls.fraction_now)} unlocked`;
}

/** `1 - price / reference`, or `null` without a positive reference. */
export function discountToReference(price: bigint, reference: bigint | null): number | null {
  if (reference === null || reference <= 0n) return null;
  return 1 - Number(price) / Number(reference);
}

export function toPlottedPoint(point: PricePoint, decimals: number, reference: bigint | null): PlottedPoint {
  const priceRaw = BigInt(point.price);
  const discount = discountToReference(priceRaw, reference);
  return {
    roundId: String(point.round_id),
    kind: point.kind,
    price: Number(priceRaw) / 10 ** USDC_DECIMALS,
    priceText: formatUnits(priceRaw, USDC_DECIMALS, 4),
    remainingLockDays: Number(point.remaining_lock_secs) / SECONDS_PER_DAY,
    volumeText: formatUnits(BigInt(point.volume), decimals, 2),
    settledAtMs: nanosToMs(point.settled_at),
    referencePrice: reference === null ? null : Number(reference) / 10 ** USDC_DECIMALS,
    referenceText: reference === null ? null : formatUnits(reference, USDC_DECIMALS, 4),
    discount,
  };
}

/**
 * One series per class for the per-locked-token prices (Tender, Exit), points in settlement
 * order, and a separate series for the class's Advance prices, which are per claimed token and
 * never share a line with them. `references` maps a Tender round id (the `get_rounds` string) to
 * the reference price its issuer declared at creation (absent for rounds without one).
 */
export function buildSeries(classes: readonly ClassView[], histories: ReadonlyMap<string, PricePoint[]>, references: ReadonlyMap<string, bigint>): ClassSeries[] {
  return classes.flatMap((cls) => {
    const points = (histories.get(cls.class_id) ?? [])
      .map((point) => toPlottedPoint(point, cls.decimals, point.kind === "Tender" ? (references.get(String(point.round_id)) ?? null) : null))
      .sort((a, b) => a.settledAtMs - b.settledAtMs || Number(a.roundId) - Number(b.roundId));
    const base = {
      classId: cls.class_id,
      chain: cls.chain,
      token: cls.token,
      tokenKey: tokenKeyOf(cls),
      decimals: cls.decimals,
      scheduleEndMs: scheduleEndSeconds(cls.schedule) * 1_000,
    };
    const locked: ClassSeries = { ...base, key: cls.class_id, unit: "locked", label: classLabel(cls), points: points.filter((point) => priceUnitOf(point.kind) === "locked") };
    const claimed = points.filter((point) => priceUnitOf(point.kind) === "claimed");
    if (claimed.length === 0) return [locked];
    const advance: ClassSeries = { ...base, key: `${cls.class_id}:claimed`, unit: "claimed", label: `${classLabel(cls)} · Advance`, points: claimed };
    return locked.points.length > 0 ? [locked, advance] : [advance];
  });
}

/** Groups series by token (chain and address or mint), tokens with the most settled rounds first. */
export function groupByToken(series: readonly ClassSeries[], symbols: ReadonlyMap<string, string>): TokenGroup[] {
  const groups = new Map<string, TokenGroup>();
  for (const item of series) {
    const group = groups.get(item.tokenKey);
    if (group) group.series.push(item);
    else groups.set(item.tokenKey, { tokenKey: item.tokenKey, chain: item.chain, token: item.token, symbol: symbols.get(item.tokenKey) ?? shortToken(item.token), series: [item] });
  }
  const settled = (group: TokenGroup) => group.series.reduce((sum, item) => sum + item.points.length, 0);
  return [...groups.values()].sort((a, b) => settled(b) - settled(a) || a.symbol.localeCompare(b.symbol));
}

/** The 1, 2, 5 progression step `niceTicks` uses for `count` ticks over `[min, max]`. */
function niceStep(min: number, max: number, count: number): number {
  const rough = (max - min) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  return (residual >= 7 ? 10 : residual >= 3 ? 5 : residual >= 1.5 ? 2 : 1) * magnitude;
}

/** Round numbers for an axis: at most `count` ticks on a 1, 2, 5 progression covering `[min, max]`. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max <= min) return [min];
  const step = niceStep(min, max, count);
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step / 2; tick += step) ticks.push(Number(tick.toFixed(10)));
  return ticks;
}

/**
 * `[0, top]` for prices (a price axis always starts at zero): `top` is the first tick of the
 * 5-tick progression at or above `max * 1.1`, so the highest price always sits under a labeled
 * gridline (0.036 gets a 0.04 line, not a 0.03 one with the point above it).
 */
export function priceDomain(values: readonly number[]): [number, number] {
  const max = Math.max(0, ...values);
  if (max === 0) return [0, 1];
  const padded = max * 1.1;
  const step = niceStep(0, padded, 5);
  return [0, Number((Math.ceil(padded / step - 1e-9) * step).toFixed(10))];
}

export function dayDomain(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const max = Math.max(...values);
  return [0, max === 0 ? 1 : max * 1.08];
}

/** Compact axis label: `1.2K`, `12`, `0.5`, `0.004` (two significant digits below 1, at most 6 decimals). */
export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (Number.isInteger(value)) return value.toString();
  const decimals = Math.abs(value) < 1 ? Math.min(6, Math.max(2, 1 - Math.floor(Math.log10(Math.abs(value))))) : 1;
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

/** Keeps the first tick of each distinct label, so a short time axis never repeats a date. */
export function distinctTicks(ticks: readonly number[], format: (value: number) => string): number[] {
  const seen = new Set<string>();
  return ticks.filter((tick) => {
    const label = format(tick);
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
