import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { DOCS_INDEX_SLUG, getDoc, listDocs } from "@/components/docs/content";
import { DocPageView } from "@/components/docs/DocPageView";

export const dynamic = "force-static";
export const dynamicParams = false;

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams(): { slug: string }[] {
  return listDocs().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = getDoc(slug);
  if (!page) return {};
  return { title: page.summary.title, description: page.summary.description };
}

export default async function DocPage({ params }: Params) {
  const { slug } = await params;
  if (slug === DOCS_INDEX_SLUG) permanentRedirect("/docs");
  if (!getDoc(slug)) notFound();
  return <DocPageView slug={slug} />;
}
