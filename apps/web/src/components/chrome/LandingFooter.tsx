import Link from "next/link";
import { Logo } from "@/components/brand/Logo";
import { REPOSITORY_URL, ROUTES } from "@/lib/routes";

type FooterColumn = { title: string; links: { label: string; href: string; external?: boolean }[] };

const doc = (slug: string) => `${ROUTES.docs}/${slug}`;

/** Reference links under the landing sequence: reading material only, the app itself is one button away. */
function columns(repositoryUrl: string | null): FooterColumn[] {
  return [
    {
      title: "Learn",
      links: [
        { label: "Overview", href: ROUTES.docs },
        { label: "How a sealed round works", href: doc("sealed-rounds") },
        { label: "Clearing rules", href: doc("clearing-rules") },
        { label: "Fees", href: doc("fees") },
        { label: "FAQ", href: doc("faq") },
      ],
    },
    {
      title: "Guides",
      links: [
        { label: "For issuers", href: doc("guide-issuer") },
        { label: "For holders", href: doc("guide-holder") },
        { label: "For buyers", href: doc("guide-buyer") },
        { label: "Glossary", href: doc("glossary") },
      ],
    },
    {
      title: "Developers",
      links: [
        { label: "Contracts and addresses", href: ROUTES.contracts },
        { label: "SDK", href: doc("sdk") },
        { label: "Trust and security", href: doc("trust-and-security") },
        ...(repositoryUrl ? [{ label: "GitHub", href: repositoryUrl, external: true }] : []),
      ],
    },
    {
      title: "Network",
      links: [
        { label: "Live status", href: ROUTES.status },
        { label: "Cross-chain custody", href: doc("cross-chain-custody") },
      ],
    },
  ];
}

export function LandingFooter() {
  return (
    <footer className="border-t border-ink-800 bg-ink-950" data-landing-footer>
      <div className="mx-auto grid max-w-[1440px] gap-10 px-4 py-14 md:grid-cols-[minmax(0,1.2fr)_repeat(4,minmax(0,1fr))] md:px-6">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-[280px] text-[13px] leading-relaxed text-ink-400">
            Sealed, uniform-price liquidity rounds for locked token allocations, settled on NEAR.
          </p>
          <p className="text-[12px] text-ink-500">Testnet only: NEAR testnet, Base Sepolia, Solana devnet.</p>
        </div>
        {columns(REPOSITORY_URL).map((column) => (
          <nav key={column.title} aria-label={column.title} className="flex flex-col gap-3">
            <h2 className="text-[12px] font-medium text-ink-300">{column.title}</h2>
            <ul className="flex flex-col gap-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  {link.external ? (
                    <a href={link.href} target="_blank" rel="noreferrer" className="text-[13px] text-ink-400 transition-colors hover:text-ember-300">
                      {link.label}
                    </a>
                  ) : (
                    <Link href={link.href} className="text-[13px] text-ink-400 transition-colors hover:text-ember-300">
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
    </footer>
  );
}
