import { describe, expect, it } from "vitest";
import { DEMO_MANIFESTS } from "@/content/demo";
import { stepEvents, type HistoryEvent } from "./events";
import { parseDemoManifest } from "./manifest";
import { clampStep, keyCommand, scenarioFromQuery, stepFromQuery, totalDuration, walkthrough } from "./walkthrough";

const manifest = parseDemoManifest(DEMO_MANIFESTS["engine-s3.rose-app.testnet"]);

function scenario(key: string) {
  const found = manifest.scenarios.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no scenario ${key}`);
  return found;
}

describe("walkthrough", () => {
  it("follows the round from custody to payout and inserts Verify right after the clearing", () => {
    const steps = walkthrough(manifest, scenario("tender"));
    expect(steps.map((step) => step.id)).toEqual(["custody", "deposit", "cash", "create", "seal", "close", "open", "clear", "verify", "settle", "payout"]);
    const verify = steps.find((step) => step.id === "verify");
    expect(verify?.txs).toEqual([]);
    expect(verify?.at).toBeNull();
  });

  it("writes every step in plain words with the cast's names and the recorded facts", () => {
    const exit = walkthrough(manifest, scenario("exit"));
    const text = (id: string) => exit.find((step) => step.id === id)?.body ?? "";
    expect(text("custody")).toContain("Cindral Foundation");
    expect(text("custody")).toContain("Streamflow");
    expect(text("deposit")).toContain("Ines Marlow and Varick Partners");
    expect(text("seal")).toContain("5 sealed orders (2 asks, 3 bids)");
    expect(text("seal")).toContain("Nadia Solvik posted a deliberately malformed ciphertext");
    expect(text("close")).toContain("4.3 s later");
    expect(text("open")).toContain("Nadia Solvik's own opening was refused on chain");
    expect(text("settle")).toContain("bond is slashed");
    expect(text("payout")).toContain("Ines Marlow withdraws");
    for (const step of exit) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body).not.toMatch(/undefined|null|NaN/);
    }
  });

  it("describes the Base payout, the lien repayment, the redeem and the cancelled round", () => {
    expect(walkthrough(manifest, scenario("tender")).find((step) => step.id === "payout")?.body).toContain("Halden Ventures withdraws the proceeds on Base");
    const advance = walkthrough(manifest, scenario("advance"));
    expect(advance.find((step) => step.id === "payout")?.body).toContain("Varick Partners claims its lien share");
    expect(advance.find((step) => step.id === "redeem")?.body).toContain("Nadia Solvik leaves custody");
    const noKey = walkthrough(manifest, scenario("no-key"));
    expect(noKey.map((step) => step.id)).toEqual(["create", "seal", "cancel", "settle"]);
    expect(noKey.find((step) => step.id === "settle")?.title).toBe("Everything is refunded");
  });

  it("gives autoplay a bounded time per step", () => {
    for (const entry of manifest.scenarios) {
      const steps = walkthrough(manifest, entry);
      for (const step of steps) {
        expect(step.durationMs).toBeGreaterThanOrEqual(7_000);
        expect(step.durationMs).toBeLessThanOrEqual(15_000);
      }
      expect(totalDuration(steps)).toBeLessThan(3 * 60_000);
    }
  });
});

describe("navigation", () => {
  const steps = walkthrough(manifest, scenario("exit"));

  it("clamps step positions", () => {
    expect(clampStep(-3, 5)).toBe(0);
    expect(clampStep(9, 5)).toBe(4);
    expect(clampStep(2.7, 5)).toBe(2);
    expect(clampStep(4, 0)).toBe(0);
  });

  it("reads the round and the step from the query string", () => {
    expect(scenarioFromQuery(manifest, "exit").key).toBe("exit");
    expect(scenarioFromQuery(manifest, "3").key).toBe("advance");
    expect(scenarioFromQuery(manifest, "nope").key).toBe("tender");
    expect(scenarioFromQuery(manifest, null).key).toBe("tender");
    expect(steps[stepFromQuery(steps, "clear")]?.id).toBe("clear");
    expect(stepFromQuery(steps, "2")).toBe(1);
    expect(stepFromQuery(steps, "99")).toBe(steps.length - 1);
    expect(stepFromQuery(steps, "bogus")).toBe(0);
  });

  it("maps the keyboard", () => {
    expect(keyCommand("ArrowRight")).toBe("next");
    expect(keyCommand("j")).toBe("next");
    expect(keyCommand("ArrowLeft")).toBe("prev");
    expect(keyCommand("Home")).toBe("first");
    expect(keyCommand("End")).toBe("last");
    expect(keyCommand(" ")).toBe("toggle");
    expect(keyCommand("Enter")).toBeNull();
  });
});

describe("stepEvents", () => {
  const exit = scenario("exit");
  const steps = walkthrough(manifest, exit);
  const step = (id: string) => {
    const found = steps.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no step ${id}`);
    return found;
  };
  let seq = 0n;
  const ev = (event: string, data: Record<string, unknown>): HistoryEvent => {
    seq += 1n;
    return { seq, event: { event, data } };
  };
  const strategic = manifest.classes.find((cls) => cls.key === "strategic-sol")?.classId ?? "";
  const history = [
    ev("deposit_registered", { position_id: "4", class_id: strategic }),
    ev("deposit_registered", { position_id: "7", class_id: "x" }),
    ev("cash_deposited", { account: "halden-ventures.rose-app.testnet", venue: "Near", amount: "1" }),
    ev("cash_deposited", { account: "halden-ventures.rose-app.testnet", venue: { Base: { token: "0x1" } }, amount: "1" }),
    ev("round_created", { round_id: "2" }),
    ev("round_created", { round_id: "1" }),
    ev("bid_placed", { round_id: "2", bid_id: 0 }),
    ev("key_requested", { round_id: "2" }),
    ev("key_received", { round_id: "2" }),
    ev("bid_settled", { round_id: "2", bid_id: 4 }),
    ev("payout_requested", { payout_id: "12", requester: "halden-ventures.rose-app.testnet" }),
    ev("cash_withdrawn", { account: "ines-marlow.rose-app.testnet", venue: "Near", amount: "1" }),
  ];

  it("keeps the round's own events per step", () => {
    expect(stepEvents(manifest, exit, step("create"), history, true).map((entry) => entry.seq)).toEqual([5n]);
    expect(stepEvents(manifest, exit, step("close"), history, true).map((entry) => entry.event.event)).toEqual(["key_requested", "key_received"]);
  });

  it("matches deposits by position, cash by venue and payouts by the accounts the transactions name", () => {
    expect(stepEvents(manifest, exit, step("deposit"), history, true).map((entry) => entry.seq)).toEqual([1n]);
    expect(stepEvents(manifest, exit, step("cash"), history, true).map((entry) => entry.seq)).toEqual([3n]);
    expect(stepEvents(manifest, exit, step("payout"), history, true).map((entry) => entry.event.event)).toEqual(["cash_withdrawn"]);
  });
});
