import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { mockChains } from "./engine-mock";

/**
 * The engine views the guided demo reads, recorded after the seed and the live end-to-end run of
 * each seeded staging engine (`get_round`, `get_bids`, `get_class`, `get_position`, `get_config`
 * and every readable `get_events` entry): `demo-engine-s4.json` (2026-11-04).
 * The suite uses the recording of the engine the app is built with (`NEXT_PUBLIC_ENGINE_ACCOUNT`).
 * `expected` holds the values of that run the walkthrough must show.
 */

interface Recording {
  engine: string;
  rounds: Record<string, unknown>;
  bids: Record<string, unknown>;
  classes: Record<string, unknown>;
  positions: Record<string, unknown>;
  config: unknown;
  events: { seq: string }[];
  total: string;
  oldest: string;
  expected: {
    /** First 16 hex characters of the SHA-256 of the Exit's first sealed order, as posted. */
    exitFirstSealedHash: string;
    /** The Exit's close-to-key latency as the step shows it. */
    exitKeyLatency: string;
    /** The verification gas of the Exit's first opening as the step shows it. */
    exitFirstOpeningGas: string;
    /** The no-key round's id. */
    noKeyRoundId: string;
    /** The position redeemed in kind at the end of the Advance walkthrough. */
    redeemedPositionId: string;
  };
}

const RECORDINGS = ["demo-engine-s4.json"].map(
  (file) => JSON.parse(readFileSync(resolve(import.meta.dirname, file), "utf8")) as Recording,
);

export const DEMO_RECORDING: Recording =
  RECORDINGS.find((recording) => recording.engine === process.env.NEXT_PUBLIC_ENGINE_ACCOUNT) ?? RECORDINGS[0]!;

/** The latest final block the rounds list reads its clock from: the recording's last event. */
function latestBlock() {
  const last = DEMO_RECORDING.events.at(-1) as { block_height: string; timestamp: string } | undefined;
  return { header: { height: Number(last?.block_height ?? 0) + 1_000, timestamp_nanosec: last?.timestamp ?? "0", hash: "6zKgP7tApq19qYQnbWw4FtzA6hnrnoWWLti88pM6jGYS" } };
}

/** Routes the chain reads to the recording; everything else falls back to the shared fixture. */
export async function mockDemoEngine(page: Page): Promise<void> {
  await mockChains(page, {
    nearRequest: (method) => (method === "block" ? latestBlock() : undefined),
    engineView: (method, args) => {
      switch (method) {
        case "get_round":
          return DEMO_RECORDING.rounds[String(args.round_id)] ?? null;
        case "get_bids":
          return DEMO_RECORDING.bids[String(args.round_id)] ?? [];
        case "get_class":
          return DEMO_RECORDING.classes[String(args.class_id)] ?? null;
        case "get_position":
          return DEMO_RECORDING.positions[String(args.position_id)] ?? null;
        case "get_config":
          return DEMO_RECORDING.config;
        case "get_events": {
          const from = BigInt(String(args.from_seq ?? DEMO_RECORDING.oldest));
          const limit = Number(args.limit ?? 100);
          const events = DEMO_RECORDING.events.filter((entry) => BigInt(entry.seq) >= from && BigInt(entry.seq) < from + BigInt(limit));
          return { events, total: DEMO_RECORDING.total, oldest: DEMO_RECORDING.oldest };
        }
        default:
          return undefined;
      }
    },
  });
}
