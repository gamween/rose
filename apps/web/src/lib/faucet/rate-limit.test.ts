import { describe, expect, it } from "vitest";
import {
  ADDRESS_LIMIT,
  IP_LIMIT,
  MemoryRateLimiter,
  WINDOW_SECONDS,
  clientIp,
  cookieHeader,
  decideRateLimit,
  readCookie,
  recordRequest,
  signCookie,
  verifyCookie,
} from "./rate-limit";

const SECRET = "test-secret";
const T0 = 1_800_000_000;

describe("MemoryRateLimiter", () => {
  it("allows up to the limit inside the window and reports the retry delay", () => {
    const limiter = new MemoryRateLimiter();
    limiter.record("k", T0);
    expect(limiter.check("k", 1, T0 + 10)).toEqual({ allowed: false, retryAfterSeconds: WINDOW_SECONDS - 10 });
    expect(limiter.check("k", 2, T0 + 10)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check("k", 1, T0 + WINDOW_SECONDS + 1)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });
  it("prunes keys that left the window", () => {
    const limiter = new MemoryRateLimiter();
    limiter.record("old", T0);
    limiter.prune(T0 + WINDOW_SECONDS + 1);
    expect(limiter.check("old", 1, T0 + WINDOW_SECONDS + 1).allowed).toBe(true);
  });
});

describe("signed cookie", () => {
  it("round-trips a payload and rejects tampering or a wrong secret", () => {
    const value = signCookie({ base: T0, near: T0 - 5 }, SECRET);
    expect(verifyCookie(value, SECRET)).toEqual({ base: T0, near: T0 - 5 });
    expect(verifyCookie(value, "other")).toEqual({});
    expect(verifyCookie(`${value.slice(0, -2)}xx`, SECRET)).toEqual({});
    expect(verifyCookie("garbage", SECRET)).toEqual({});
    expect(verifyCookie(null, SECRET)).toEqual({});
  });
  it("drops unknown chains and non-numeric values", () => {
    const body = Buffer.from(JSON.stringify({ base: "1", bitcoin: T0, solana: T0 }), "utf8").toString("base64url");
    const forged = signCookie({}, SECRET).replace(/^[^.]+/, body);
    expect(verifyCookie(forged, SECRET)).toEqual({});
    expect(verifyCookie(signCookie({ solana: T0 }, SECRET), SECRET)).toEqual({ solana: T0 });
  });
  it("reads a cookie from the request header and writes a hardened Set-Cookie", () => {
    const header = cookieHeader({ base: T0 }, SECRET, true);
    expect(header).toMatch(/^rose_faucet=[^;]+; Path=\/api\/faucet; Max-Age=86400; HttpOnly; SameSite=Lax; Secure$/);
    const value = header.split(";")[0]!.slice("rose_faucet=".length);
    expect(verifyCookie(readCookie(`a=b; rose_faucet=${value}; c=d`, "rose_faucet"), SECRET)).toEqual({ base: T0 });
    expect(cookieHeader({}, SECRET, false)).not.toContain("Secure");
    expect(readCookie(null, "rose_faucet")).toBeNull();
  });
});

describe("decideRateLimit", () => {
  it("limits one request per address, five per ip, and by cookie", () => {
    const limiter = new MemoryRateLimiter();
    const base = { chain: "base" as const, ip: "1.1.1.1", cookie: {}, nowSeconds: T0, limiter };
    expect(decideRateLimit({ ...base, subject: "0xa" })).toEqual({ allowed: true });
    recordRequest({ ...base, subject: "0xa" });
    expect(decideRateLimit({ ...base, subject: "0xa", nowSeconds: T0 + 60 })).toMatchObject({ allowed: false, scope: "address", retryAfterSeconds: WINDOW_SECONDS - 60 });
    for (let i = 1; i < IP_LIMIT; i += 1) recordRequest({ ...base, subject: `0x${i}` });
    expect(decideRateLimit({ ...base, subject: "0xnew" })).toMatchObject({ allowed: false, scope: "ip" });
    expect(decideRateLimit({ ...base, subject: "0xnew", ip: "2.2.2.2" })).toEqual({ allowed: true });
    expect(decideRateLimit({ ...base, subject: "0xnew", ip: "2.2.2.2", cookie: { base: T0 - 100 } })).toMatchObject({ allowed: false, scope: "cookie", retryAfterSeconds: WINDOW_SECONDS - 100 });
    expect(decideRateLimit({ ...base, subject: "0xnew", ip: "2.2.2.2", cookie: { solana: T0 - 100 } })).toEqual({ allowed: true });
    expect(ADDRESS_LIMIT).toBe(1);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1", "x-real-ip": "8.8.8.8" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
