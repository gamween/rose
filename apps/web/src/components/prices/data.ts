import { decodeString, ethCall, SELECTORS } from "@/components/status/rpc";
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
      if (round.reference_price) references.set(round.round_id, BigInt(round.reference_price));
    }
    if (page.value.next === null) break;
    from = page.value.next;
  }
  return references;
}

/** ERC-20 `symbol()` of a Base token, or `null` when the call fails (the page then shows the address). */
async function resolveBaseSymbol(token: string, options: ViewOptions): Promise<string | null> {
  try {
    return decodeString(await ethCall(token, SELECTORS["symbol()"], options));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return null;
  }
}

/** Everything the prices page plots, read live from the engine (and token symbols from Base). */
export async function fetchPricesData(account: string, options: ViewOptions = {}): Promise<PricesData> {
  const { classes, blockHeight } = await fetchAllClasses(account, options);
  const [historyPages, references] = await Promise.all([
    Promise.all(classes.map((cls) => viewCall<{ points: PricePoint[]; total: number }>(account, "get_price_history", { class_id: cls.class_id }, options))),
    fetchReferencePrices(account, options),
  ]);
  const histories = new Map(classes.map((cls, index) => [cls.class_id, historyPages[index]!.value.points]));
  const symbols = new Map<string, string>();
  const baseTokens = [...new Set(classes.filter((cls) => cls.chain === "Base").map((cls) => cls.token))];
  const resolved = await Promise.all(baseTokens.map((token) => resolveBaseSymbol(token, options)));
  baseTokens.forEach((token, index) => {
    const symbol = resolved[index];
    if (symbol) symbols.set(tokenKeyOf({ chain: "Base", token }), symbol);
  });
  return { classes, histories, references, symbols, blockHeight };
}
