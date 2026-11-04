import type { Metadata } from "next";
import { DOCS_INDEX_SLUG, getDoc } from "@/components/docs/content";
import { DocPageView } from "@/components/docs/DocPageView";

export const dynamic = "force-static";

export function generateMetadata(): Metadata {
  const page = getDoc(DOCS_INDEX_SLUG);
  return { title: "Docs", description: page?.summary.description };
}

export default function DocsIndexPage() {
  return <DocPageView slug={DOCS_INDEX_SLUG} />;
}
