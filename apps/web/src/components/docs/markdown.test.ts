import { describe, expect, it } from "vitest";
import { FrontmatterError, parseFrontmatter } from "./frontmatter";
import { collectLinks, compileMarkdown, NOT_DEPLOYED_TEXT, plainText } from "./markdown";

const SAMPLE = `---
title: Clearing rules
description: The exact rules.
order: 4
section: Mechanism
---

## Tender

Text with a [link](/docs/fees) and an [anchor](#tender).

### Example 1: the spec example

| Candidate P | Q(P) |
|---|---|
| 9 | **100** |

Engine: \`{{ENGINE_ACCOUNT}}\`, vault: \`{{ROSE_VAULT}}\`.
`;

describe("parseFrontmatter", () => {
  it("reads the four fields and returns the body", () => {
    const { frontmatter, body } = parseFrontmatter(SAMPLE);
    expect(frontmatter).toEqual({ title: "Clearing rules", description: "The exact rules.", order: 4, section: "Mechanism" });
    expect(body.startsWith("\n## Tender")).toBe(true);
  });

  it("rejects a page without the required fields", () => {
    expect(() => parseFrontmatter("---\ntitle: x\n---\nbody")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("no frontmatter")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("---\ntitle: x\ndescription: y\norder: two\nsection: z\n---\n")).toThrow(/order/);
  });
});

describe("compileMarkdown", () => {
  const body = parseFrontmatter(SAMPLE).body;

  it("slugs h2 and h3 headings and lists them in order", () => {
    const { headings } = compileMarkdown(body, { ENGINE_ACCOUNT: null, ROSE_VAULT: null });
    expect(headings).toEqual([
      { id: "tender", text: "Tender", depth: 2 },
      { id: "example-1-the-spec-example", text: "Example 1: the spec example", depth: 3 },
    ]);
  });

  it("renders GFM tables and keeps links", () => {
    const { tree } = compileMarkdown(body, { ENGINE_ACCOUNT: null, ROSE_VAULT: null });
    expect(JSON.stringify(tree)).toContain('"tagName":"table"');
    expect(collectLinks(tree)).toEqual(["/docs/fees", "#tender"]);
  });

  it("substitutes deployed placeholders and marks missing ones", () => {
    const { tree } = compileMarkdown(body, { ENGINE_ACCOUNT: "engine.rose-app.testnet", ROSE_VAULT: null });
    const html = JSON.stringify(tree);
    expect(html).not.toContain("{{");
    expect(html).toContain('"dataPlaceholder":"ENGINE_ACCOUNT","dataDeployed":"true"');
    expect(html).toContain('"dataPlaceholder":"ROSE_VAULT","dataDeployed":"false"');
    const text = plainText(tree);
    expect(text).toContain("engine.rose-app.testnet");
    expect(text).toContain(NOT_DEPLOYED_TEXT);
  });

  it("refuses an unknown placeholder instead of leaking it", () => {
    expect(() => compileMarkdown("Address `{{NOPE}}`", {})).toThrow(/NOPE/);
  });
});
