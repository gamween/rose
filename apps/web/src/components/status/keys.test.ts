import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./events";
import { keylessCheck, isStagingEngine } from "./keys";
import { FOREIGN_TX, pairLatencies } from "./latency";
import { balanceOfData } from "./rpc";
import { countOutcomes, foreignTxOutcome, replayKeyLabel, type ForeignTxOutcome } from "./verifications";

/** The live answer of `view_access_key_list engine-s4.rose-app.testnet` (2026-11-04). */
const ENGINE_S4_KEYS = [{ public_key: "ed25519:2mj79igw48kJVRb7G5Kj2iEzg2xWhKBaSuXWAhSTJxat", access_key: { nonce: 276_000_000_000_010, permission: "FullAccess" } }];

describe("keyless check", () => {
  it("calls an engine keyless only when its key list is empty", () => {
    const keyless = keylessCheck("engine.rose-app.testnet", []);
    expect(keyless.keyless).toBe(true);
    expect(keyless.badge).toBe("Keyless");
  });

  it("states a staging engine's full-access key plainly", () => {
    const check = keylessCheck("engine-s4.rose-app.testnet", ENGINE_S4_KEYS);
    expect(check.keyless).toBe(false);
    expect(check.badge).toBe("Not keyless · 1 key");
    expect(check.summary).toMatch(/^Not keyless: a full-access key attached\. This is a staging engine/);
    expect(check.keys).toEqual([{ publicKey: "ed25519:2mj79igw48kJVRb7G5Kj2iEzg2xWhKBaSuXWAhSTJxat", permission: "FullAccess" }]);
  });

  it("never calls a non-staging engine with keys staging, and counts function-call keys", () => {
    const check = keylessCheck("engine.rose-app.testnet", [...ENGINE_S4_KEYS, { public_key: "ed25519:x", access_key: { permission: { FunctionCall: { receiver_id: "a", method_names: [] } } } }]);
    expect(check.keyless).toBe(false);
    if (!check.keyless) expect(check.staging).toBe(false);
    expect(check.summary).toContain("1 full-access and 1 function-call key attached");
    expect(isStagingEngine("engine-s12.rose-app.testnet")).toBe(true);
    expect(isStagingEngine("engine.rose-app.testnet")).toBe(false);
  });
});

let seq = 0;
function event(name: string, seconds: number, data: Record<string, unknown>): StoredEvent {
  seq += 1;
  return { seq: String(seq), block_height: String(seq), timestamp: (BigInt(seconds * 1000) * 1_000_000n).toString(), predecessor: "a.testnet", event: name, data };
}

describe("ForeignTx verifications", () => {
  const log = { BaseLog: { tx_hash: `0x${"ab".repeat(32)}`, log_index: 3 } };
  const stream = { SolStream: { metadata: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" } };

  it("pairs each request with its outcome by replay key, through a failed proof", () => {
    const history = [
      event("deposit_verification_requested", 100, { key: log }),
      event("deposit_verification_requested", 101, { key: stream }),
      event("deposit_verification_failed", 105, { key: stream }),
      event("deposit_registered", 107, { key: log, chain: "Base", position_id: "4", class_id: "c", account: "h.testnet", units: "10", checkpoint: "0" }),
      event("deposit_verification_requested", 110, { key: stream }),
      event("deposit_refused", 121, { key: stream, reason: "class fully unlocked" }),
    ];
    const report = pairLatencies(history, FOREIGN_TX);
    expect(report.samples.map((sample) => sample.latencyMs)).toEqual([7_000, 20_000]);
    expect(report.failed).toBe(1);
    expect(report.pending).toEqual([]);
  });

  it("describes every outcome kind and counts them", () => {
    const outcomes = [
      event("deposit_registered", 1, { key: log, chain: "Base", position_id: "4", class_id: "c", account: "h.testnet", units: "10", checkpoint: "0" }),
      event("base_cash_registered", 2, { key: log, account: "dao.testnet", token: "0x69fa19ad79c1c890d37cbabaa6fe99d1aa54bc01", amount: "5", round_id: "0", accepted: true }),
      event("sol_deposit_attributed", 3, { metadata: "9xQe", account: "h.testnet", class_id: "c", deposit_address: "d" }),
      event("payout_landed", 4, { payout_id: "9" }),
      event("deposit_refused", 5, { key: stream, reason: "too small" }),
      event("deposit_mismatch", 6, { key: log }),
      event("round_created", 7, { round_id: "1" }),
    ]
      .map(foreignTxOutcome)
      .filter((item): item is ForeignTxOutcome => item !== null);
    expect(outcomes.map((item) => item.label)).toEqual(["Position #4 on Base", "Base cash", "Solana stream attributed", "Payout #9 confirmed", "Deposit refused", "Mismatch"]);
    expect(outcomes[0]).toMatchObject({ account: "h.testnet", classId: "c", units: "10" });
    expect(countOutcomes(outcomes)).toEqual({ verified: 4, refused: 1, failed: 1 });
    expect(replayKeyLabel(log)).toBe("Base log 0xabab…abab:3");
  });

  it("encodes balanceOf call data", () => {
    expect(balanceOfData("0x14C7f1f870ccb5569a01399013ceeeffc465e243")).toBe(`0x70a08231${"0".repeat(24)}14c7f1f870ccb5569a01399013ceeeffc465e243`);
  });
});
