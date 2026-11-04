"use client";

/**
 * Live reads behind the guided demo: the scenario's round, its bids and stored result, its
 * class, the positions deposited into the class, and the engine's on-chain history. Read once per
 * scenario: a seeded round is settled, nothing changes under it.
 */

import type { Bid, ClassInfo, Position, Round, StoredEvent } from "@rose/sdk";
import { useCallback } from "react";
import { classSymbols, rethrowNotDeployed, roundsEngine, symbolOf } from "@/components/rounds/engine";
import { useLiveQuery, type QueryState } from "@/components/status/useLiveQuery";
import type { DemoScenario } from "@/lib/demo/manifest";
import { readEventRange } from "@/lib/event-pages";

export interface DemoLive {
  engine: string;
  round: Round;
  bids: Bid[];
  cls: ClassInfo;
  symbol: string | null;
  positions: Position[];
  events: StoredEvent[];
  /** History entries the engine could not deserialize (skipped, see `lib/event-pages.ts`). */
  skippedEvents: number;
}

const EVENTS_PAGE = 100;

async function fetchLive(scenario: DemoScenario, signal: AbortSignal): Promise<DemoLive> {
  const engine = roundsEngine();
  if (!engine) throw new Error("The engine is not configured.");
  const roundId = BigInt(scenario.roundId);
  try {
    const [round, bids, probe, positions] = await Promise.all([
      engine.views.getRound(roundId, { signal }),
      engine.views.getBids(roundId, { signal }),
      engine.views.getEvents(undefined, 1, { signal }),
      Promise.all(scenario.positions.map((position) => engine.views.getPosition(BigInt(position.positionId), { signal }))),
    ]);
    if (!round) throw new Error(`Round #${scenario.roundId} does not exist on ${engine.account}.`);
    const cls = await engine.views.getClass(round.classId, { signal });
    if (!cls) throw new Error(`The class of round #${scenario.roundId} is missing.`);
    const [symbols, history] = await Promise.all([
      classSymbols([cls]),
      (async () => {
        let events: StoredEvent[] = [];
        let skipped = 0;
        for (let next = probe.oldest; next < probe.total; next += BigInt(EVENTS_PAGE)) {
          const page = await readEventRange((fromSeq, limit) => engine.views.getEvents(fromSeq, limit, { signal }), next, EVENTS_PAGE);
          events = [...events, ...page.events];
          skipped += page.skipped.length;
        }
        return { events, skipped };
      })(),
    ]);
    return {
      engine: engine.account,
      round,
      bids,
      cls,
      symbol: symbolOf(symbols, cls),
      positions: positions.filter((position): position is Position => position !== null),
      events: history.events,
      skippedEvents: history.skipped,
    };
  } catch (error) {
    rethrowNotDeployed(error);
  }
}

export function useDemoRound(scenario: DemoScenario): { state: QueryState<DemoLive>; retry: () => void } {
  const fetcher = useCallback((signal: AbortSignal) => fetchLive(scenario, signal), [scenario]);
  const { state, retry } = useLiveQuery(fetcher, 0);
  return { state, retry };
}
