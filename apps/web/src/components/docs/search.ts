import type { SearchEntry } from "./types";

export type SearchHit = {
  slug: string;
  href: string;
  title: string;
  /** The matching heading, or `null` when the page title matched. */
  heading: string | null;
  section: string;
  description: string;
  score: number;
};

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function scoreText(haystack: string, terms: string[]): number {
  const words = haystack.split(" ");
  let score = 0;
  for (const term of terms) {
    if (words.includes(term)) score += 3;
    else if (words.some((word) => word.startsWith(term))) score += 2;
    else if (haystack.includes(term)) score += 1;
    else return 0;
  }
  return score;
}

/**
 * Client-side search over page titles and headings. Every term of the query must match (as a
 * word, a word prefix or a substring); whole-word and title matches rank first.
 */
export function searchDocs(index: readonly SearchEntry[], query: string, limit = 8): SearchHit[] {
  const terms = normalize(query).split(" ").filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index) {
    const titleScore = scoreText(normalize(entry.title), terms);
    if (titleScore > 0) {
      hits.push({
        slug: entry.slug,
        href: `/docs/${entry.slug}`,
        title: entry.title,
        heading: null,
        section: entry.section,
        description: entry.description,
        score: titleScore * 2 + 1,
      });
    }
    for (const heading of entry.headings) {
      const headingScore = scoreText(normalize(heading.text), terms);
      if (headingScore > 0) {
        hits.push({
          slug: entry.slug,
          href: `/docs/${entry.slug}#${heading.id}`,
          title: entry.title,
          heading: heading.text,
          section: entry.section,
          description: entry.description,
          score: headingScore + (heading.depth === 2 ? 0.5 : 0),
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, limit);
}
