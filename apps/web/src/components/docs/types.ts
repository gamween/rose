import type { DocFrontmatter } from "./frontmatter";
import type { DocHeading } from "./markdown";

/** The page shown at `/docs` itself. */
export const DOCS_INDEX_SLUG = "overview";

export type DocSummary = DocFrontmatter & { slug: string; headings: DocHeading[] };

export type DocSection = { name: string; docs: DocSummary[] };

/** Search index entry handed to the client: titles and headings only, no body text. */
export type SearchEntry = { slug: string; title: string; description: string; section: string; headings: DocHeading[] };

export function docHref(slug: string): string {
  return slug === DOCS_INDEX_SLUG ? "/docs" : `/docs/${slug}`;
}
