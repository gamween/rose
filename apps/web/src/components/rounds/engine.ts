/**
 * Engine access for the Rounds pages: typed views and call builders bound to the configured
 * engine account, the cursor-paginated `get_rounds`, token symbols and the "not deployed"
 * detection shared by every fetcher.
 */

import { EngineCalls, EngineViews, NearRpc, NearRpcError, type ClassInfo, type RoundFilter, type RoundsPage } from "@rose/sdk";
import { NotDeployedError } from "@/components/status/useLiveQuery";
import { deployed, NEAR_RPC_FALLBACK_URL, NEAR_RPC_URL } from "@/lib/deployment";
import { decodeString, ethCall, SELECTORS } from "@/components/status/rpc";

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
  const rpc = new NearRpc({ endpoints: [NEAR_RPC_URL, NEAR_RPC_FALLBACK_URL] });
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

/** One page of `get_rounds`: the engine scans at most 200 ids per call and returns the cursor to continue from. */
export function fetchRoundsPage(engine: RoundsEngine, filter: RoundFilter, from: bigint | null, limit = ROUNDS_PAGE_SIZE, signal?: AbortSignal): Promise<RoundsPage> {
  return engine.views.getRounds(Object.keys(filter).length > 0 ? filter : undefined, from ?? undefined, limit, { signal });
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

const symbolCache = new Map<string, Promise<string | null>>();

/** ERC-20 `symbol()` of a Base token through a raw `eth_call`, cached; null when the call fails (the UI then shows the address). */
export function baseTokenSymbol(token: string): Promise<string | null> {
  const key = token.toLowerCase();
  let pending = symbolCache.get(key);
  if (!pending) {
    pending = ethCall(token, SELECTORS["symbol()"])
      .then((hex) => {
        const symbol = decodeString(hex);
        return symbol.length > 0 ? symbol : null;
      })
      .catch(() => null);
    symbolCache.set(key, pending);
  }
  return pending;
}

/** Symbols of the stream tokens of `classes` (Base only; Solana mints show their address). */
export async function classSymbols(classes: readonly ClassInfo[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const base = [...new Set(classes.filter((cls) => cls.chain === "Base").map((cls) => cls.token.toLowerCase()))];
  const resolved = await Promise.all(base.map((token) => baseTokenSymbol(token)));
  base.forEach((token, index) => {
    const symbol = resolved[index];
    if (symbol) out.set(token, symbol);
  });
  return out;
}

export function symbolOf(symbols: ReadonlyMap<string, string>, cls: Pick<ClassInfo, "token">): string | null {
  return symbols.get(cls.token.toLowerCase()) ?? null;
}
