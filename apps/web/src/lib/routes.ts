export const ROUTES = {
  home: "/",
  app: "/app",
  portfolio: "/app",
  rounds: "/app/rounds",
  demo: "/app/demo",
  issuer: "/app/issuer",
  prices: "/app/prices",
  docs: "/docs",
  contracts: "/docs/contracts",
  status: "/status",
} as const;

/**
 * The public source repository (`NEXT_PUBLIC_REPOSITORY_URL`), or null while the repository is
 * private: GitHub answers 404 to visitors then, so the footer and the palette show no GitHub
 * link until the variable is set (spec 8.2 footer: the link appears once the repository is public).
 */
export const REPOSITORY_URL: string | null = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim() || null;

export type NavItem = { label: string; href: string; match: (pathname: string) => boolean };

export const PRIMARY_NAV: readonly NavItem[] = [
  { label: "Rounds", href: ROUTES.rounds, match: (p) => p.startsWith(ROUTES.rounds) },
  { label: "Portfolio", href: ROUTES.portfolio, match: (p) => p === ROUTES.portfolio || p.startsWith("/app/deposit") },
  { label: "Issuer", href: ROUTES.issuer, match: (p) => p.startsWith(ROUTES.issuer) },
  { label: "Prices", href: ROUTES.prices, match: (p) => p.startsWith(ROUTES.prices) },
  { label: "Docs", href: ROUTES.docs, match: (p) => p.startsWith(ROUTES.docs) },
];

export type FooterLink = { label: string; href: string; external: boolean };

export function footerNav(repositoryUrl: string | null = REPOSITORY_URL): FooterLink[] {
  return [
    { label: "Docs", href: ROUTES.docs, external: false },
    ...(repositoryUrl ? [{ label: "GitHub", href: repositoryUrl, external: true }] : []),
    { label: "Contracts", href: ROUTES.contracts, external: false },
    { label: "Status", href: ROUTES.status, external: false },
  ];
}
