/**
 * Display symbols of the tokens the app shows (stream tokens of classes, cash venues). Base
 * tokens are read on chain with ERC-20 `symbol()`. The Solana demo mint is a plain SPL mint
 * without Metaplex metadata (no symbol on chain); the deployment declares it as the Solana twin of
 * the Base demo token (`NEXT_PUBLIC_SOLANA_DEMO_MINT`), so it shows that token's on-chain symbol.
 * Every label keeps the full address at hand for a tooltip.
 */

import { useEffect, useState } from "react";
import { decodeString, ethCall, SELECTORS } from "@/components/status/rpc";
import { CIRCLE_USDC_BASE_SEPOLIA, deployed } from "./deployment";

export type TokenChain = "Base" | "Solana";

/** Map key of a token: EVM addresses are case-insensitive; two base58 mints differing only in case are practically impossible. */
export function tokenKey(token: string): string {
  return token.toLowerCase();
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
