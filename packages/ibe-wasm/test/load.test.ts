/**
 * `loadIbe` state handling: concurrent calls share one load, a failed load can be retried, and the
 * IBE functions refuse to run before the module is ready. The wasm-bindgen `init` is wrapped so a
 * test can make one load fail or hold it pending; each test gets fresh module state.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Glue from "../pkg/rose_ibe.js";
import type * as Ibe from "../src/index.js";

const WASM = readFileSync(resolve(import.meta.dirname, "../pkg/rose_ibe_bg.wasm"));
const ENGINE = "rose-ckd-1793753433.testnet";
const ROUND1_APP_ID = "305bd2a108c0772db82c2d803d5eea87ba669442b9abcf6bd45b28b8926aa8f5";

vi.mock("../pkg/rose_ibe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Glue>();
  return { ...actual, default: vi.fn(actual.default) };
});

async function fresh(): Promise<{ ibe: typeof Ibe; init: ReturnType<typeof vi.fn> }> {
  vi.resetModules();
  const glue = await import("../pkg/rose_ibe.js");
  const ibe = await import("../src/index.js");
  return { ibe, init: vi.mocked(glue.default) as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadIbe", () => {
  it("refuses IBE calls before any load", async () => {
    const { ibe } = await fresh();
    expect(ibe.ibeLoadState()).toBe("idle");
    expect(() => ibe.roundAppIdHex(ENGINE, 1n)).toThrow("Call loadIbe() before using the IBE functions.");
  });

  it("shares one load between concurrent callers and refuses calls while it is pending", async () => {
    const { ibe, init } = await fresh();
    const first = ibe.loadIbe(WASM);
    const second = ibe.loadIbe(WASM);
    expect(ibe.ibeLoadState()).toBe("loading");
    expect(() => ibe.roundAppIdHex(ENGINE, 1n)).toThrow("The IBE module is still loading");
    await Promise.all([first, second]);
    expect(init).toHaveBeenCalledTimes(1);
    expect(ibe.ibeLoadState()).toBe("ready");
    expect(ibe.roundAppIdHex(ENGINE, 1n)).toBe(ROUND1_APP_ID);
    await ibe.loadIbe(WASM);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed load so the next call retries", async () => {
    const { ibe, init } = await fresh();
    init.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(ibe.loadIbe(WASM)).rejects.toThrow("Failed to fetch");
    expect(ibe.ibeLoadState()).toBe("idle");
    expect(() => ibe.roundAppIdHex(ENGINE, 1n)).toThrow("Call loadIbe() before using the IBE functions.");
    await ibe.loadIbe(WASM);
    expect(init).toHaveBeenCalledTimes(2);
    expect(ibe.ibeLoadState()).toBe("ready");
    expect(ibe.roundAppIdHex(ENGINE, 1n)).toBe(ROUND1_APP_ID);
  });

  it("is ready after a synchronous load", async () => {
    const { ibe, init } = await fresh();
    ibe.loadIbeSync(WASM);
    expect(ibe.ibeLoadState()).toBe("ready");
    await ibe.loadIbe(WASM);
    expect(init).not.toHaveBeenCalled();
    expect(ibe.roundAppIdHex(ENGINE, 1n)).toBe(ROUND1_APP_ID);
  });
});
