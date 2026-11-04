"use client";

/**
 * One-click NEAR cash deposit (spec 4, 5.4): `ft_transfer_call` of tUSDC into the engine is a
 * voluntary receipt, refused (and refunded by the token) unless the sender is registered with
 * room for its cash row. The deposit therefore first sends the `storage_deposit` the account
 * misses (registration, or a top-up for the row), then the transfer, from one button.
 */

import { depositNearCashCall, type EngineCalls, type EngineViews, type FinalExecutionOutcome, type FunctionCall } from "@rose/sdk";
import { useEffect, useState } from "react";
import type { ExplorerLink } from "@/components/ui/Toast";
import { readStorageNeed, type StorageNeed } from "./engine-storage";
import { nearTxUrl, txLinks } from "./explorer";
import { formatUnits } from "./format";

export type NearCashEngine = { account: string; views: EngineViews; calls: EngineCalls };

export type NearCashDeposit = { storage: { need: StorageNeed; hash: string } | null; depositHash: string; links: ExplorerLink[] };

/** NEAR amount with five decimals (`0.00619`), the precision of a storage row. */
export function formatStorageNear(yocto: bigint): string {
  return formatUnits(yocto, 24, 5);
}

/**
 * Sends the storage deposit the account needs (if any), then `ft_transfer_call`. Each call is its
 * own transaction (two receivers), awaited before the next; a failed transfer leaves the storage
 * deposit in place (withdrawable), so a retry only sends the transfer.
 */
export async function depositNearCash(input: { send: (call: FunctionCall) => Promise<FinalExecutionOutcome>; engine: NearCashEngine; token: string; account: string; amount: bigint; onStorage?: (need: StorageNeed) => void }): Promise<NearCashDeposit> {
  const { send, engine, token, account, amount } = input;
  const need = await readStorageNeed(engine.views, account, { cashVenue: "Near" });
  let storage: NearCashDeposit["storage"] = null;
  if (need) {
    input.onStorage?.(need);
    const outcome = await send(engine.calls.storageDeposit(need.deposit));
    storage = { need, hash: outcome.transaction.hash };
  }
  const outcome = await send(depositNearCashCall(token, engine.account, amount));
  const depositHash = outcome.transaction.hash;
  const links: ExplorerLink[] = [...(storage ? [{ href: nearTxUrl(storage.hash), label: "Storage deposit on near.rocks" }] : []), ...txLinks("near", depositHash)];
  return { storage, depositHash, links };
}

/**
 * The storage deposit a NEAR cash deposit of `account` would send first, read live so the button
 * can say it before the click. `undefined` while reading or when it could not be read (the click
 * reads it again), `null` when nothing is needed.
 */
export function useNearCashStorageNeed(engine: NearCashEngine | null, account: string | null, refreshKey: unknown = 0): StorageNeed | null | undefined {
  const [state, setState] = useState<{ key: string; need: StorageNeed | null } | null>(null);
  const key = `${engine?.account ?? ""}:${account ?? ""}:${String(refreshKey)}`;
  useEffect(() => {
    if (!engine || !account) return;
    const controller = new AbortController();
    readStorageNeed(engine.views, account, { cashVenue: "Near" }, controller.signal)
      .then((need) => setState({ key, need }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [account, engine, key]);
  return state !== null && state.key === key ? state.need : undefined;
}

/** "Also sends a storage deposit of 0.00619 NEAR that registers your account…" for the deposit form. */
export function storageNotice(need: StorageNeed): string {
  const amount = `${formatStorageNear(need.deposit)} NEAR`;
  return need.kind === "register"
    ? `First deposit: your wallet also signs a storage deposit of ${amount} that registers your account in the engine (NEP-145), so it can hold cash and units. It stays yours and is withdrawable from the Portfolio.`
    : `Your wallet also signs a storage top-up of ${amount}: the engine accepts a deposit only when your NEP-145 storage covers your rows, the cash row included. It stays yours and is withdrawable from the Portfolio.`;
}
