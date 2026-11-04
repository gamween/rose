import { actionFor, FAUCET_ACTIONS, type FaucetActionInfo, type FaucetSuccess } from "./actions";
import { FaucetError, type FaucetConfig, type FaucetSenders } from "./chains";
import { allowedHosts, isJsonRequest, isSameOrigin, KeyedLock } from "./guards";
import { ADDRESS_LIMIT, COOKIE_NAME, IP_LIMIT, MemoryRateLimiter, WINDOW_SECONDS, clientIp, cookieHeader, readCookie, reserveRateLimit, verifyCookie } from "./rate-limit";
import { FAUCET_CHAINS, parseFaucetRequest, requestSubject, type FaucetChain } from "./validate";

export { BASE_TX_URL, FAUCET_ACTIONS, NEAR_TX_URL, SOLANA_TX_URL, type FaucetSuccess } from "./actions";
export { DEFAULT_CAPS, FaucetError, createFaucetSenders, readFaucetConfig, type FaucetConfig, type FaucetSenders } from "./chains";
export { ADDRESS_LIMIT, IP_LIMIT, WINDOW_SECONDS } from "./rate-limit";
export { parseFaucetRequest, type FaucetChain, type FaucetRequest } from "./validate";

export type FaucetErrorCode = "invalid_request" | "unsupported_media_type" | "forbidden_origin" | "rate_limited" | "already_funded" | "not_configured" | "upstream" | "faucet_dry";

export type FaucetFailure = { error: FaucetErrorCode; message: string; retryAfterSeconds?: number };

export type FaucetInfo = {
  /** Per browser, per address and per IP on one instance, over `windowSeconds`. */
  limits: { perAddress: number; perIp: number; windowSeconds: number };
  /** `caps` are the global sends per hour and per day of each hot wallet, read from its chain. */
  chains: Record<FaucetChain, FaucetActionInfo>;
};

export type FaucetHandlerDeps = {
  senders: FaucetSenders;
  config: FaucetConfig;
  limiter?: MemoryRateLimiter;
  locks?: KeyedLock;
  now?: () => number;
  secure?: boolean;
  /** Environment naming the deployment's public hosts (`NEXT_PUBLIC_SITE_URL`, `VERCEL_*`). */
  env?: NodeJS.ProcessEnv;
};

const STATUS: Record<FaucetErrorCode, number> = {
  invalid_request: 400,
  forbidden_origin: 403,
  unsupported_media_type: 415,
  rate_limited: 429,
  already_funded: 409,
  not_configured: 503,
  upstream: 502,
  faucet_dry: 409,
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function failure(code: FaucetErrorCode, message: string, retryAfterSeconds?: number): Response {
  const body: FaucetFailure = retryAfterSeconds === undefined ? { error: code, message } : { error: code, message, retryAfterSeconds };
  return json(body, STATUS[code], retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) });
}

/** What the UI reads to show amounts, limits and "not configured" states; never a key value. */
export function faucetInfo(config: FaucetConfig): FaucetInfo {
  const chains = Object.fromEntries(FAUCET_CHAINS.map((chain) => [chain, FAUCET_ACTIONS[chain].info(config)])) as Record<FaucetChain, FaucetActionInfo>;
  return { limits: { perAddress: ADDRESS_LIMIT, perIp: IP_LIMIT, windowSeconds: WINDOW_SECONDS }, chains };
}

const SCOPE_LABEL = { address: "address", ip: "network", cookie: "browser" } as const;

/**
 * Builds the `GET` and `POST` handlers of `/api/faucet` from injected senders, so tests run the
 * whole request pipeline (request guards, validation, limits, cookie, error mapping) without any
 * network. Order of the POST checks: JSON content type, same origin, body, configuration, then
 * the per-browser, per-address and per-IP reservation, then under the chain's lock the sender's
 * on-chain checks (recipient balance, global caps from the hot wallet's history) and the send.
 */
export function createFaucetHandler({
  senders,
  config,
  limiter = new MemoryRateLimiter(),
  locks = new KeyedLock(),
  now = () => Date.now(),
  secure = process.env.NODE_ENV === "production",
  env = process.env,
}: FaucetHandlerDeps) {
  const GET = (): Response => json(faucetInfo(config), 200);

  const POST = async (request: Request): Promise<Response> => {
    if (!isJsonRequest(request.headers)) return failure("unsupported_media_type", "Send the request as application/json.");
    if (!isSameOrigin(request.headers, allowedHosts(request.headers, env))) return failure("forbidden_origin", "The faucet only answers requests from this site.");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("invalid_request", "The request body must be valid JSON.");
    }
    const parsed = parseFaucetRequest(body);
    if (!parsed.ok) return failure("invalid_request", parsed.message);
    const { chain } = parsed.request;
    const action = actionFor(parsed.request);
    if (!action.configured(config)) return failure("not_configured", `The ${action.label} faucet is not configured on this deployment.`);
    if (!config.cookieSecret) return failure("not_configured", "FAUCET_COOKIE_SECRET is not set on this deployment.");

    const nowSeconds = Math.floor(now() / 1000);
    const cookie = verifyCookie(readCookie(request.headers.get("cookie"), COOKIE_NAME), config.cookieSecret);
    const reservation = reserveRateLimit({ chain, subject: requestSubject(parsed.request), ip: clientIp(request.headers), cookie, nowSeconds, limiter });
    if (!reservation.allowed) {
      const hours = Math.ceil(reservation.retryAfterSeconds / 3600);
      return failure(
        "rate_limited",
        `This ${action.label} faucet was already used by this ${SCOPE_LABEL[reservation.scope]} in the last 24 hours. Try again in about ${String(hours)} hour${hours === 1 ? "" : "s"}.`,
        reservation.retryAfterSeconds,
      );
    }

    let result: FaucetSuccess;
    try {
      result = await locks.run(chain, () => action.send(senders, parsed.request));
    } catch (error) {
      reservation.release();
      if (error instanceof FaucetError) return failure(error.code, error.message, error.retryAfterSeconds);
      return failure("upstream", "The faucet could not complete the transfer. Try again in a minute.");
    }
    const updated = { ...cookie, [chain]: nowSeconds };
    return json(result, 200, { "set-cookie": cookieHeader(updated, config.cookieSecret, secure) });
  };

  return { GET, POST };
}
