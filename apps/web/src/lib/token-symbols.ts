/**
 * Display symbols of the tokens the app shows (stream tokens of classes, cash venues). Base
 * tokens are read on chain with ERC-20 `symbol()`. The Solana demo mint is a plain SPL mint
 * without Metaplex metadata (no symbol on chain); the deployment declares it as the Solana twin of
 * the Base demo token (`NEXT_PUBLIC_SOLANA_DEMO_MINT`), so it shows that token's on-chain symbol.
 * Every label keeps the full address at hand for a tooltip.
 */

import type { Venue } from "@rose/sdk";
import { useEffect, useState } from "react";
import { decodeString, decodeUint, ethCall, SELECTORS } from "@/components/status/rpc";
import { CIRCLE_USDC_BASE_SEPOLIA, deployed } from "./deployment";
import { USDC_DECIMALS } from "./engine";

export type TokenChain = "Base" | "Solana";

/** Map key of a token: EVM addresses are case-insensitive; two base58 mints differing only in case are practically impossible. */
export function tokenKey(token: string): string {
  return token.toLowerCase();
}

/** Display label of a class: its token symbol, or the short token address when the token has none. */
export function classLabel(info: { chain: TokenChain; token: string }, symbols: ReadonlyMap<string, string>): string {
  const symbol = symbols.get(tokenKey(info.token));
  if (symbol) return symbol;
  return info.chain === "Base" ? `${info.token.slice(0, 6)}…${info.token.slice(-4)}` : `${info.token.slice(0, 4)}…${info.token.slice(-4)}`;
}

/** Symbols the deployment names without a chain read: rose tUSDC and Circle USDC on Base Sepolia. */
export function deployedCashSymbol(token: string): string | null {
  const key = tokenKey(token);
  const tusdc = deployed("baseTestUsdc");
  if (tusdc && tokenKey(tusdc) === key) return "tUSDC";
  if (tokenKey(CIRCLE_USDC_BASE_SEPOLIA) === key) return "USDC";
  return null;
}

const baseCache = new Map<string, Promise<string | null>>();

/** ERC-20 `symbol()` of a Base token through a raw `eth_call`, cached per page load; null when the call fails. */
export function baseTokenSymbol(token: string): Promise<string | null> {
  const key = tokenKey(token);
  let pending = baseCache.get(key);
  if (!pending) {
    pending = ethCall(token, SELECTORS["symbol()"])
      .then((hex) => {
        const symbol = decodeString(hex);
        return symbol.length > 0 ? symbol : null;
      })
      .catch(() => {
        baseCache.delete(key);
        return null;
      });
    baseCache.set(key, pending);
  }
  return pending;
}

const decimalsCache = new Map<string, Promise<number | null>>();

/**
 * ERC-20 `decimals()` of a Base token through a raw `eth_call`, cached per page load; null when
 * the call fails or answers more than 36, so no amount is shown at a guessed scale (anyone can
 * `depositCash` any token to a NEAR account, so a Base cash row can hold any ERC-20).
 */
export function baseTokenDecimals(token: string): Promise<number | null> {
  const key = tokenKey(token);
  let pending = decimalsCache.get(key);
  if (!pending) {
    pending = ethCall(token, SELECTORS["decimals()"])
      .then((hex) => {
        const decimals = decodeUint(hex);
        return decimals <= 36n ? Number(decimals) : null;
      })
      .catch(() => {
        decimalsCache.delete(key);
        return null;
      });
    decimalsCache.set(key, pending);
  }
  return pending;
}

/** The token of a Base cash venue, or null for the NEAR tUSDC venue. */
function venueToken(venue: Venue): string | null {
  return venue === "Near" ? null : venue.Base.token;
}

/** Decimals of a cash venue: 6 for the NEAR tUSDC venue, the token's own `decimals()` for a Base venue (null when unreadable). */
export function venueDecimals(venue: Venue): Promise<number | null> {
  const token = venueToken(venue);
  return token === null ? Promise.resolve(USDC_DECIMALS) : baseTokenDecimals(token);
}

/** `venueDecimals` as React state: null until a Base token's decimals are read, and when the read failed. */
export function useVenueDecimals(venue: Venue): number | null {
  const token = venueToken(venue);
  const [resolved, setResolved] = useState<{ token: string; decimals: number | null } | null>(null);
  useEffect(() => {
    if (token === null) return;
    let live = true;
    void baseTokenDecimals(token).then((decimals) => {
      if (live) setResolved({ token, decimals });
    });
    return () => {
      live = false;
    };
  }, [token]);
  if (token === null) return USDC_DECIMALS;
  return resolved?.token === token ? resolved.decimals : null;
}

/** Symbol of a Solana mint: the Base demo token's symbol for the deployment's demo mint, null otherwise. */
export function solanaMintSymbol(mint: string): Promise<string | null> {
  const demoMint = deployed("solanaDemoMint");
  const demoToken = deployed("demoToken");
  if (!demoMint || !demoToken || demoMint !== mint) return Promise.resolve(null);
  return baseTokenSymbol(demoToken);
}

export function tokenSymbol(chain: TokenChain, token: string): Promise<string | null> {
  if (chain === "Solana") return solanaMintSymbol(token);
  const known = deployedCashSymbol(token);
  return known ? Promise.resolve(known) : baseTokenSymbol(token);
}

/** Symbols of `tokens`, keyed by `tokenKey`; tokens without a symbol are absent (the UI shows the short address). */
export async function tokenSymbols(tokens: readonly { chain: TokenChain; token: string }[]): Promise<Map<string, string>> {
  const unique = new Map<string, { chain: TokenChain; token: string }>();
  for (const entry of tokens) unique.set(`${entry.chain}:${tokenKey(entry.token)}`, entry);
  const entries = [...unique.values()];
  const resolved = await Promise.all(entries.map((entry) => tokenSymbol(entry.chain, entry.token)));
  const out = new Map<string, string>();
  entries.forEach((entry, index) => {
    const symbol = resolved[index];
    if (symbol) out.set(tokenKey(entry.token), symbol);
  });
  return out;
}

/** `tokenSymbol` as React state: null until resolved and when the token has no symbol. */
export function useTokenSymbol(chain: TokenChain, token: string): string | null {
  const [resolved, setResolved] = useState<{ key: string; symbol: string | null } | null>(null);
  const key = `${chain}:${tokenKey(token)}`;
  useEffect(() => {
    let live = true;
    void tokenSymbol(chain, token).then((symbol) => {
      if (live) setResolved({ key, symbol });
    });
    return () => {
      live = false;
    };
  }, [chain, token, key]);
  return resolved?.key === key ? resolved.symbol : null;
}
