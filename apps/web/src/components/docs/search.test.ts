import { describe, expect, it } from "vitest";
import type { SearchEntry } from "./types";
import { searchDocs } from "./search";

const INDEX: SearchEntry[] = [
  {
    slug: "clearing-rules",
    title: "Clearing rules",
    description: "Rules",
    section: "Mechanism",
    headings: [
      { id: "tender", text: "Tender", depth: 2 },
      { id: "example-2-a-rationed-marginal-level", text: "Example 2: a rationed marginal level", depth: 3 },
    ],
  },
  {
    slug: "fees",
    title: "Fees",
    description: "What rose charges",
    section: "Mechanism",
    headings: [{ id: "protocol-fee", text: "Protocol fee", depth: 2 }],
  },
];

describe("searchDocs", () => {
  it("returns nothing for an empty query", () => {
    expect(searchDocs(INDEX, "   ")).toEqual([]);
  });

  it("ranks a title match above a heading match and links headings with anchors", () => {
    const hits = searchDocs(INDEX, "fee");
    expect(hits[0]).toMatchObject({ slug: "fees", heading: null, href: "/docs/fees" });
    expect(hits[1]).toMatchObject({ slug: "fees", heading: "Protocol fee", href: "/docs/fees#protocol-fee" });
  });

  it("requires every term to match and accepts word prefixes", () => {
    expect(searchDocs(INDEX, "rationed level").map((hit) => hit.href)).toEqual(["/docs/clearing-rules#example-2-a-rationed-marginal-level"]);
    expect(searchDocs(INDEX, "rationed nothing")).toEqual([]);
  });

  it("ignores case and punctuation", () => {
    expect(searchDocs(INDEX, "EXAMPLE 2:")[0]?.heading).toBe("Example 2: a rationed marginal level");
  });
});
