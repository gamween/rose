import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadIbeSync, unwrapRoundKey, verifyRoundKey } from "@rose/ibe-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { parseKeyInput, resolveRoundKey } from "./submit-key";

/** Live round-1 CKD response of the spike engine (packages/ibe-wasm/test, recorded on testnet 2026-11-04). */
const MPK = "bls12381g2:xeYho48G2Sr9oJz4gw9sLGZGspeeKpHZvMDAwWvoNTRnVMFJH96GxX98TT2MRhTtsot1wcGR1Ti2Xh8PCsbYJ2enbLNdJXDvTYSK8aTE3nJ5NZXU7Kt1F6mFtReWs5pR4kj";
const ENGINE = "rose-ckd-1793753433.testnet";
const BIG_Y = "bls12381g1:6JsKyncUXqmVX4RcTD83LCcSL25iVYoi1ShPZxFE2hBoo27Lh2nXDNHu3JnA3Paara";
const BIG_C = "bls12381g1:5jQ5mhW68mDqLQGxgnDiFShQy87sFxrDrQ1QLoYibyyZWDUsaJ19nVCaYr38FnqBbF";
const KEY = "bls12381g1:6znYwWzn6SVgzXFKy7zEmZA6CR2aS317nJXuWKAmmeEdnrc3Qp6dX7EfE26GZBA889";

const tools = { unwrap: unwrapRoundKey, verify: verifyRoundKey };

beforeAll(() => {
  loadIbeSync(readFileSync(resolve(import.meta.dirname, "../../../../../packages/ibe-wasm/pkg/rose_ibe_bg.wasm")));
});

describe("submit_key input", () => {
  it("reads a key, the two points, or the respond_ckd JSON arguments", () => {
    expect(parseKeyInput(` ${KEY} `)).toEqual({ kind: "key", key: KEY });
    expect(parseKeyInput(`${BIG_Y}\n${BIG_C}`)).toEqual({ kind: "response", bigY: BIG_Y, bigC: BIG_C });
    expect(parseKeyInput(JSON.stringify({ request: { app_id: "x" }, response: { big_y: BIG_Y, big_c: BIG_C } }))).toEqual({ kind: "response", bigY: BIG_Y, bigC: BIG_C });
    expect(parseKeyInput("")).toBeNull();
    expect(parseKeyInput("not a key")).toBeNull();
    expect(parseKeyInput("{ broken json")).toBeNull();
    expect(parseKeyInput("bls12381g1:0OIl")).toBeNull();
  });

  it("unwraps the live CKD response into the round key and verifies it", async () => {
    const round = { mpk: MPK, engineAccount: ENGINE, roundId: 1n };
    await expect(resolveRoundKey({ kind: "response", bigY: BIG_Y, bigC: BIG_C }, round, tools)).resolves.toEqual({ ok: true, key: KEY });
    await expect(resolveRoundKey({ kind: "key", key: KEY }, round, tools)).resolves.toEqual({ ok: true, key: KEY });
  });

  it("refuses a key for another round before anything is signed", async () => {
    const result = await resolveRoundKey({ kind: "key", key: KEY }, { mpk: MPK, engineAccount: ENGINE, roundId: 2n }, tools);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.message).toContain("does not open round #2");
  });
});
