import type { Element, Root, RootContent, Text } from "hast";
import { toString as hastToString } from "hast-util-to-string";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

export type DocHeading = { id: string; text: string; depth: 2 | 3 };

export type CompiledDoc = { tree: Root; headings: DocHeading[] };

export type PlaceholderValues = Record<string, string | null>;

/** Text shown wherever a deployment placeholder has no value yet. */
export const NOT_DEPLOYED_TEXT = "Not deployed yet";

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

function placeholderElement(key: string, value: string | null): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { dataPlaceholder: key, dataDeployed: value ? "true" : "false" },
    children: [{ type: "text", value: value ?? NOT_DEPLOYED_TEXT }],
  };
}

/**
 * Replaces `{{KEY}}` tokens inside text nodes with the deployed value, or with a marked
 * "Not deployed yet" element when the value is missing. Unknown keys are reported as errors so a
 * typo can never reach the page as a raw token.
 */
function substitutePlaceholders(tree: Root, values: PlaceholderValues): void {
  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === undefined || !PLACEHOLDER.test(node.value)) return;
    PLACEHOLDER.lastIndex = 0;
    const replacement: RootContent[] = [];
    let cursor = 0;
    for (const match of node.value.matchAll(PLACEHOLDER)) {
      const key = match[1]!;
      if (!(key in values)) throw new Error(`Unknown docs placeholder {{${key}}}.`);
      if (match.index > cursor) replacement.push({ type: "text", value: node.value.slice(cursor, match.index) });
      replacement.push(placeholderElement(key, values[key] ?? null));
      cursor = match.index + match[0].length;
    }
    if (cursor < node.value.length) replacement.push({ type: "text", value: node.value.slice(cursor) });
    parent.children.splice(index, 1, ...replacement);
    return index + replacement.length;
  });
}

function collectHeadings(tree: Root): DocHeading[] {
  const headings: DocHeading[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "h2" && node.tagName !== "h3") return;
    const id = node.properties.id;
    if (typeof id !== "string") return;
    headings.push({ id, text: hastToString(node), depth: node.tagName === "h2" ? 2 : 3 });
  });
  return headings;
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(rehypeSlug);

/** Compiles a docs page body (GitHub-flavoured Markdown) into a hast tree with slugged headings. */
export function compileMarkdown(body: string, placeholders: PlaceholderValues = {}): CompiledDoc {
  const tree = processor.runSync(processor.parse(body)) as Root;
  substitutePlaceholders(tree, placeholders);
  return { tree, headings: collectHeadings(tree) };
}

/** Every `href` of the tree, for link checks. */
export function collectLinks(tree: Root): string[] {
  const links: string[] = [];
  visit(tree, "element", (node: Element) => {
    if (node.tagName === "a" && typeof node.properties.href === "string") links.push(node.properties.href);
  });
  return links;
}

/** Plain text of the tree, for search previews. */
export function plainText(tree: Root): string {
  return hastToString(tree);
}
