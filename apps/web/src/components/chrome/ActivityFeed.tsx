"use client";

import { describeRoseEvent, engineViews, NearRpc, type EventAmountFormat, type StoredEvent } from "@rose/sdk";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Drawer } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { toActionError } from "@/lib/errors";
import { deployed, NEAR_READ_RPC_ENDPOINTS } from "@/lib/deployment";
import { eventAmountFormat, eventClassIds } from "@/lib/event-format";
import { readEventRange } from "@/lib/event-pages";
import { nearAccountUrl } from "@/lib/explorer";
import { ROUTES } from "@/lib/routes";

const FEED_LIMIT = 40;
const POLL_MS = 15_000;

type FeedState = { status: "loading" } | { status: "not_deployed" } | { status: "error"; message: string } | { status: "ok"; events: StoredEvent[]; total: bigint; format: EventAmountFormat };

/** Class decimals never change: read each class once per page load. */
const classDecimals = new Map<string, number | null>();

function roundHref(event: StoredEvent): string | null {
  const data = event.event.data as { round_id?: string };
  return typeof data.round_id === "string" ? `${ROUTES.rounds}/${data.round_id}` : null;
}

function timeAgo(timestampNs: bigint, now: number): string {
  const seconds = Math.max(0, Math.floor(now / 1000 - Number(timestampNs / 1_000_000_000n)));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
}

/** Reads the engine's bounded on-chain event history (`get_events`), newest first. */
export function useActivityFeed(enabled: boolean): { state: FeedState; refresh: () => Promise<void> } {
  const [state, setState] = useState<FeedState>({ status: "loading" });
  const engine = deployed("engineAccount");

  const refresh = useCallback(async () => {
    if (!engine) {
      setState({ status: "not_deployed" });
      return;
    }
    try {
      const views = engineViews(engine, new NearRpc({ endpoints: NEAR_READ_RPC_ENDPOINTS }));
      const probe = await views.getEvents(undefined, 1);
      const total = probe.total;
      const from = total > BigInt(FEED_LIMIT) ? total - BigInt(FEED_LIMIT) : 0n;
      const latest = await readEventRange((fromSeq, limit) => views.getEvents(fromSeq, limit), from > probe.oldest ? from : probe.oldest, FEED_LIMIT);
      const missing = eventClassIds(latest.events).filter((classId) => !classDecimals.has(classId));
      const infos = await Promise.all(missing.map((classId) => views.getClass(classId)));
      missing.forEach((classId, index) => classDecimals.set(classId, infos[index]?.decimals ?? null));
      const format = eventAmountFormat((classId) => classDecimals.get(classId) ?? null);
      setState({ status: "ok", events: [...latest.events].sort((a, b) => (a.seq < b.seq ? 1 : -1)), total, format });
    } catch (error) {
      const described = toActionError(error);
      setState(described.kind === "not_deployed" ? { status: "not_deployed" } : { status: "error", message: described.message });
    }
  }, [engine]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => void refresh();
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { state, refresh };
}

export function ActivityFeedList({ state }: { state: FeedState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  if (state.status === "loading") {
    return (
      <ul className="flex flex-col gap-2" aria-busy>
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i}>
            <Skeleton className="h-10 w-full" />
          </li>
        ))}
      </ul>
    );
  }
  if (state.status === "not_deployed") {
    return <EmptyState illustration="ledger" title="Engine not deployed yet" description="The activity feed reads the engine's on-chain event history. It fills up as soon as the engine is deployed and used." />;
  }
  if (state.status === "error") {
    return <EmptyState illustration="ember" title="Could not read the event history" description={state.message} />;
  }
  if (state.events.length === 0) {
    return <EmptyState illustration="ledger" title="No activity yet" description="Deposits, rounds, bids, openings and settlements appear here as they happen on chain." />;
  }
  return (
    <ol className="flex flex-col divide-y divide-ink-800" data-activity-feed>
      {state.events.map((entry) => {
        const href = roundHref(entry);
        const line = describeRoseEvent(entry.event, state.format);
        return (
          <li key={entry.seq.toString()} className="flex flex-col gap-0.5 py-2">
            <div className="flex items-start justify-between gap-3">
              {href ? (
                <Link href={href} className="text-[13px] text-ink-100 underline-offset-2 hover:underline">
                  {line}
                </Link>
              ) : (
                <span className="text-[13px] text-ink-100">{line}</span>
              )}
              <span className="tabular shrink-0 text-[11px] text-ink-400">{timeAgo(entry.timestamp, now)}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-ink-400">
              <span className="font-display uppercase tracking-wide">{entry.event.event.replace(/_/g, " ")}</span>
              <span aria-hidden>·</span>
              <a href={nearAccountUrl(entry.predecessor)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">
                {entry.predecessor}
              </a>
              <span aria-hidden>·</span>
              <span className="tabular">block {entry.blockHeight.toString()}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Global activity drawer opened from the top bar. */
export function ActivityFeedDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useActivityFeed(open);
  return (
    <Drawer open={open} onClose={onClose} title="Activity" description="Every engine event, read from the contract's bounded on-chain history. No indexer.">
      <ActivityFeedList state={state} />
    </Drawer>
  );
}
