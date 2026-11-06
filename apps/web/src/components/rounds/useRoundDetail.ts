"use client";

/**
 * Everything the round detail page reads, in one query: the round, its sealed book, its class,
 * the engine limits and config (the CKD public key seals orders), and the viewer's own state
 * (cash in the round's venue, NEP-145 storage and what an Exit bid needs of it, holding,
 * existing orders). Polls faster while the MPC key is in flight.
 */

import type { Bid, Cash, ClassInfo, ConfigView, Holding, Limits, Round, StorageBalance } from "@rose/sdk";
import { readStorageContext, storageNeed, type StorageNeed } from "@/lib/engine-storage";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLiveQuery, type QueryState } from "@/components/status/useLiveQuery";
import { useWallets } from "@/components/wallet/WalletProvider";
import { classSymbols, rethrowNotDeployed, roundsEngine, symbolOf, type RoundsEngine } from "./engine";

export interface ViewerState {
  account: string;
  cash: Cash[];
  storage: StorageBalance | null;
  /** The storage deposit an Exit bid needs first (room for the holding row it buys, spec 4); null when covered or not an Exit. */
  bidStorage: StorageNeed | null;
  holding: Holding;
  buyOrderId: number | null;
  sellOrderId: number | null;
}

export interface RoundDetail {
  engine: RoundsEngine;
  round: Round;
  bids: Bid[];
  cls: ClassInfo;
  symbol: string | null;
  limits: Limits;
  config: ConfigView;
  viewer: ViewerState | null;
  blockTimeMs: number;
}

export class RoundNotFoundError extends Error {
  constructor(roundId: string) {
    super(`Round #${roundId} does not exist on this engine.`);
    this.name = "RoundNotFoundError";
  }
}

const POLL_MS = 12_000;
const FAST_POLL_MS = 3_000;

async function fetchDetail(roundId: bigint, viewerAccount: string | null, signal: AbortSignal): Promise<RoundDetail> {
  const engine = roundsEngine();
  if (!engine) throw new Error("engine not configured");
  try {
    const [round, bids, limits, config, block] = await Promise.all([
      engine.views.getRound(roundId, { signal }),
      engine.views.getBids(roundId, { signal }),
      engine.views.getLimits({ signal }),
      engine.views.getConfig({ signal }),
      engine.views.raw.rpc.block("final", signal),
    ]);
    if (!round) throw new RoundNotFoundError(roundId.toString());
    const cls = await engine.views.getClass(round.classId, { signal });
    if (!cls) throw new Error(`Class ${round.classId} of round #${roundId.toString()} is missing.`);
    const symbols = await classSymbols([cls]);
    let viewer: ViewerState | null = null;
    if (viewerAccount) {
      const [portfolio, storage, minimum, holding, buyOrderId, sellOrderId] = await Promise.all([
        engine.views.getPortfolio(viewerAccount, { signal }),
        engine.views.storageBalanceOf(viewerAccount, { signal }),
        engine.views.storageMinimum({ signal }),
        engine.views.getHolding(viewerAccount, round.classId, { signal }),
        engine.views.getOrderId(roundId, viewerAccount, "Buy", { signal }),
        engine.views.getOrderId(roundId, viewerAccount, "Sell", { signal }),
      ]);
      const change = { classId: round.classId };
      const bidStorage = round.kind === "Exit" ? storageNeed({ storage, minimum, portfolio, change, context: await readStorageContext(engine.views, portfolio, change, { signal, config, known: [round] }) }) : null;
      viewer = { account: viewerAccount, cash: portfolio.cash, storage, bidStorage, holding, buyOrderId, sellOrderId };
    }
    return { engine, round, bids, cls, symbol: symbolOf(symbols, cls), limits, config, viewer, blockTimeMs: Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) };
  } catch (error) {
    rethrowNotDeployed(error);
  }
}

export function useRoundDetail(roundId: bigint): { state: QueryState<RoundDetail>; refresh: () => void; retry: () => void; refreshing: boolean } {
  const { near } = useWallets();
  const viewerAccount = near.status === "connected" ? near.accountId : null;
  const [refreshKey, setRefreshKey] = useState(0);
  const fetcher = useCallback((signal: AbortSignal) => fetchDetail(roundId, viewerAccount, signal), [roundId, viewerAccount]);
  const { state, retry, refreshing } = useLiveQuery(fetcher, refreshKey);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const status = state.status === "ok" ? state.value.round.status : null;
  const fast = status === "KeyRequested";
  useEffect(() => {
    if (state.status === "not_deployed") return;
    const timer = window.setInterval(refresh, fast ? FAST_POLL_MS : POLL_MS);
    return () => window.clearInterval(timer);
  }, [fast, refresh, state.status]);

  return useMemo(() => ({ state, refresh, retry, refreshing }), [state, refresh, retry, refreshing]);
}
