import { tokenKey, tokenSymbols } from "@/lib/token-symbols";
import { viewCall, type ViewOptions, type ViewResult } from "@/lib/engine";
import { tokenKeyOf, type ClassView, type PricePoint } from "./transforms";

const PAGE = 50;

/** Minimal `RoundView` fields the prices page reads from `get_rounds`. */
type RoundSummary = { round_id: string; kind: PricePoint["kind"]; reference_price: string | null };
type RoundsSummaryPage = { rounds: RoundSummary[]; next: string | null };

export type PricesData = {
  classes: ClassView[];
  histories: Map<string, PricePoint[]>;
  references: Map<string, bigint>;
  symbols: Map<string, string>;
  blockHeight: number;
};

async function fetchAllClasses(account: string, options: ViewOptions): Promise<{ classes: ClassView[]; blockHeight: number }> {
  const classes: ClassView[] = [];
  let from = 0;
  let blockHeight = 0;
  for (;;) {
    const page = await viewCall<ClassView[]>(account, "get_classes", { from_index: from, limit: PAGE }, options);
    blockHeight = page.blockHeight;
    classes.push(...page.value);
    if (page.value.length < PAGE) break;
    from += PAGE;
  }
  return { classes, blockHeight };
}

async function fetchReferencePrices(account: string, options: ViewOptions): Promise<Map<string, bigint>> {
  const references = new Map<string, bigint>();
  let from: string | null = null;
  for (;;) {
    const page: ViewResult<RoundsSummaryPage> = await viewCall(account, "get_rounds", { filter: { kind: "Tender", status: "Settled" }, from_index: from, limit: PAGE }, options);
    for (const round of page.value.rounds) {
      if (round.reference_price) references.set(String(round.round_id), BigInt(round.reference_price));
    }
    if (page.value.next === null) break;
    from = page.value.next;
  }
  return references;
}

/** Every point of a class's price history: `get_price_history` returns at most 50 per call with the total. */
export async function fetchPriceHistory(account: string, classId: string, options: ViewOptions): Promise<PricePoint[]> {
  const points: PricePoint[] = [];
  for (;;) {
    const page = await viewCall<{ points: PricePoint[]; total: number }>(account, "get_price_history", { class_id: classId, from_index: points.length, limit: PAGE }, options);
    points.push(...page.value.points);
    if (page.value.points.length === 0 || points.length >= page.value.total) return points;
  }
}

/** Everything the prices page plots, read live from the engine (token symbols from `lib/token-symbols`). */
export async function fetchPricesData(account: string, options: ViewOptions = {}): Promise<PricesData> {
  const { classes, blockHeight } = await fetchAllClasses(account, options);
  const [historyPages, references] = await Promise.all([Promise.all(classes.map((cls) => fetchPriceHistory(account, cls.class_id, options))), fetchReferencePrices(account, options)]);
  const histories = new Map(classes.map((cls, index) => [cls.class_id, historyPages[index] ?? []]));
  const resolved = await tokenSymbols(classes.map((cls) => ({ chain: cls.chain, token: cls.token })));
  const symbols = new Map<string, string>();
  for (const cls of classes) {
    const symbol = resolved.get(tokenKey(cls.token));
    if (symbol) symbols.set(tokenKeyOf(cls), symbol);
  }
  return { classes, histories, references, symbols, blockHeight };
}
