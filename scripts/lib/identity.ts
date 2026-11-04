/**
 * The demo scenario of spec section 9: the fictional issuer Cindral Foundation and its token
 * Cindral (CINDR), three cohorts, six holders and the three rounds. Names and tickers were checked
 * live against CoinGecko, DefiLlama and DexScreener (docs/verification.md, "Demo identity").
 *
 * Schedules. `seed-base` and `kol-base` use the exact schedules of the deployed DemoStreamFaucet
 * (read live, so positions judges mint from the app land in the same classes); the Seed Round
 * cliff is in May 2027, which is why the Advance, whose repayment must be visible during the
 * hackathon, sits on the KOL Round (linear since its TGE). `strategic-sol` is a Streamflow cohort:
 * 10% at the February 2027 cliff, then 5% every 30 days.
 *
 * Amounts are whole tokens or whole tUSDC here; prices are tUSDC per whole locked token (per
 * claimed token in the Advance).
 */

export const ROOT_ACCOUNT = "rose-app.testnet";

export const TOKEN = { name: "Cindral", symbol: "CINDR", solanaDecimals: 9 } as const;

export interface Member {
  slug: string;
  name: string;
  /** NEAR balance the account is topped up to (it pays its own gas, order deposits and payout records). */
  nearBalance: string;
  /** tUSDC minted on NEAR and deposited as engine cash (bonds, escrows). */
  nearCash: number;
  /** tUSDC deposited as engine cash on Base (RoseVault `depositCash`) for the Tender. */
  baseCash: number;
}

export const CAST = {
  issuer: { slug: "cindral-foundation", name: "Cindral Foundation", nearBalance: "0.6", nearCash: 0, baseCash: 1_505 },
  halden: { slug: "halden-ventures", name: "Halden Ventures", nearBalance: "0.35", nearCash: 2_050, baseCash: 20 },
  tessaro: { slug: "tessaro-capital", name: "Tessaro Capital", nearBalance: "0.35", nearCash: 900, baseCash: 15 },
  ines: { slug: "ines-marlow", name: "Ines Marlow", nearBalance: "0.45", nearCash: 150, baseCash: 0 },
  varick: { slug: "varick-partners", name: "Varick Partners", nearBalance: "0.45", nearCash: 150, baseCash: 0 },
  teodor: { slug: "teodor-vance", name: "Teodor Vance", nearBalance: "0.35", nearCash: 10, baseCash: 0 },
  nadia: { slug: "nadia-solvik", name: "Nadia Solvik", nearBalance: "0.35", nearCash: 150, baseCash: 0 },
} as const satisfies Record<string, Member>;

export type Who = keyof typeof CAST;
export const EVERYONE = Object.keys(CAST) as Who[];

export function accountOf(who: Who): string {
  return `${CAST[who].slug}.${ROOT_ACCOUNT}`;
}

/** ETH sent to the KOL holder's EVM wallet: faucet mint, NFT approval and `depositStream`. */
export const NADIA_ETH = "0.002";
/** SOL sent to each Strategic Round holder: `transfer_recipient` fee and the deposit address's token account rent. */
export const STRATEGIC_HOLDER_SOL = 0.01;
/** SOL kept on the engine's gas/sol fee payer: the status page shows "Gas funded" from 0.1 SOL. */
export const GAS_SOL_FUNDED = 0.1;

export type CohortKey = "seed-base" | "kol-base" | "strategic-sol";

export const COHORTS = {
  "seed-base": { label: "Seed Round", chain: "Base", faucetClass: 0, allocations: [["halden", 400_000], ["tessaro", 250_000]] },
  "kol-base": { label: "KOL Round", chain: "Base", faucetClass: 1, allocations: [["teodor", 60_000], ["nadia", 20_000]] },
  "strategic-sol": { label: "Strategic Round", chain: "Solana", allocations: [["ines", 300_000], ["varick", 200_000]] },
} as const satisfies Record<CohortKey, { label: string; chain: "Base" | "Solana"; faucetClass?: 0 | 1; allocations: readonly (readonly [Who, number])[] }>;

/** Streamflow schedule of the Strategic Round, per holder: fractions of the allocation. */
export const STRATEGIC_SCHEDULE = {
  /** 2027-02-01T00:00:00Z: start and cliff. */
  start: 1_801_440_000,
  period: 30 * 24 * 3_600,
  cliffPercent: 10n,
  perPeriodPercent: 5n,
  name: "Cindral Strategic Round",
} as const;

export interface SealedOrder {
  who: Who;
  quantity: number;
  price: number;
}

export const ROUNDS = {
  tender: {
    cohort: "seed-base",
    budget: 1_500,
    maxPrice: 0.04,
    referencePrice: 0.08,
    asks: [
      { who: "halden", quantity: 40_000, price: 0.03 },
      { who: "tessaro", quantity: 30_000, price: 0.036 },
    ],
  },
  exit: {
    cohort: "strategic-sol",
    creator: "ines",
    maxPrice: 0.05,
    asks: [
      { who: "ines", quantity: 60_000, price: 0.02 },
      { who: "varick", quantity: 50_000, price: 0.026 },
    ],
    bids: [
      { who: "halden", quantity: 70_000, price: 0.028 },
      { who: "tessaro", quantity: 40_000, price: 0.022 },
    ],
    /** A bid whose ciphertext nobody can open (one byte of `V` flipped): void and slashed at clearing. */
    malformed: { who: "nadia", quantity: 1_000, price: 0.03, escrow: 100 },
  },
  advance: {
    cohort: "kol-base",
    holder: "teodor",
    units: 50_000,
    claim: 3_000,
    minFill: 1_500,
    maxPrice: 0.06,
    reserve: 0.035,
    bids: [
      { who: "varick", quantity: 2_000, price: 0.045 },
      { who: "ines", quantity: 2_000, price: 0.04 },
    ],
  },
} as const satisfies {
  tender: { cohort: CohortKey; budget: number; maxPrice: number; referencePrice: number; asks: readonly SealedOrder[] };
  exit: { cohort: CohortKey; creator: Who; maxPrice: number; asks: readonly SealedOrder[]; bids: readonly SealedOrder[]; malformed: SealedOrder & { escrow: number } };
  advance: { cohort: CohortKey; holder: Who; units: number; claim: number; minFill: number; maxPrice: number; reserve: number; bids: readonly SealedOrder[] };
};

export type RoundKey = keyof typeof ROUNDS;

/** Whole tUSDC (6 decimals) or a price in tUSDC as base units; exact for the values above. */
export function usdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

export function whole(amount: number, decimals: number): bigint {
  return BigInt(amount) * 10n ** BigInt(decimals);
}
