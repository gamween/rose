/**
 * Request guards of `/api/faucet` that need no chain: same-origin JSON only, the global send caps
 * decided from on-chain usage, and one send at a time per chain on an instance.
 */

/**
 * Hosts a browser may post from: the host the request was addressed to, plus the deployment's
 * public names. A cross-site page cannot forge `Origin` or `Host`, so this stops other websites
 * from spending the faucet through their visitors' browsers; a script outside a browser can still
 * send any header, which the per-address checks and the global caps bound.
 */
export function allowedHosts(headers: Headers, env: NodeJS.ProcessEnv): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    try {
      hosts.add(new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host);
    } catch {
      return;
    }
  };
  add(headers.get("x-forwarded-host")?.split(",")[0]);
  add(headers.get("host"));
  add(env.NEXT_PUBLIC_SITE_URL);
  add(env.VERCEL_PROJECT_PRODUCTION_URL);
  add(env.VERCEL_BRANCH_URL);
  add(env.VERCEL_URL);
  return hosts;
}

/** True when `Origin` (or, without it, `Referer`) names one of `hosts`. A request with neither is refused. */
export function isSameOrigin(headers: Headers, hosts: Set<string>): boolean {
  const source = headers.get("origin") || headers.get("referer");
  if (!source || source === "null") return false;
  try {
    return hosts.has(new URL(source).host);
  } catch {
    return false;
  }
}

/** `application/json`, with or without parameters such as `charset`. */
export function isJsonRequest(headers: Headers): boolean {
  const type = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json";
}

export const HOUR_SECONDS = 60 * 60;
export const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Maximum sends of one hot wallet per rolling hour and per rolling day, across every instance. */
export type SendCaps = { hourly: number; daily: number };

/**
 * Sends the hot wallet made in the last hour and day, read from its own chain history. `times`
 * lists the send times of the last day, oldest first, when the history carries them.
 */
export type SendUsage = { lastHour: number; lastDay: number; times?: number[] };

export type CapRefusal = { window: "hour" | "day"; cap: number; retryAfterSeconds: number };

function retryAfter(usage: SendUsage, cap: number, windowSeconds: number, nowSeconds: number): number {
  const inWindow = (usage.times ?? []).filter((time) => time > nowSeconds - windowSeconds);
  /* One more send fits once the oldest `count - cap + 1` sends have left the window. */
  const leaving = inWindow[inWindow.length - cap];
  return leaving === undefined ? windowSeconds : Math.max(1, leaving + windowSeconds - nowSeconds);
}

/** Null when one more send fits both caps; otherwise the window that is full (the day first). */
export function capRefusal(usage: SendUsage, caps: SendCaps, nowSeconds: number): CapRefusal | null {
  if (usage.lastDay >= caps.daily) return { window: "day", cap: caps.daily, retryAfterSeconds: retryAfter(usage, caps.daily, DAY_SECONDS, nowSeconds) };
  if (usage.lastHour >= caps.hourly) return { window: "hour", cap: caps.hourly, retryAfterSeconds: retryAfter(usage, caps.hourly, HOUR_SECONDS, nowSeconds) };
  return null;
}

/**
 * Runs tasks with the same key one after the other. Holding the chain's lock across "read usage,
 * check the caps, send" makes the cap check exact on one instance and gives the hot wallet one
 * transaction in flight at a time there.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
