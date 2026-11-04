import { FaucetError, NEAR_HELPER_FUNDING, type FaucetConfig, type FaucetSenders } from "./chains";
import {
  ADDRESS_LIMIT,
  COOKIE_NAME,
  IP_LIMIT,
  MemoryRateLimiter,
  WINDOW_SECONDS,
  clientIp,
  cookieHeader,
  decideRateLimit,
  readCookie,
  recordRequest,
  verifyCookie,
} from "./rate-limit";
import { parseFaucetRequest, requestSubject, type FaucetChain, type FaucetRequest } from "./validate";

export { FaucetError, createFaucetSenders, readFaucetConfig, type FaucetConfig, type FaucetSenders } from "./chains";
export { ADDRESS_LIMIT, IP_LIMIT, WINDOW_SECONDS } from "./rate-limit";
export { parseFaucetRequest, type FaucetChain, type FaucetRequest } from "./validate";

export const NEAR_TX_URL = "https://testnet.near.rocks/tx/";
export const BASE_TX_URL = "https://sepolia.basescan.org/tx/";
export const SOLANA_TX_URL = "https://explorer.solana.com/tx/";

export type FaucetErrorCode = "invalid_request" | "rate_limited" | "not_configured" | "upstream" | "faucet_dry";

export type FaucetSuccess =
  | { chain: "base"; txHash: string; amount: string; explorerUrl: string }
  | { chain: "solana"; signature: string; amount: string; explorerUrl: string }
  | { chain: "near"; accountId: string; txHash: string; explorerUrl: string };

export type FaucetFailure = { error: FaucetErrorCode; message: string; retryAfterSeconds?: number };

export type FaucetInfo = {
  limits: { perAddress: number; perIp: number; windowSeconds: number };
  chains: Record<FaucetChain, { configured: boolean; amount: string; unit: string }>;
};

export type FaucetHandlerDeps = {
  senders: FaucetSenders;
  config: FaucetConfig;
  limiter?: MemoryRateLimiter;
  now?: () => number;
  secure?: boolean;
};

const STATUS: Record<FaucetErrorCode, number> = {
  invalid_request: 400,
  rate_limited: 429,
  not_configured: 503,
  upstream: 502,
  faucet_dry: 409,
};

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function failure(code: FaucetErrorCode, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return json({ error: code, message, ...extra } satisfies FaucetFailure & Record<string, unknown>, STATUS[code], headers);
}

/** What the UI reads to show amounts and "not configured" states; never a key value. */
export function faucetInfo(config: FaucetConfig): FaucetInfo {
  return {
    limits: { perAddress: ADDRESS_LIMIT, perIp: IP_LIMIT, windowSeconds: WINDOW_SECONDS },
    chains: {
      base: { configured: config.base.configured, amount: config.base.amountWei.toString(), unit: "wei" },
      solana: { configured: config.solana.configured, amount: config.solana.lamports.toString(), unit: "lamports" },
      near: { configured: config.near.configured, amount: NEAR_HELPER_FUNDING, unit: "NEAR" },
    },
  };
}

async function send(senders: FaucetSenders, request: FaucetRequest): Promise<FaucetSuccess> {
  switch (request.chain) {
    case "base": {
      const { txHash, amount } = await senders.sendBase(request.address);
      return { chain: "base", txHash, amount, explorerUrl: `${BASE_TX_URL}${txHash}` };
    }
    case "solana": {
      const { signature, amount } = await senders.sendSolana(request.address);
      return { chain: "solana", signature, amount, explorerUrl: `${SOLANA_TX_URL}${signature}?cluster=devnet` };
    }
    case "near": {
      const { txHash } = await senders.createNearAccount(request.accountId, request.publicKey);
      return { chain: "near", accountId: request.accountId, txHash, explorerUrl: `${NEAR_TX_URL}${txHash}` };
    }
  }
}

/**
 * Builds the `GET` and `POST` handlers of `/api/faucet` from injected senders, so tests run the
 * whole request pipeline (validation, rate limits, cookie, error mapping) without any network.
 */
export function createFaucetHandler({ senders, config, limiter = new MemoryRateLimiter(), now = () => Date.now(), secure = process.env.NODE_ENV === "production" }: FaucetHandlerDeps) {
  const GET = (): Response => json(faucetInfo(config), 200);

  const POST = async (request: Request): Promise<Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("invalid_request", "The request body must be valid JSON.");
    }
    const parsed = parseFaucetRequest(body);
    if (!parsed.ok) return failure("invalid_request", parsed.message);
    const { chain } = parsed.request;
    if (!config[chain].configured) {
      return failure("not_configured", `The ${chain === "base" ? "Base Sepolia" : chain === "solana" ? "Solana devnet" : "NEAR testnet"} faucet is not configured on this deployment.`);
    }
    if (!config.cookieSecret) return failure("not_configured", "FAUCET_COOKIE_SECRET is not set on this deployment.");

    const nowSeconds = Math.floor(now() / 1000);
    const subject = requestSubject(parsed.request);
    const ip = clientIp(request.headers);
    const cookie = verifyCookie(readCookie(request.headers.get("cookie"), COOKIE_NAME), config.cookieSecret);
    const decision = decideRateLimit({ chain, subject, ip, cookie, nowSeconds, limiter });
    if (!decision.allowed) {
      const hours = Math.ceil(decision.retryAfterSeconds / 3600);
      return failure(
        "rate_limited",
        `This ${chain} faucet was already used by this ${decision.scope === "ip" ? "network" : decision.scope === "cookie" ? "browser" : "address"} in the last 24 hours. Try again in about ${hours} hour${hours === 1 ? "" : "s"}.`,
        { retryAfterSeconds: decision.retryAfterSeconds },
        { "retry-after": String(decision.retryAfterSeconds) },
      );
    }

    let result: FaucetSuccess;
    try {
      result = await send(senders, parsed.request);
    } catch (error) {
      if (error instanceof FaucetError) return failure(error.code, error.message);
      return failure("upstream", "The faucet could not complete the transfer. Try again in a minute.");
    }
    recordRequest({ chain, subject, ip, nowSeconds, limiter });
    const updated = { ...cookie, [chain]: nowSeconds };
    return json(result, 200, { "set-cookie": cookieHeader(updated, config.cookieSecret, secure) });
  };

  return { GET, POST };
}
