/**
 * Engine access for the Rounds pages: typed views and call builders bound to the configured
 * engine account, the cursor-paginated `get_rounds`, class token symbols and the "not deployed"
 * detection shared by every fetcher.
 */

import { EngineCalls, EngineViews, NearRpc, NearRpcError, type ClassInfo, type Round, type RoundFilter, type RoundsPage } from "@rose/sdk";
import { NotDeployedError } from "@/components/status/useLiveQuery";
import { deployed, NEAR_READ_RPC_ENDPOINTS } from "@/lib/deployment";
import { tokenSymbols } from "@/lib/token-symbols";

export interface RoundsEngine {
  account: string;
  views: EngineViews;
  calls: EngineCalls;
}

let cached: RoundsEngine | null = null;

/** The engine from `NEXT_PUBLIC_ENGINE_ACCOUNT`, or null while nothing is deployed. */
export function roundsEngine(): RoundsEngine | null {
  const account = deployed("engineAccount");
  if (!account) return null;
  if (cached && cached.account === account) return cached;
  const rpc = new NearRpc({ endpoints: NEAR_READ_RPC_ENDPOINTS });
  cached = { account, views: new EngineViews(rpc, account), calls: new EngineCalls(account) };
  return cached;
}

/** Re-throws RPC failures that mean "nothing deployed" as `NotDeployedError`, so pages show the calm state. */
export function rethrowNotDeployed(error: unknown): never {
  if (error instanceof NearRpcError && (error.kind === "account_missing" || error.kind === "no_contract" || error.kind === "method_missing")) {
    throw new NotDeployedError(error.message);
  }
  throw error;
}

export const ROUNDS_PAGE_SIZE = 12;
/** Ids read per window when a filter is set (the engine scans at most 200 ids per `get_rounds` call). */
const FILTERED_WINDOW = 50n;
/** Windows read for one page before handing the cursor back (sparse filters). */
const MAX_WINDOWS = 5;

/** One call of `get_rounds`: the engine scans ids upwards from `from`, at most 200 per call. */
export function fetchRoundsPage(engine: Pick<RoundsEngine, "views">, filter: RoundFilter, from: bigint | null, limit = ROUNDS_PAGE_SIZE, signal?: AbortSignal): Promise<RoundsPage> {
  return engine.views.getRounds(Object.keys(filter).length > 0 ? filter : undefined, from ?? undefined, limit, { signal });
}

/**
 * The newest rounds first (the open ones are the newest), read in windows of ids below `before`
 * (exclusive; the first page starts at `stats().rounds_total`, the next round id). `get_rounds`
 * only scans upwards, so each window `[start, end)` is one call with `limit = end - start`: it
 * returns every match of the window (extra matches above `end` are dropped). Returns the rounds
 * newest first and the id to continue below, or null once id 0 was read.
 */
export async function fetchNewestRounds(engine: Pick<RoundsEngine, "views">, filter: RoundFilter, before: bigint, signal?: AbortSignal): Promise<{ rounds: Round[]; next: bigint | null }> {
  const span = Object.keys(filter).length > 0 ? FILTERED_WINDOW : BigInt(ROUNDS_PAGE_SIZE);
  const rounds: Round[] = [];
  let end = before;
  for (let windows = 0; windows < MAX_WINDOWS && end > 0n && rounds.length < ROUNDS_PAGE_SIZE; windows += 1) {
    const start = end > span ? end - span : 0n;
    const page = await fetchRoundsPage(engine, filter, start, Number(end - start), signal);
    const inWindow = page.rounds.filter((round) => round.roundId < end).sort((a, b) => (a.roundId > b.roundId ? -1 : a.roundId < b.roundId ? 1 : 0));
    rounds.push(...inWindow);
    end = start;
  }
  return { rounds, next: end > 0n ? end : null };
}

const CLASS_PAGE = 50;

/** Every class of the engine (the list is small: one per cohort). */
export async function fetchAllClasses(engine: RoundsEngine, signal?: AbortSignal): Promise<ClassInfo[]> {
  const out: ClassInfo[] = [];
  let from = 0;
  for (;;) {
    const page = await engine.views.getClasses(from, CLASS_PAGE, { signal });
    out.push(...page);
    if (page.length < CLASS_PAGE) return out;
    from += CLASS_PAGE;
  }
}

/** Symbols of the stream tokens of `classes`, read on chain (see `lib/token-symbols`). */
export function classSymbols(classes: readonly ClassInfo[]): Promise<Map<string, string>> {
  return tokenSymbols(classes.map((cls) => ({ chain: cls.chain, token: cls.token })));
}

export function symbolOf(symbols: ReadonlyMap<string, string>, cls: Pick<ClassInfo, "token">): string | null {
  return symbols.get(cls.token.toLowerCase()) ?? null;
}
