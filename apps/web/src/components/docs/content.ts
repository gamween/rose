import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeployment } from "./deployment";
import { parseFrontmatter } from "./frontmatter";
import { compileMarkdown, type CompiledDoc } from "./markdown";
import type { DocSection, DocSummary, SearchEntry } from "./types";

export { DOCS_INDEX_SLUG } from "./types";
export type { DocSection, DocSummary, SearchEntry } from "./types";

export const DOCS_DIR = join(process.cwd(), "content", "docs");

export type DocPage = { summary: DocSummary; compiled: CompiledDoc; previous: DocSummary | null; next: DocSummary | null };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readSource(slug: string): string {
  return readFileSync(join(DOCS_DIR, `${slug}.md`), "utf8");
}

function compile(slug: string): { summary: DocSummary; compiled: CompiledDoc } {
  const { frontmatter, body } = parseFrontmatter(readSource(slug));
  const compiled = compileMarkdown(body, readDeployment());
  return { summary: { ...frontmatter, slug, headings: compiled.headings }, compiled };
}

let cache: Map<string, { summary: DocSummary; compiled: CompiledDoc }> | null = null;

function all(): Map<string, { summary: DocSummary; compiled: CompiledDoc }> {
  if (cache) return cache;
  const entries = readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
  for (const slug of entries) {
    if (!SLUG.test(slug)) throw new Error(`Docs file name is not a slug: ${slug}.md`);
  }
  const pages = entries.map(compile).sort((a, b) => a.summary.order - b.summary.order || a.summary.slug.localeCompare(b.summary.slug));
  cache = new Map(pages.map((page) => [page.summary.slug, page]));
  return cache;
}

/** Every page in reading order (by `order`). */
export function listDocs(): DocSummary[] {
  return [...all().values()].map((page) => page.summary);
}

/** Pages grouped by `section`, sections in order of first appearance. */
export function listSections(): DocSection[] {
  const sections: DocSection[] = [];
  for (const doc of listDocs()) {
    const section = sections.find((candidate) => candidate.name === doc.section);
    if (section) section.docs.push(doc);
    else sections.push({ name: doc.section, docs: [doc] });
  }
  return sections;
}

/** One page with its neighbours in reading order, or `null` for an unknown slug. */
export function getDoc(slug: string): DocPage | null {
  const page = all().get(slug);
  if (!page) return null;
  const docs = listDocs();
  const index = docs.findIndex((doc) => doc.slug === slug);
  return { summary: page.summary, compiled: page.compiled, previous: docs[index - 1] ?? null, next: docs[index + 1] ?? null };
}

export function searchIndex(): SearchEntry[] {
  return listDocs().map(({ slug, title, description, section, headings }) => ({ slug, title, description, section, headings }));
}
