/**
 * The DAO accounts this browser worked with in "Run via DAO" (read, funded or proposed for), so
 * the Results tab can list the Tenders those DAOs created: a Tender filed through a proposal has
 * the DAO, not the connected wallet, as its creator.
 */

export const DAO_ACCOUNTS_KEY = "rose.issuer.daos";
const MAX_REMEMBERED = 8;

/** A NEAR account id (2 to 64 characters, lowercase labels separated by dots). */
export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value);
}

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDaoAccounts(storage: Storage | null = store()): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(DAO_ACCOUNTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && isNearAccountId(item)) : [];
  } catch {
    return [];
  }
}

/** Puts `account` first in the remembered list (most recent first, at most eight) and returns the list. */
export function rememberDaoAccount(account: string, storage: Storage | null = store()): string[] {
  const trimmed = account.trim();
  const current = readDaoAccounts(storage);
  if (!isNearAccountId(trimmed)) return current;
  const next = [trimmed, ...current.filter((item) => item !== trimmed)].slice(0, MAX_REMEMBERED);
  try {
    storage?.setItem(DAO_ACCOUNTS_KEY, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

export function forgetDaoAccount(account: string, storage: Storage | null = store()): string[] {
  const next = readDaoAccounts(storage).filter((item) => item !== account);
  try {
    storage?.setItem(DAO_ACCOUNTS_KEY, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
}

/** Every creator the Results tab lists, the connected account first, without duplicates. */
export function resultCreators(connected: string | null, daos: readonly string[]): string[] {
  return [...new Set([...(connected ? [connected] : []), ...daos])];
}
