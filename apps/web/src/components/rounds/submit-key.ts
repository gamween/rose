/**
 * The `submit_key` fallback (spec 5.1): when the CKD callback is lost or starved, the MPC's
 * response `(big_y, big_c)` stays public in its `respond_ckd` transaction (and a late response
 * in a failed one). Anyone unwraps it with the round's public scalar and submits the key, which
 * the engine checks with one pairing. The app accepts the key itself, the two points, or the
 * transaction's JSON arguments, and checks the key in the browser before anything is signed.
 */

export type KeyInput = { kind: "key"; key: string } | { kind: "response"; bigY: string; bigC: string };

const G1 = /^bls12381g1:[1-9A-HJ-NP-Za-km-z]+$/;

function findResponse(value: unknown): { bigY: string; bigC: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.big_y === "string" && typeof record.big_c === "string") return { bigY: record.big_y.trim(), bigC: record.big_c.trim() };
  for (const child of Object.values(record)) {
    const found = findResponse(child);
    if (found) return found;
  }
  return null;
}

/** Reads what a person pasted: a `bls12381g1:` key, the two points `big_y big_c`, or JSON holding `big_y` and `big_c`. */
export function parseKeyInput(text: string): KeyInput | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) {
    try {
      const found = findResponse(JSON.parse(trimmed));
      return found && G1.test(found.bigY) && G1.test(found.bigC) ? { kind: "response", ...found } : null;
    } catch {
      return null;
    }
  }
  const parts = trimmed.split(/[\s,]+/).filter((part) => part !== "");
  if (parts.length === 1 && G1.test(parts[0] ?? "")) return { kind: "key", key: parts[0] ?? "" };
  if (parts.length === 2 && parts.every((part) => G1.test(part))) return { kind: "response", bigY: parts[0] ?? "", bigC: parts[1] ?? "" };
  return null;
}

export interface KeyTools {
  unwrap: (engineAccount: string, roundId: bigint, bigY: string, bigC: string) => string | Promise<string>;
  verify: (mpk: string, engineAccount: string, roundId: bigint, key: string) => boolean | Promise<boolean>;
}

export type ResolvedKey = { ok: true; key: string } | { ok: false; message: string };

/** The round key from the input, unwrapped when needed and verified against the round identity. */
export async function resolveRoundKey(input: KeyInput, round: { mpk: string; engineAccount: string; roundId: bigint }, tools: KeyTools): Promise<ResolvedKey> {
  let key: string;
  try {
    key = input.kind === "key" ? input.key : await tools.unwrap(round.engineAccount, round.roundId, input.bigY, input.bigC);
  } catch (error) {
    return { ok: false, message: `The response could not be unwrapped: ${error instanceof Error ? error.message : String(error)}` };
  }
  let valid: boolean;
  try {
    valid = await tools.verify(round.mpk, round.engineAccount, round.roundId, key);
  } catch (error) {
    return { ok: false, message: `The key could not be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!valid) return { ok: false, message: `This key does not open round #${round.roundId.toString()} of ${round.engineAccount}: the engine would refuse it. Check that the response is the one for this round.` };
  return { ok: true, key };
}
