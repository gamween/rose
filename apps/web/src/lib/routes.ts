export const ROUTES = {
  home: "/",
  app: "/app",
  portfolio: "/app",
  rounds: "/app/rounds",
  issuer: "/app/issuer",
  prices: "/app/prices",
  docs: "/docs",
  contracts: "/docs/contracts",
  status: "/status",
} as const;

export const GITHUB_URL = "https://github.com/gamween/rose";

export type NavItem = { label: string; href: string; match: (pathname: string) => boolean };

export const PRIMARY_NAV: readonly NavItem[] = [
  { label: "Rounds", href: ROUTES.rounds, match: (p) => p.startsWith(ROUTES.rounds) },
  { label: "Portfolio", href: ROUTES.portfolio, match: (p) => p === ROUTES.portfolio || p.startsWith("/app/deposit") },
  { label: "Issuer", href: ROUTES.issuer, match: (p) => p.startsWith(ROUTES.issuer) },
  { label: "Prices", href: ROUTES.prices, match: (p) => p.startsWith(ROUTES.prices) },
  { label: "Docs", href: ROUTES.docs, match: (p) => p.startsWith(ROUTES.docs) },
];

export const FOOTER_NAV = [
  { label: "Docs", href: ROUTES.docs, external: false },
  { label: "GitHub", href: GITHUB_URL, external: true },
  { label: "Contracts", href: ROUTES.contracts, external: false },
  { label: "Status", href: ROUTES.status, external: false },
] as const;
