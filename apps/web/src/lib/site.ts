export const SITE_NAME = "rose";
export const SITE_TAGLINE = "What was locked, rose.";
export const SITE_DESCRIPTION =
  "Sealed, uniform-price liquidity rounds for locked token allocations. Issuers buy back insider allocations without guessing a price, holders exit together, and nobody can read a bid before the round closes. Testnet only.";

/** Absolute site URL for metadata: NEXT_PUBLIC_SITE_URL, else the Vercel production URL, else localhost. */
export function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return new URL(explicit);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return new URL(`https://${vercel}`);
  return new URL("http://localhost:3000");
}
