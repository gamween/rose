import { describe, expect, it } from "vitest";
import { DOCS_INDEX_SLUG, getDoc, listDocs, listSections, searchIndex } from "./content";
import { collectLinks, plainText } from "./markdown";

const EXTERNAL = /^https?:\/\//;

describe("docs content", () => {
  const docs = listDocs();

  it("contains every page of the spec, with the overview first", () => {
    expect(docs[0]?.slug).toBe(DOCS_INDEX_SLUG);
    expect(docs.map((doc) => doc.slug)).toEqual([
      "overview",
      "concepts",
      "sealed-rounds",
      "clearing-rules",
      "cross-chain-custody",
      "trust-and-security",
      "fees",
      "guide-issuer",
      "guide-holder",
      "guide-buyer",
      "contracts-and-addresses",
      "sdk",
      "faq",
      "glossary",
    ]);
  });

  it("groups pages by section in order of first appearance", () => {
    expect(listSections().map((section) => section.name)).toEqual(["Introduction", "Mechanism", "Guides", "Reference"]);
  });

  it("links previous and next pages in reading order", () => {
    const concepts = getDoc("concepts")!;
    expect(concepts.previous?.slug).toBe("overview");
    expect(concepts.next?.slug).toBe("sealed-rounds");
    expect(getDoc("overview")!.previous).toBeNull();
    expect(getDoc("glossary")!.next).toBeNull();
    expect(getDoc("missing")).toBeNull();
  });

  it("has unique heading ids on every page", () => {
    for (const doc of docs) {
      const ids = doc.headings.map((heading) => heading.id);
      expect(new Set(ids).size, `${doc.slug} has duplicate heading ids`).toBe(ids.length);
    }
  });

  it("resolves every internal link and anchor", () => {
    const slugs = new Set(docs.map((doc) => doc.slug));
    const routes = new Set(["/status", "/app", "/app/rounds", "/app/prices", "/app/deposit", "/app/issuer", "/app/advance", "/"]);
    for (const doc of docs) {
      for (const href of collectLinks(getDoc(doc.slug)!.compiled.tree)) {
        if (EXTERNAL.test(href)) continue;
        const [path, anchor] = href.split("#");
        const target = path === "" ? doc.slug : path!.startsWith("/docs/") ? path!.slice("/docs/".length) : path === "/docs" ? DOCS_INDEX_SLUG : null;
        if (target === null) {
          expect(routes.has(path!), `${doc.slug} links to an unknown route ${href}`).toBe(true);
          continue;
        }
        expect(slugs.has(target), `${doc.slug} links to an unknown page ${href}`).toBe(true);
        if (anchor) {
          const ids = getDoc(target)!.summary.headings.map((heading) => heading.id);
          expect(ids, `${doc.slug} links to a missing anchor ${href}`).toContain(anchor);
        }
      }
    }
  });

  it("never leaves a raw placeholder in a page", () => {
    for (const doc of docs) {
      expect(plainText(getDoc(doc.slug)!.compiled.tree)).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it("builds a search index without page bodies", () => {
    const index = searchIndex();
    expect(index).toHaveLength(docs.length);
    expect(Object.keys(index[0]!)).toEqual(["slug", "title", "description", "section", "headings"]);
  });
});
