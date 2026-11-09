/**
 * Short definitions of the words the app uses, shown in place (`Term`) with a link to the full
 * entry of the docs glossary. Each `entry` is the bold lead of a paragraph of
 * `content/docs/glossary.md`; the docs give that paragraph the id `glossaryAnchor(entry)`.
 */

import { ROUTES } from "./routes";

export const GLOSSARY = {
  advance: { entry: "Advance", short: "A holder sells a senior claim on the first tokens that will unlock from some of their units. Funders bid sealed; winners get lien shares." },
  ask: { entry: "Ask", short: "A sealed sell order: a minimum price per locked token and a quantity of units, locked in the round." },
  bid: { entry: "Bid", short: "A sealed buy order: a limit price and a quantity, backed by a public cash escrow." },
  bond: { entry: "Bond", short: "A small deposit posted with every order, refunded when the order opens validly and slashed when it is void." },
  cashVenue: { entry: "Cash venue", short: "Where a round's cash lives: tUSDC on NEAR, or a Base token held by RoseVault. One venue per round." },
  class: { entry: "Class", short: "Positions that are economically identical (same chain, token and unlock schedule). Units of a class are interchangeable." },
  clearingPrice: { entry: "Clearing price", short: "The single price per locked token at which every fill of a round settles, computed on chain after the bids open." },
  escrow: { entry: "Escrow", short: "The public cash a buyer locks with a bid. It shows the most the bid can spend, not its price." },
  exit: { entry: "Exit", short: "A round where holders sell and buyers bid, all sealed, cleared at one price that trades the most volume." },
  keyTimeout: { entry: "Key timeout", short: "How long the round key may take to arrive after the close before anyone can cancel the round." },
  lien: { entry: "Lien, lien share", short: "The senior claim an Advance creates. Unlocks of the pledged units flow to lien holders until the claim is paid." },
  lockedFraction: { entry: "Locked fraction", short: "The share of each unit still locked at the close: the conversion between a price per locked token and a price per unit." },
  maxPrice: { entry: "Max price", short: "The public price ceiling of a round. Orders priced above it take no part in the clearing." },
  opening: { entry: "Opening", short: "Decrypting a sealed order once the round key is public. Anyone can submit it; the contract verifies it." },
  position: { entry: "Position", short: "One locked allocation (a Sablier or Streamflow stream) held by rose's vault on its own chain." },
  revealWindow: { entry: "Reveal window", short: "The time after the key arrives during which sealed orders can be opened." },
  round: { entry: "Round", short: "A sealed auction over the units of one class: Tender, Exit or Advance." },
  sealedBook: { entry: "Sealed book", short: "What everyone sees before the close: how many orders, their public collateral and ciphertext hashes. Never a price." },
  tender: { entry: "Tender", short: "An issuer buys back units with a public budget and max price; holders answer with sealed asks." },
  uniformPrice: { entry: "Uniform price", short: "Every winning order trades at the same clearing price, whatever it bid." },
  unit: { entry: "Unit", short: "A claim on one base unit of a class's token under its unlock schedule. Depositing a position mints its allocation in units." },
} as const satisfies Record<string, { entry: string; short: string }>;

export type GlossaryTerm = keyof typeof GLOSSARY;

/** The id of a glossary paragraph: its lead term in lowercase, up to the first period, comma or parenthesis. */
export function glossaryAnchor(entry: string): string {
  const head = entry.split(/[.,(]/, 1)[0] ?? entry;
  return `term-${head.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function glossaryHref(term: GlossaryTerm): string {
  return `${ROUTES.docs}/glossary#${glossaryAnchor(GLOSSARY[term].entry)}`;
}
