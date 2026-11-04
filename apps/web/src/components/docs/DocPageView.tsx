import { Footer } from "@/components/chrome/Footer";
import { TopNav } from "@/components/chrome/TopNav";
import { ButtonLink } from "@/components/ui/Button";
import { ROUTES } from "@/lib/routes";
import { getDoc, listSections, searchIndex } from "./content";
import { DocsArticle } from "./DocsArticle";
import { DocsMobileNav } from "./DocsMobileNav";
import { DocsNav } from "./DocsNav";
import { DocsPager } from "./DocsPager";
import { DocsSearch } from "./DocsSearch";
import { DocsToc } from "./DocsToc";

/** A statically generated docs page: chrome, section navigation, article, table of contents and pager. */
export function DocPageView({ slug }: { slug: string }) {
  const page = getDoc(slug);
  if (!page) throw new Error(`Unknown docs page: ${slug}`);
  const sections = listSections();
  const index = searchIndex();
  const { summary, compiled, previous, next } = page;

  return (
    <>
      <TopNav
        action={
          <ButtonLink href={ROUTES.app} size="sm">
            Launch app
          </ButtonLink>
        }
      />
      <DocsMobileNav sections={sections} index={index} current={summary.title} />
      <div className="mx-auto flex w-full max-w-[1440px] gap-10 px-4 py-8 md:px-6 lg:py-10">
        <aside className="sticky top-20 hidden w-60 shrink-0 self-start lg:block">
          <DocsSearch index={index} className="mb-6" />
          <DocsNav sections={sections} />
        </aside>
        <main className="min-w-0 flex-1" id="docs-content">
          <header className="mb-6">
            <p className="font-display text-[11px] uppercase tracking-wide text-ember-400">{summary.section}</p>
            <h1 className="mt-2 font-display text-[28px] leading-tight text-ink-50 md:text-[34px]">{summary.title}</h1>
            <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-300">{summary.description}</p>
          </header>
          {compiled.headings.length > 0 ? (
            <details className="mb-6 rounded-md border border-ink-750 bg-ink-900 px-4 py-3 xl:hidden">
              <summary className="cursor-pointer font-display text-[11px] uppercase tracking-wide text-ink-300">On this page</summary>
              <ul className="mt-3 flex flex-col gap-1.5 text-[13px]">
                {compiled.headings.map((heading) => (
                  <li key={heading.id} className={heading.depth === 3 ? "pl-4" : undefined}>
                    <a href={`#${heading.id}`} className="text-ink-300 hover:text-ink-50">
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <article className="max-w-3xl">
            <DocsArticle tree={compiled.tree} />
          </article>
          <DocsPager previous={previous} next={next} />
        </main>
        <aside className="sticky top-20 hidden w-56 shrink-0 self-start xl:block">
          <DocsToc headings={compiled.headings} />
        </aside>
      </div>
      <Footer />
    </>
  );
}
