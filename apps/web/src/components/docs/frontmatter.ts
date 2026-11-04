export type DocFrontmatter = {
  title: string;
  description: string;
  order: number;
  section: string;
};

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

/**
 * Splits a docs page into its frontmatter and body. The frontmatter is a flat `key: value`
 * block between two `---` lines; every page must declare title, description, order and section.
 */
export function parseFrontmatter(source: string): { frontmatter: DocFrontmatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) throw new FrontmatterError("Missing frontmatter block.");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new FrontmatterError(`Malformed frontmatter line: ${line}`);
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const required = ["title", "description", "order", "section"] as const;
  for (const key of required) {
    if (!fields.get(key)) throw new FrontmatterError(`Frontmatter is missing ${key}.`);
  }
  const order = Number(fields.get("order"));
  if (!Number.isInteger(order) || order < 0) throw new FrontmatterError("Frontmatter order must be a non-negative integer.");
  return {
    frontmatter: {
      title: fields.get("title")!,
      description: fields.get("description")!,
      order,
      section: fields.get("section")!,
    },
    body: source.slice(match[0].length),
  };
}
