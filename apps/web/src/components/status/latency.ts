import { nanosToMillis, type StoredEvent } from "./events";

export type LatencySample = {
  /** Value of the pairing key (for example the round id). */
  key: string;
  requestedAt: number;
  completedAt: number;
  /** Milliseconds between the request and its completion. */
  latencyMs: number;
  /** How the completion arrived (`source` field of the completing event), when present. */
  source: string | null;
  completedBlock: string;
};

export type PendingRequest = { key: string; requestedAt: number; block: string; failures: number };

export type LatencyReport = {
  samples: LatencySample[];
  pending: PendingRequest[];
  failed: number;
  stats: { count: number; medianMs: number; p90Ms: number; minMs: number; maxMs: number } | null;
};

export type PairingSpec = {
  /** Event that starts the clock. */
  request: string;
  /** Event that stops it. */
  completion: string;
  /** Event recording a failed attempt (the clock keeps running for a retry). */
  failure?: string;
  /** Field of `data` shared by the request and its completion. */
  key: string;
};

/** Key requests of a round: `key_requested` until `key_received` (callback or `submit_key`). */
export const KEY_RELEASE: PairingSpec = { request: "key_requested", completion: "key_received", failure: "key_request_failed", key: "round_id" };

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

/**
 * Pairs each completion with the most recent open request of the same key. Events must be in
 * history order (ascending `seq`). A request that fails keeps its clock running until a retry
 * completes, which is what a user waiting on the round experiences.
 */
export function pairLatencies(events: readonly StoredEvent[], spec: PairingSpec): LatencyReport {
  const open = new Map<string, PendingRequest>();
  const samples: LatencySample[] = [];
  let failed = 0;
  for (const event of events) {
    const key = event.data[spec.key];
    if (key === undefined || key === null) continue;
    const id = String(key);
    if (event.event === spec.request) {
      const existing = open.get(id);
      if (!existing) open.set(id, { key: id, requestedAt: nanosToMillis(event.timestamp), block: event.block_height, failures: 0 });
    } else if (spec.failure && event.event === spec.failure) {
      failed += 1;
      const existing = open.get(id);
      if (existing) existing.failures += 1;
    } else if (event.event === spec.completion) {
      const request = open.get(id);
      if (!request) continue;
      open.delete(id);
      const completedAt = nanosToMillis(event.timestamp);
      samples.push({
        key: id,
        requestedAt: request.requestedAt,
        completedAt,
        latencyMs: Math.max(0, completedAt - request.requestedAt),
        source: typeof event.data.source === "string" ? event.data.source : null,
        completedBlock: event.block_height,
      });
    }
  }
  const sorted = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const stats =
    sorted.length === 0
      ? null
      : { count: sorted.length, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9), minMs: sorted[0]!, maxMs: sorted[sorted.length - 1]! };
  return { samples, pending: [...open.values()], failed, stats };
}

/** Formats a latency for display: `4.6 s`, `820 ms` or `2 min 05 s`. */
export function formatLatency(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 120_000) return `${(ms / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes} min ${seconds.toString().padStart(2, "0")} s`;
}
