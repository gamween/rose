/**
 * The keyless check of the status page (spec 7.4, DoD 3), stated from the raw
 * `view_access_key_list` result only: a deployment is "keyless" when the list is empty, and never
 * otherwise, whatever the account is called.
 */

export type AccessKeyEntry = { publicKey: string; permission: "FullAccess" | "FunctionCall" };

export type KeylessCheck =
  | { keyless: true; badge: string; summary: string; keys: [] }
  | { keyless: false; badge: string; summary: string; keys: AccessKeyEntry[]; staging: boolean };

/** Staging engines are deployed as `engine-s<N>.<root>` and keep the team's key (docs/verification.md). */
export function isStagingEngine(account: string): boolean {
  return /^engine-s\d+\./.test(account);
}

function entry(raw: unknown): AccessKeyEntry {
  const key = raw as { public_key?: unknown; access_key?: { permission?: unknown } };
  const permission = key.access_key?.permission === "FullAccess" ? "FullAccess" : "FunctionCall";
  return { publicKey: typeof key.public_key === "string" ? key.public_key : "unknown key", permission };
}

export function keylessCheck(account: string, rawKeys: readonly unknown[]): KeylessCheck {
  if (rawKeys.length === 0) return { keyless: true, badge: "Keyless", summary: "None: the contract has no full-access or function-call key, so no one can upgrade, drain or stop it.", keys: [] };
  const keys = rawKeys.map(entry);
  const full = keys.filter((key) => key.permission === "FullAccess").length;
  const staging = isStagingEngine(account);
  const count = `${String(keys.length)} key${keys.length === 1 ? "" : "s"}`;
  const kinds = full === keys.length ? (full === 1 ? "a full-access key" : `${String(full)} full-access keys`) : `${String(full)} full-access and ${String(keys.length - full)} function-call key${keys.length - full === 1 ? "" : "s"}`;
  const holder = full > 0 ? "Its holder can deploy new code to this account, so this deployment is not trustless." : "Function-call keys can only call the methods they name.";
  const summary = staging
    ? `Not keyless: ${kinds} attached. This is a staging engine, which keeps the team's key on purpose; the release engine deletes every key after init. ${holder}`
    : `Not keyless: ${kinds} attached. ${holder}`;
  return { keyless: false, badge: `Not keyless · ${count}`, summary, keys, staging };
}
