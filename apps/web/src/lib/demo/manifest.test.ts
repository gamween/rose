import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_MANIFESTS } from "@/content/demo";
import { buildDemoManifest, ManifestError, parseDemoManifest, type Journal, type ManifestSources, type SolanaJournal } from "./manifest";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const ENGINE = "engine-s3.rose-app.testnet";

function journal(path: string): Journal {
  return JSON.parse(readFileSync(`${ROOT}${path}`, "utf8")) as Journal;
}

function sources(): ManifestSources {
  const paths = ["deployments/e2e/cindral.json", `deployments/e2e/${ENGINE}.seed.json`, `deployments/e2e/${ENGINE}.live.json`, `deployments/e2e/${ENGINE}.solana.json`];
  const solana = JSON.parse(readFileSync(`${ROOT}${paths[3] ?? ""}`, "utf8")) as SolanaJournal;
  return { cast: journal(paths[0] ?? ""), seed: journal(paths[1] ?? ""), live: journal(paths[2] ?? ""), solana, paths };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("buildDemoManifest on the recorded engine-s3 journals", () => {
  const manifest = buildDemoManifest(sources());

  it("is exactly the committed data file, so regenerating it is a no-op", () => {
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(DEMO_MANIFESTS[ENGINE]);
  });

  it("names the engine, the issuer, the token and the cast", () => {
    expect(manifest.engine).toBe(ENGINE);
    expect(manifest.issuer).toBe("Cindral Foundation");
    expect(manifest.token).toEqual({ name: "Cindral", symbol: "CINDR" });
    expect(manifest.people).toHaveLength(7);
    expect(manifest.classes.map((cls) => cls.key).sort()).toEqual(["kol-base", "seed-base", "strategic-sol"]);
  });

  it("keeps the four settled rounds in order with their steps", () => {
    expect(manifest.scenarios.map((scenario) => [scenario.key, scenario.roundId, scenario.kind])).toEqual([
      ["tender", "1", "Tender"],
      ["exit", "2", "Exit"],
      ["advance", "3", "Advance"],
      ["no-key", "4", "Exit"],
    ]);
    const ids = (key: string) => manifest.scenarios.find((scenario) => scenario.key === key)?.steps.map((step) => step.id);
    expect(ids("tender")).toEqual(["custody", "deposit", "cash", "create", "seal", "close", "open", "clear", "settle", "payout"]);
    expect(ids("advance")).toEqual(["custody", "deposit", "cash", "create", "seal", "close", "open", "clear", "settle", "payout", "redeem"]);
    expect(ids("no-key")).toEqual(["create", "seal", "cancel", "settle"]);
  });

  it("attributes custody, deposits and cash to the round's class and participants only", () => {
    const tender = manifest.scenarios.find((scenario) => scenario.key === "tender");
    const deposit = tender?.steps.find((step) => step.id === "deposit");
    expect(deposit?.txs.map((tx) => tx.label)).toEqual(["register_base_deposit: stream 90 for Halden Ventures", "register_base_deposit: stream 91 for Tessaro Capital"]);
    const cash = tender?.steps.find((step) => step.id === "cash");
    expect(cash?.txs.every((tx) => tx.chain === "base" || tx.label.startsWith("register_base_cash"))).toBe(true);
    expect(cash?.txs.some((tx) => tx.label.includes("tUSDC mint 2050"))).toBe(false);

    const exit = manifest.scenarios.find((scenario) => scenario.key === "exit");
    expect(exit?.steps.find((step) => step.id === "custody")?.txs.every((tx) => tx.chain === "solana")).toBe(true);
    expect(exit?.steps.find((step) => step.id === "deposit")?.txs.map((tx) => tx.chain)).toEqual(["solana", "near", "near", "solana", "near", "solana", "near", "near", "solana", "near"]);
    expect(exit?.positions.map((position) => position.positionId)).toEqual(["4", "5"]);
    expect(exit?.steps.find((step) => step.id === "cash")?.txs.every((tx) => tx.chain === "near")).toBe(true);
  });

  it("records the malformed bid, the refused opening and the off-chain checks", () => {
    const exit = manifest.scenarios.find((scenario) => scenario.key === "exit");
    expect(exit?.orders.filter((order) => order.malformed).map((order) => order.account)).toEqual(["nadia-solvik.rose-app.testnet"]);
    expect(exit?.openings.find((opening) => opening.bidId === 4)?.unopenable).toMatch(/Opening does not match the ciphertext/);
    expect(exit?.steps.find((step) => step.id === "open")?.txs.filter((tx) => tx.failed)).toHaveLength(1);
    expect(exit?.keyCheckedOffline).toBe(true);
    expect(exit?.clearingMatchesReference).toBe(true);
    expect(exit?.keyLatencyMs).toBe(4250);
  });

  it("puts the in-kind redeem in the scenario whose class holds the position", () => {
    const owners = manifest.scenarios.filter((scenario) => scenario.steps.some((step) => step.id === "redeem")).map((scenario) => scenario.key);
    expect(owners).toEqual(["advance"]);
  });

  it("shows the two-phase Solana token payout and redeem in the payout step of the Exit on Solana", () => {
    const payout = manifest.scenarios.find((scenario) => scenario.key === "exit")?.steps.find((step) => step.id === "payout");
    const labels = payout?.txs.map((tx) => `${tx.chain} ${tx.label.split(":")[0] ?? ""}`) ?? [];
    expect(labels.slice(-6)).toEqual(["near claim_sol_tokens", "solana Solana", "near confirm_sol_payout", "near redeem", "solana Solana", "near confirm_sol_redeem"]);
    expect(payout?.txs.at(-1)?.note).toContain("scripts/e2e-solana-stream.mjs");
    for (const key of ["tender", "advance"]) {
      const steps = manifest.scenarios.find((scenario) => scenario.key === key)?.steps ?? [];
      expect(steps.flatMap((step) => step.txs).some((tx) => tx.label.startsWith("claim_sol_tokens"))).toBe(false);
    }
  });

  it("refuses a Solana journal of another engine", () => {
    const input = sources();
    const solana = clone(input.solana!);
    solana.engine = "other.testnet";
    expect(() => buildDemoManifest({ ...input, solana })).toThrow(/Solana journal is for other.testnet/);
    const exit = buildDemoManifest({ cast: input.cast, seed: input.seed, live: input.live, paths: input.paths }).scenarios.find((scenario) => scenario.key === "exit");
    expect(exit?.steps.find((step) => step.id === "payout")?.txs.some((tx) => tx.chain === "solana")).toBe(false);
  });
});

describe("buildDemoManifest edge cases", () => {
  it("leaves out a round that did not reach settlement", () => {
    const input = sources();
    const live = clone(input.live);
    delete live.steps["settle:advance"];
    const manifest = buildDemoManifest({ ...input, live });
    expect(manifest.scenarios.map((scenario) => scenario.key)).toEqual(["tender", "exit", "no-key"]);
  });

  it("omits a step the journals never recorded instead of showing it empty", () => {
    const input = sources();
    const live = clone(input.live);
    delete live.steps["payout:near-cash"];
    const exit = buildDemoManifest({ ...input, live }).scenarios.find((scenario) => scenario.key === "exit");
    expect(exit?.steps.some((step) => step.id === "payout")).toBe(false);
  });

  it("refuses journals of two different engines and an engine with nothing settled", () => {
    const input = sources();
    const live = clone(input.live);
    live.header.engine = "other.testnet";
    expect(() => buildDemoManifest({ ...input, live })).toThrow(ManifestError);
    const empty: Journal = { header: { engine: ENGINE }, steps: {} };
    expect(() => buildDemoManifest({ ...input, live: empty })).toThrow(/no seeded round/);
  });
});

describe("parseDemoManifest", () => {
  const valid = DEMO_MANIFESTS[ENGINE];

  it("accepts the committed manifest", () => {
    expect(parseDemoManifest(valid).scenarios).toHaveLength(4);
  });

  it("rejects a malformed transaction hash, an unknown class and a wrong version", () => {
    const badHash = clone(valid) as { scenarios: { steps: { txs: { hash: string }[] }[] }[] };
    const firstTx = badHash.scenarios[0]?.steps[0]?.txs[0];
    if (firstTx) firstTx.hash = "0x1234";
    expect(() => parseDemoManifest(badHash)).toThrow(/transaction hash/);

    const badClass = clone(valid) as { scenarios: { classKey: string }[] };
    if (badClass.scenarios[0]) badClass.scenarios[0].classKey = "nope";
    expect(() => parseDemoManifest(badClass)).toThrow(/names no class/);

    expect(() => parseDemoManifest({ ...(valid as object), version: 2 })).toThrow(/version/);
  });
});
