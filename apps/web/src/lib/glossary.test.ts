import type { Element } from "hast";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { getDoc } from "@/components/docs/content";
import { GLOSSARY, glossaryAnchor, glossaryHref } from "./glossary";

describe("glossary", () => {
  it("derives the anchor from the lead term", () => {
    expect(glossaryAnchor("Clearing price (P*).")).toBe("term-clearing-price");
    expect(glossaryAnchor("Lien, lien share.")).toBe("term-lien");
    expect(glossaryAnchor("Unit.")).toBe("term-unit");
  });

  it("links every in-app term to an entry the docs glossary anchors", () => {
    const ids = new Set<string>();
    visit(getDoc("glossary")!.compiled.tree, "element", (node: Element) => {
      if (typeof node.properties.id === "string") ids.add(node.properties.id);
    });
    for (const term of Object.keys(GLOSSARY) as (keyof typeof GLOSSARY)[]) {
      const anchor = glossaryHref(term).split("#")[1]!;
      expect(ids, `${term} -> #${anchor}`).toContain(anchor);
    }
  });
});
