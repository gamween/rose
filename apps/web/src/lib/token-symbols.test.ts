import { afterEach, describe, expect, it, vi } from "vitest";
import { cashDecimalsOf, formatVenueCash } from "./amounts";
import { baseTokenDecimals, venueDecimals } from "./token-symbols";

function answer(result: string | null) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(result === null ? { jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } } : { jsonrpc: "2.0", id: 1, result }), { status: 200 }));
}

const word = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

describe("Base cash decimals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads decimals() of the venue token instead of assuming 6", async () => {
    const fetch = answer(word(18));
    vi.stubGlobal("fetch", fetch);
    await expect(baseTokenDecimals("0x00000000000000000000000000000000000000a1")).resolves.toBe(18);
    await expect(venueDecimals({ Base: { token: "0x00000000000000000000000000000000000000A1" } })).resolves.toBe(18);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as { params: [{ data: string }] };
    expect(body.params[0].data).toBe("0x313ce567");
  });

  it("answers null (never a guess) when the read fails or the value is absurd, and retries a failed read", async () => {
    vi.stubGlobal("fetch", answer(null));
    await expect(baseTokenDecimals("0x00000000000000000000000000000000000000a2")).resolves.toBeNull();
    vi.stubGlobal("fetch", answer(word(6)));
    await expect(baseTokenDecimals("0x00000000000000000000000000000000000000a2")).resolves.toBe(6);
    vi.stubGlobal("fetch", answer(word(255)));
    await expect(baseTokenDecimals("0x00000000000000000000000000000000000000a3")).resolves.toBeNull();
  });

  it("keeps 6 for the NEAR tUSDC venue without a read", async () => {
    const fetch = answer(word(18));
    vi.stubGlobal("fetch", fetch);
    await expect(venueDecimals("Near")).resolves.toBe(6);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("formats venue cash at the token's decimals, or as labeled base units while unknown", () => {
    const known = new Map([["0x00000000000000000000000000000000000000a1", 18]]);
    expect(cashDecimalsOf("Near", known)).toBe(6);
    expect(cashDecimalsOf({ Base: { token: "0x00000000000000000000000000000000000000A1" } }, known)).toBe(18);
    expect(cashDecimalsOf({ Base: { token: "0x00000000000000000000000000000000000000b2" } }, known)).toBeNull();
    expect(formatVenueCash(1_500_000_000_000_000_000n, 18)).toBe("1.50");
    expect(formatVenueCash(1_500_000n, 6)).toBe("1.50");
    expect(formatVenueCash(1_500_000n, null)).toBe("1500000 base units");
  });
});
