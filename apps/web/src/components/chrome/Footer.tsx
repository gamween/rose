import Link from "next/link";
import { RoseGlyph } from "@/components/brand/Logo";
import { footerNav } from "@/lib/routes";

export function Footer() {
  return (
    <footer className="border-t border-ink-750 bg-ink-950">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-8 md:flex-row md:items-center md:justify-between md:px-6">
        <div className="flex items-center gap-3">
          <RoseGlyph size={16} />
          <p className="text-[12px] text-ink-400">
            rose runs on NEAR testnet, Base Sepolia and Solana devnet. Test assets only.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {footerNav().map((item) => (
              <li key={item.label}>
                {item.external ? (
                  <a
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-display text-[12px] uppercase tracking-wide text-ink-300 hover:text-ember-300"
                  >
                    {item.label}
                  </a>
                ) : (
                  <Link href={item.href} className="font-display text-[12px] uppercase tracking-wide text-ink-300 hover:text-ember-300">
                    {item.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
