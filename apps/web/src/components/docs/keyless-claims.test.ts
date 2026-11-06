import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_DIR } from "./content";

/**
 * Only the final engine is deployed keyless; a staging engine keeps a full-access key. A doc
 * sentence that ties the engine to "keyless" or "no access keys" must say which engine it means
 * (the final one, a staging one) or point to the live check, so it stays true for whatever engine
 * the app is configured with.
 */
const KEYLESS = /\b(keyless|no access keys?)\b/i;
const ENGINE = /\bengine\b/i;
const QUALIFIED = /\b(final|staging|whether)\b|status page|\(\/status\)/i;
const FORBIDDEN = [/\bthe engine is keyless\b/i, /\bthe engine account has no access keys\b/i, /\bthe keyless engine\b/i];

function sentences(markdown: string): string[] {
  return markdown
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z*`[])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

const docs = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ name, body: readFileSync(join(DOCS_DIR, name), "utf8") }));

describe("keyless claims in the docs", () => {
  it("reads every doc", () => {
    expect(docs.length).toBeGreaterThan(10);
  });

  it.each(docs)("$name never states the engine is keyless unconditionally", ({ body }) => {
    for (const pattern of FORBIDDEN) expect(body).not.toMatch(pattern);
    const unqualified = sentences(body).filter((sentence) => ENGINE.test(sentence) && KEYLESS.test(sentence) && !QUALIFIED.test(sentence));
    expect(unqualified).toEqual([]);
  });
});
