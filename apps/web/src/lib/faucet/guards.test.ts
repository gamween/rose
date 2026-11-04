import { describe, expect, it } from "vitest";
import { allowedHosts, capRefusal, DAY_SECONDS, HOUR_SECONDS, isJsonRequest, isSameOrigin, KeyedLock } from "./guards";

const NOW = 1_800_000_000;

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe("same-origin check", () => {
  const hosts = allowedHosts(new Headers({ host: "rose-rounds.vercel.app" }), env({ NEXT_PUBLIC_SITE_URL: "https://rose.example/", VERCEL_URL: "rose-abc123.vercel.app" }));

  it("collects the request host and the deployment's public hosts", () => {
    expect([...hosts].sort()).toEqual(["rose-abc123.vercel.app", "rose-rounds.vercel.app", "rose.example"]);
  });

  it("accepts the site's own Origin, or its Referer when Origin is absent", () => {
    expect(isSameOrigin(new Headers({ origin: "https://rose-rounds.vercel.app" }), hosts)).toBe(true);
    expect(isSameOrigin(new Headers({ referer: "https://rose.example/app" }), hosts)).toBe(true);
  });

  it("refuses another site, an opaque origin and a request with neither header", () => {
    expect(isSameOrigin(new Headers({ origin: "https://evil.example" }), hosts)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "https://rose-rounds.vercel.app.evil.example" }), hosts)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "null", referer: "https://rose.example/" }), hosts)).toBe(false);
    expect(isSameOrigin(new Headers(), hosts)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "not a url" }), hosts)).toBe(false);
  });
});

describe("isJsonRequest", () => {
  it("accepts application/json with parameters and refuses the simple-request types", () => {
    expect(isJsonRequest(new Headers({ "content-type": "application/json" }))).toBe(true);
    expect(isJsonRequest(new Headers({ "content-type": "Application/JSON; charset=utf-8" }))).toBe(true);
    expect(isJsonRequest(new Headers({ "content-type": "text/plain" }))).toBe(false);
    expect(isJsonRequest(new Headers({ "content-type": "application/x-www-form-urlencoded" }))).toBe(false);
    expect(isJsonRequest(new Headers())).toBe(false);
  });
});

describe("capRefusal", () => {
  const caps = { hourly: 3, daily: 5 };

  it("allows a send while both windows have room", () => {
    expect(capRefusal({ lastHour: 2, lastDay: 4 }, caps, NOW)).toBeNull();
  });

  it("refuses a full hour, then a full day, with the window length when send times are unknown", () => {
    expect(capRefusal({ lastHour: 3, lastDay: 3 }, caps, NOW)).toEqual({ window: "hour", cap: 3, retryAfterSeconds: HOUR_SECONDS });
    expect(capRefusal({ lastHour: 3, lastDay: 5 }, caps, NOW)).toEqual({ window: "day", cap: 5, retryAfterSeconds: DAY_SECONDS });
  });

  it("computes when one more send fits from the send times", () => {
    const times = [NOW - 3000, NOW - 2000, NOW - 1000];
    expect(capRefusal({ lastHour: 3, lastDay: 3, times }, caps, NOW)).toEqual({ window: "hour", cap: 3, retryAfterSeconds: 600 });
    /* Four sends in the hour against a cap of three: the two oldest must leave first. */
    const over = [NOW - 3500, NOW - 3000, NOW - 2000, NOW - 1000];
    expect(capRefusal({ lastHour: 4, lastDay: 4, times: over }, { hourly: 3, daily: 10 }, NOW)).toMatchObject({ retryAfterSeconds: 600 });
  });
});

describe("KeyedLock", () => {
  it("runs tasks of one key one at a time and other keys in parallel", async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lock.run("base", async () => {
      log.push("base-1 start");
      await gate;
      log.push("base-1 end");
    });
    const second = lock.run("base", async () => {
      log.push("base-2 start");
    });
    const other = lock.run("solana", async () => {
      log.push("solana start");
    });
    await other;
    expect(log).toEqual(["base-1 start", "solana start"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["base-1 start", "solana start", "base-1 end", "base-2 start"]);
  });

  it("keeps the queue moving after a failed task", async () => {
    const lock = new KeyedLock();
    await expect(lock.run("near", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(lock.run("near", () => Promise.resolve(7))).resolves.toBe(7);
  });
});
