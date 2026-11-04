/**
 * Reads of the Advance page: open and scheduled Advances for funders, the holder's free units
 * and cash for the create form, and the account's liens.
 */

import { type Cash, type ClassInfo, type ConfigView, type Holding, type Lien, type LienShare, type Limits, type Round } from "@rose/sdk";
import { requireEngine, nearRpc } from "@/lib/engine-client";
import { tokenSymbols } from "@/lib/token-symbols";

const PAGE = 50;

export type AdvanceData = {
  config: ConfigView;
  limits: Limits;
  classes: Map<string, ClassInfo>;
  symbols: Map<string, string>;
  /** Open first, then scheduled, newest first within each. */
  rounds: Round[];
  /** Settled and cancelled Advances, newest first: their round pages keep the results. */
  past: Round[];
  holdings: Holding[];
  cash: Cash[];
  liens: { held: Lien[]; shares: LienShare[] };
  blockTimeSec: bigint;
};

async function pagedRounds(status: "Open" | "Scheduled" | "Settled" | "Cancelled", signal: AbortSignal): Promise<Round[]> {
  const { views } = requireEngine();
  const rounds: Round[] = [];
  let from: bigint | undefined;
  for (;;) {
    const page = await views.getRounds({ kind: "Advance", status }, from, PAGE, { signal });
    rounds.push(...page.rounds);
    if (page.next === null) return rounds;
    from = page.next;
  }
}

async function allClasses(signal: AbortSignal): Promise<Map<string, ClassInfo>> {
  const { views } = requireEngine();
  const classes = new Map<string, ClassInfo>();
  for (let from = 0; ; from += PAGE) {
    const page = await views.getClasses(from, PAGE, { signal });
    for (const info of page) classes.set(info.classId, info);
    if (page.length < PAGE) return classes;
  }
}

function symbolsOf(classes: ReadonlyMap<string, ClassInfo>, cashTokens: readonly string[]): Promise<Map<string, string>> {
  return tokenSymbols([...[...classes.values()].map((info) => ({ chain: info.chain, token: info.token })), ...cashTokens.map((token) => ({ chain: "Base" as const, token }))]);
}

export async function fetchAdvanceData(account: string | null, signal: AbortSignal): Promise<AdvanceData> {
  const { views } = requireEngine();
  const [config, limits, classes, open, scheduled, settled, cancelled, portfolio, liens, block] = await Promise.all([
    views.getConfig({ signal }),
    views.getLimits({ signal }),
    allClasses(signal),
    pagedRounds("Open", signal),
    pagedRounds("Scheduled", signal),
    pagedRounds("Settled", signal),
    pagedRounds("Cancelled", signal),
    account ? views.getPortfolio(account, { signal }) : Promise.resolve(null),
    account ? views.getLiens(account, { signal }) : Promise.resolve({ held: [], shares: [] }),
    nearRpc().block("final", signal),
  ]);
  const byNewest = (a: Round, b: Round) => (a.roundId > b.roundId ? -1 : 1);
  return {
    config,
    limits,
    classes,
    symbols: await symbolsOf(classes, config.base_cash_tokens),
    rounds: [...open.sort(byNewest), ...scheduled.sort(byNewest)],
    past: [...settled, ...cancelled].sort(byNewest),
    holdings: portfolio?.holdings ?? [],
    cash: portfolio?.cash ?? [],
    liens,
    blockTimeSec: BigInt(block.header.timestamp_nanosec) / 1_000_000_000n,
  };
}
