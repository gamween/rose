import { createHmac, timingSafeEqual } from "node:crypto";
import { FAUCET_CHAINS, type FaucetChain } from "./validate";

/** One request per funded address (or account id) per chain per window. */
export const ADDRESS_LIMIT = 1;
/** Five requests per client IP per chain per window. */
export const IP_LIMIT = 5;
/** Rolling window of the limits, 24 hours. */
export const WINDOW_SECONDS = 24 * 60 * 60;

export const COOKIE_NAME = "rose_faucet";

export type RateLimitDecision = { allowed: true; release: () => void } | { allowed: false; retryAfterSeconds: number; scope: "address" | "ip" | "cookie" };

/**
 * In-memory counters with a rolling window, one map per serverless instance: a cold start forgets
 * them, and two instances do not share them. They stop bursts against one warm instance; the
 * signed cookie and the on-chain caps of `ledger.ts` hold across instances.
 */
export class MemoryRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowSeconds: number = WINDOW_SECONDS) {}

  private recent(key: string, nowSeconds: number): number[] {
    const floor = nowSeconds - this.windowSeconds;
    const kept = (this.hits.get(key) ?? []).filter((at) => at > floor);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  check(key: string, limit: number, nowSeconds: number): { allowed: boolean; retryAfterSeconds: number } {
    const recent = this.recent(key, nowSeconds);
    if (recent.length < limit) return { allowed: true, retryAfterSeconds: 0 };
    const oldest = Math.min(...recent);
    return { allowed: false, retryAfterSeconds: Math.max(1, oldest + this.windowSeconds - nowSeconds) };
  }

  record(key: string, nowSeconds: number): void {
    const recent = this.recent(key, nowSeconds);
    recent.push(nowSeconds);
    this.hits.set(key, recent);
  }

  /** Removes one hit recorded at `at` for `key` (a reservation whose send failed). */
  release(key: string, at: number): void {
    const hits = this.hits.get(key);
    if (!hits) return;
    const index = hits.indexOf(at);
    if (index >= 0) hits.splice(index, 1);
    if (hits.length === 0) this.hits.delete(key);
  }

  /**
   * Checks every `(key, limit)` pair and records a hit on all of them in the same synchronous
   * step, so concurrent requests on one instance cannot all pass the check before any records.
   * Returns the index of the first limit that refused, or a `release` that undoes the reservation.
   */
  reserve(limits: readonly { key: string; limit: number }[], nowSeconds: number): { allowed: true; release: () => void } | { allowed: false; index: number; retryAfterSeconds: number } {
    for (const [index, { key, limit }] of limits.entries()) {
      const decision = this.check(key, limit, nowSeconds);
      if (!decision.allowed) return { allowed: false, index, retryAfterSeconds: decision.retryAfterSeconds };
    }
    for (const { key } of limits) this.record(key, nowSeconds);
    return { allowed: true, release: () => limits.forEach(({ key }) => this.release(key, nowSeconds)) };
  }

  /** Evicts every key with no hit inside the window; called opportunistically on each request. */
  prune(nowSeconds: number): void {
    for (const key of [...this.hits.keys()]) this.recent(key, nowSeconds);
  }
}

export type CookiePayload = Partial<Record<FaucetChain, number>>;

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** `base64url(json).base64url(hmac-sha256)`; the payload maps each chain to its last request time. */
export function signCookie(payload: CookiePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(secret, body).toString("base64url")}`;
}

export function verifyCookie(value: string | null | undefined, secret: string): CookiePayload {
  if (!value) return {};
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return {};
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), "base64url");
  const expected = hmac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const payload: CookiePayload = {};
    for (const [chain, at] of Object.entries(parsed)) {
      const known = FAUCET_CHAINS.find((candidate) => candidate === chain);
      if (known !== undefined && typeof at === "number" && Number.isFinite(at)) payload[known] = at;
    }
    return payload;
  } catch {
    return {};
  }
}

/** Reads one cookie from a `Cookie` request header; a malformed value reads as absent. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

/** The `Set-Cookie` value carrying the updated payload for 24 h. */
export function cookieHeader(payload: CookiePayload, secret: string, secure: boolean): string {
  const attributes = [`${COOKIE_NAME}=${encodeURIComponent(signCookie(payload, secret))}`, "Path=/api/faucet", `Max-Age=${WINDOW_SECONDS}`, "HttpOnly", "SameSite=Lax"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

/** Client IP from the proxy headers Vercel sets (first `x-forwarded-for` entry, then `x-real-ip`). */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip")?.trim() || "unknown";
}

export type RateLimitInput = {
  chain: FaucetChain;
  subject: string;
  ip: string;
  cookie: CookiePayload;
  nowSeconds: number;
  limiter: MemoryRateLimiter;
};

/**
 * The signed cookie first, then the per-address and per-IP counters, reserved atomically: the
 * caller sends only after a reservation and calls `release` when the send fails.
 */
export function reserveRateLimit({ chain, subject, ip, cookie, nowSeconds, limiter }: RateLimitInput): RateLimitDecision {
  const last = cookie[chain];
  if (last !== undefined && nowSeconds - last < WINDOW_SECONDS) {
    return { allowed: false, retryAfterSeconds: Math.max(1, last + WINDOW_SECONDS - nowSeconds), scope: "cookie" };
  }
  limiter.prune(nowSeconds);
  const scopes = ["address", "ip"] as const;
  const reservation = limiter.reserve(
    [
      { key: `${chain}:address:${subject}`, limit: ADDRESS_LIMIT },
      { key: `${chain}:ip:${ip}`, limit: IP_LIMIT },
    ],
    nowSeconds,
  );
  if (!reservation.allowed) return { allowed: false, retryAfterSeconds: reservation.retryAfterSeconds, scope: scopes[reservation.index] ?? "address" };
  return { allowed: true, release: reservation.release };
}
