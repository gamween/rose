/**
 * The guided demo's data file (spec 9, "Watch a full round"): one manifest per engine, built from
 * the seed and live end-to-end journals that `scripts/seed.ts` and `scripts/e2e-live.ts` write
 * under `deployments/e2e/`, and committed under `apps/web/src/content/demo/<engine>.json` by
 * `scripts/demo-manifest.ts`. The manifest only carries what the chain views cannot return:
 * transaction hashes (the engine keeps no hashes), the cast's display names, which journal step
 * belongs to which round, and the checks the scripts ran off chain (offline key unwrap, the SDK
 * clearing reference, the private record of each sealed order). Everything else the walkthrough
 * shows is read live from the engine.
 *
 * This module has no imports so the Node script can load it with native type stripping.
 */

export const DEMO_MANIFEST_VERSION = 1;

export type DemoChain = "near" | "base" | "solana";
export type DemoRoundKind = "Tender" | "Exit" | "Advance";
export type DemoScenarioKey = "tender" | "exit" | "advance" | "no-key";
export type DemoStepId = "custody" | "deposit" | "cash" | "create" | "seal" | "close" | "open" | "clear" | "settle" | "payout" | "redeem" | "cancel";

export interface DemoTx {
  label: string;
  chain: DemoChain;
  hash: string;
  /** NEAR: gas burnt by the transaction and its receipts. */
  gasTgas: number | null;
  /** Base: gas used by the receipt. */
  gasUsed: string | null;
  /** A transaction that failed on purpose and is kept as evidence (a refused opening, a refused close). */
  failed: boolean;
  note: string | null;
}

export interface DemoStepData {
  id: DemoStepId;
  /** When the journal recorded the step (ISO 8601). */
  at: string;
  txs: DemoTx[];
}

export interface DemoOrder {
  bidId: number;
  account: string;
  side: "Buy" | "Sell";
  /** Public collateral: escrow in USDC base units for a buyer, locked units for a seller. */
  collateral: string;
  /** SHA-256 of the ciphertext as posted, recorded by the seed. */
  ciphertextSha256: string;
  /** Sealed on purpose with a ciphertext no key can open. */
  malformed: boolean;
}

export interface DemoOpening {
  bidId: number;
  /** The opened plaintext matched the bidder's private record of the order. */
  matchesSealed: boolean | null;
  /** Why the order could not be opened (the malformed one). */
  unopenable: string | null;
}

export interface DemoPosition {
  positionId: string;
  account: string;
  /** "Sablier stream #90" or "Streamflow stream BLvt…". */
  source: string;
}

export interface DemoScenario {
  key: DemoScenarioKey;
  kind: DemoRoundKind;
  roundId: string;
  classKey: string;
  creator: string;
  orders: DemoOrder[];
  positions: DemoPosition[];
  /** Close request to stored key, as measured by the script (the chain view gives the same span). */
  keyLatencyMs: number | null;
  /** The script unwrapped the public CKD response itself and got the stored key. */
  keyCheckedOffline: boolean | null;
  openings: DemoOpening[];
  /** The script's `@rose/sdk` clearing reference reproduced the engine's result. */
  clearingMatchesReference: boolean | null;
  steps: DemoStepData[];
}

export interface DemoPerson {
  account: string;
  name: string;
}

export interface DemoClass {
  key: string;
  classId: string;
  label: string;
  chain: "Base" | "Solana";
}

export interface DemoManifest {
  version: typeof DEMO_MANIFEST_VERSION;
  engine: string;
  /** Journal files the manifest was built from, relative to the repository root. */
  sources: string[];
  issuer: string;
  token: { name: string; symbol: string };
  people: DemoPerson[];
  classes: DemoClass[];
  scenarios: DemoScenario[];
}

/* Journals (`scripts/lib/journal.ts`): `{ header, steps: { <key>: { at, txs, data, done } } }`. */

export interface JournalTx {
  label: string;
  chain: string;
  hash: string;
  link?: string;
  gasTgas?: number;
  gasUsed?: string;
  failed?: boolean;
  note?: string;
}

export interface JournalEntry {
  at: string;
  txs: JournalTx[];
  data?: unknown;
  done: boolean;
}

export interface Journal {
  header: Record<string, unknown>;
  steps: Record<string, JournalEntry>;
}

export interface ManifestSources {
  /** `deployments/e2e/cindral.json`: the cast and the token, engine-independent. */
  cast: Journal;
  /** `deployments/e2e/<engine>.seed.json`. */
  seed: Journal;
  /** `deployments/e2e/<engine>.live.json`. */
  live: Journal;
  /** Paths recorded in the manifest. */
  paths: string[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/* Reading untyped JSON. */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ManifestError(`${where} is not a non-empty string`);
  return value;
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ManifestError(`${where} is not a number`);
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new ManifestError(`${where} is not a boolean`);
  return value;
}

function optionalBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function arr(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new ManifestError(`${where} is not an array`);
  return value;
}

function obj(value: unknown, where: string): Json {
  if (!isObject(value)) throw new ManifestError(`${where} is not an object`);
  return value;
}

function digits(value: unknown, where: string): string {
  const text = str(value, where);
  if (!/^\d+$/.test(text)) throw new ManifestError(`${where} is not an integer string`);
  return text;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new ManifestError(`${where} is not one of ${options.join(", ")}`);
  return value as T;
}

const CHAINS = ["near", "base", "solana"] as const;
const KINDS = ["Tender", "Exit", "Advance"] as const;
const SCENARIO_KEYS = ["tender", "exit", "advance", "no-key"] as const;
const STEP_IDS = ["custody", "deposit", "cash", "create", "seal", "close", "open", "clear", "settle", "payout", "redeem", "cancel"] as const;
const SIDES = ["Buy", "Sell"] as const;
const HASH_SHAPE: Record<DemoChain, RegExp> = {
  near: /^[1-9A-HJ-NP-Za-km-z]{43,44}$/,
  base: /^0x[0-9a-f]{64}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{86,88}$/,
};

function parseTx(raw: unknown, where: string): DemoTx {
  const tx = obj(raw, where);
  const chain = oneOf(tx.chain, CHAINS, `${where}.chain`);
  const hash = str(tx.hash, `${where}.hash`);
  if (!HASH_SHAPE[chain].test(hash)) throw new ManifestError(`${where}.hash is not a ${chain} transaction hash`);
  return {
    label: str(tx.label, `${where}.label`),
    chain,
    hash,
    gasTgas: tx.gasTgas === null ? null : num(tx.gasTgas, `${where}.gasTgas`),
    gasUsed: tx.gasUsed === null ? null : digits(tx.gasUsed, `${where}.gasUsed`),
    failed: bool(tx.failed, `${where}.failed`),
    note: tx.note === null ? null : str(tx.note, `${where}.note`),
  };
}

/** Validates a manifest file (the committed JSON is data, so the app checks it before use). */
export function parseDemoManifest(raw: unknown): DemoManifest {
  const root = obj(raw, "manifest");
  if (root.version !== DEMO_MANIFEST_VERSION) throw new ManifestError(`manifest.version must be ${String(DEMO_MANIFEST_VERSION)}`);
  const token = obj(root.token, "manifest.token");
  const people = arr(root.people, "manifest.people").map((entry, index) => {
    const person = obj(entry, `people[${String(index)}]`);
    return { account: str(person.account, `people[${String(index)}].account`), name: str(person.name, `people[${String(index)}].name`) };
  });
  const classes = arr(root.classes, "manifest.classes").map((entry, index) => {
    const where = `classes[${String(index)}]`;
    const cls = obj(entry, where);
    const classId = str(cls.classId, `${where}.classId`);
    if (!/^[0-9a-f]{64}$/.test(classId)) throw new ManifestError(`${where}.classId is not a class id`);
    return { key: str(cls.key, `${where}.key`), classId, label: str(cls.label, `${where}.label`), chain: oneOf(cls.chain, ["Base", "Solana"] as const, `${where}.chain`) };
  });
  const scenarios = arr(root.scenarios, "manifest.scenarios").map((entry, index) => {
    const where = `scenarios[${String(index)}]`;
    const scenario = obj(entry, where);
    const classKey = str(scenario.classKey, `${where}.classKey`);
    if (!classes.some((cls) => cls.key === classKey)) throw new ManifestError(`${where}.classKey names no class`);
    const steps = arr(scenario.steps, `${where}.steps`).map((rawStep, stepIndex) => {
      const stepWhere = `${where}.steps[${String(stepIndex)}]`;
      const step = obj(rawStep, stepWhere);
      return {
        id: oneOf(step.id, STEP_IDS, `${stepWhere}.id`),
        at: str(step.at, `${stepWhere}.at`),
        txs: arr(step.txs, `${stepWhere}.txs`).map((tx, txIndex) => parseTx(tx, `${stepWhere}.txs[${String(txIndex)}]`)),
      };
    });
    if (steps.length === 0) throw new ManifestError(`${where} has no step`);
    return {
      key: oneOf(scenario.key, SCENARIO_KEYS, `${where}.key`),
      kind: oneOf(scenario.kind, KINDS, `${where}.kind`),
      roundId: digits(scenario.roundId, `${where}.roundId`),
      classKey,
      creator: str(scenario.creator, `${where}.creator`),
      orders: arr(scenario.orders, `${where}.orders`).map((rawOrder, orderIndex) => {
        const orderWhere = `${where}.orders[${String(orderIndex)}]`;
        const order = obj(rawOrder, orderWhere);
        const hash = str(order.ciphertextSha256, `${orderWhere}.ciphertextSha256`);
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new ManifestError(`${orderWhere}.ciphertextSha256 is not a SHA-256`);
        return {
          bidId: num(order.bidId, `${orderWhere}.bidId`),
          account: str(order.account, `${orderWhere}.account`),
          side: oneOf(order.side, SIDES, `${orderWhere}.side`),
          collateral: digits(order.collateral, `${orderWhere}.collateral`),
          ciphertextSha256: hash,
          malformed: bool(order.malformed, `${orderWhere}.malformed`),
        };
      }),
      positions: arr(scenario.positions, `${where}.positions`).map((rawPosition, positionIndex) => {
        const positionWhere = `${where}.positions[${String(positionIndex)}]`;
        const position = obj(rawPosition, positionWhere);
        return { positionId: digits(position.positionId, `${positionWhere}.positionId`), account: str(position.account, `${positionWhere}.account`), source: str(position.source, `${positionWhere}.source`) };
      }),
      keyLatencyMs: scenario.keyLatencyMs === null ? null : num(scenario.keyLatencyMs, `${where}.keyLatencyMs`),
      keyCheckedOffline: scenario.keyCheckedOffline === null ? null : bool(scenario.keyCheckedOffline, `${where}.keyCheckedOffline`),
      openings: arr(scenario.openings, `${where}.openings`).map((rawOpening, openingIndex) => {
        const openingWhere = `${where}.openings[${String(openingIndex)}]`;
        const opening = obj(rawOpening, openingWhere);
        return {
          bidId: num(opening.bidId, `${openingWhere}.bidId`),
          matchesSealed: opening.matchesSealed === null ? null : bool(opening.matchesSealed, `${openingWhere}.matchesSealed`),
          unopenable: opening.unopenable === null ? null : str(opening.unopenable, `${openingWhere}.unopenable`),
        };
      }),
      clearingMatchesReference: scenario.clearingMatchesReference === null ? null : bool(scenario.clearingMatchesReference, `${where}.clearingMatchesReference`),
      steps,
    };
  });
  if (scenarios.length === 0) throw new ManifestError("manifest has no scenario");
  return {
    version: DEMO_MANIFEST_VERSION,
    engine: str(root.engine, "manifest.engine"),
    sources: arr(root.sources, "manifest.sources").map((source, index) => str(source, `sources[${String(index)}]`)),
    issuer: str(root.issuer, "manifest.issuer"),
    token: { name: str(token.name, "manifest.token.name"), symbol: str(token.symbol, "manifest.token.symbol") },
    people,
    classes,
    scenarios,
  };
}

/* Building from the journals. */

function entry(journal: Journal, key: string): JournalEntry | null {
  const found = journal.steps[key];
  return found?.done === true ? found : null;
}

function requireEntry(journal: Journal, key: string): JournalEntry {
  const found = entry(journal, key);
  if (!found) throw new ManifestError(`journal step ${key} is missing or unfinished`);
  return found;
}

function toTx(tx: JournalTx, where: string): DemoTx {
  return parseTx({ label: tx.label, chain: tx.chain, hash: tx.hash, gasTgas: tx.gasTgas ?? null, gasUsed: tx.gasUsed ?? null, failed: tx.failed ?? false, note: tx.note ?? null }, where);
}

function step(id: DemoStepId, entries: readonly (JournalEntry | null)[], filter: (tx: JournalTx) => boolean = () => true): DemoStepData | null {
  const present = entries.filter((item): item is JournalEntry => item !== null);
  const txs = present.flatMap((item) => item.txs.filter(filter).map((tx, index) => toTx(tx, `${id}.txs[${String(index)}]`)));
  if (txs.length === 0) return null;
  const at = present.map((item) => item.at).sort().at(-1) ?? "";
  return { id, at, txs };
}

/** `Cindral (CINDR)` → name and symbol. */
function parseToken(text: string): { name: string; symbol: string } {
  const match = /^(.+?)\s*\(([A-Z0-9]+)\)$/.exec(text.trim());
  if (!match?.[1] || !match[2]) throw new ManifestError(`cast header token "${text}" is not "Name (SYMBOL)"`);
  return { name: match[1], symbol: match[2] };
}

function castPeople(cast: Journal): DemoPerson[] {
  return Object.entries(cast.steps)
    .filter(([key, value]) => key.startsWith("near-account:") && value.done)
    .map(([key, value]) => {
      const data = obj(value.data, key);
      return { account: str(data.account, `${key}.account`), name: str(data.name, `${key}.name`) };
    });
}

/** The cast refers to people by the first word of their account (`halden` for `halden-ventures.…`). */
function shortKey(account: string): string {
  return account.split(/[-.]/)[0] ?? account;
}

function accountOf(people: readonly DemoPerson[], who: string): string {
  const person = people.find((candidate) => shortKey(candidate.account) === who);
  if (!person) throw new ManifestError(`nobody in the cast is "${who}"`);
  return person.account;
}

function nameOf(people: readonly DemoPerson[], account: string): string {
  return people.find((person) => person.account === account)?.name ?? account;
}

interface SeedClass {
  key: string;
  classId: string;
  label: string;
  chain: "Base" | "Solana";
}

function seedClasses(seed: Journal): SeedClass[] {
  const data = obj(requireEntry(seed, "classes").data, "classes");
  return Object.entries(data).map(([key, value]) => {
    const cls = obj(value, `classes.${key}`);
    return { key, classId: str(cls.class_id, `classes.${key}.class_id`), label: str(cls.label, `classes.${key}.label`), chain: oneOf(cls.chain, ["Base", "Solana"] as const, `classes.${key}.chain`) };
  });
}

function classById(classes: readonly SeedClass[], classId: string): SeedClass {
  const found = classes.find((cls) => cls.classId === classId);
  if (!found) throw new ManifestError(`class ${classId} is not in the seed's class list`);
  return found;
}

interface RoundRecord {
  roundId: string;
  kind: DemoRoundKind;
  classId: string;
  creator: string;
}

function roundRecord(data: unknown, where: string): RoundRecord {
  const round = obj(data, where);
  return { roundId: digits(round.roundId, `${where}.roundId`), kind: oneOf(round.kind, KINDS, `${where}.kind`), classId: str(round.classId, `${where}.classId`), creator: str(round.creator, `${where}.creator`) };
}

function orderRecords(data: unknown, where: string): DemoOrder[] {
  const list = Array.isArray(data) ? data : [data];
  return list.map((raw, index) => {
    const order = obj(raw, `${where}[${String(index)}]`);
    return {
      bidId: num(order.bidId, `${where}[${String(index)}].bidId`),
      account: str(order.bidder, `${where}[${String(index)}].bidder`),
      side: oneOf(order.side, SIDES, `${where}[${String(index)}].side`),
      collateral: digits(order.collateral, `${where}[${String(index)}].collateral`),
      ciphertextSha256: str(order.ciphertextSha256, `${where}[${String(index)}].ciphertextSha256`),
      malformed: bool(order.malformed, `${where}[${String(index)}].malformed`),
    };
  });
}

/**
 * The venue the seed created the round in, from the creation label it wrote
 * (`create_tender (Seed Round, Base tUSDC)`); the engine view of the round says the same.
 */
function venueOf(entryWithRound: JournalEntry): "near" | "base" {
  const label = entryWithRound.txs[0]?.label ?? "";
  if (/\bBase tUSDC\)/.test(label)) return "base";
  if (/\bNEAR tUSDC\)/.test(label)) return "near";
  throw new ManifestError(`cannot tell the venue from "${label}"`);
}

/** Whether a journal transaction label is about one of `accounts` (by account id or display name). */
function mentions(label: string, accounts: readonly string[], people: readonly DemoPerson[]): boolean {
  return accounts.some((account) => label.includes(account) || label.includes(nameOf(people, account)));
}

interface ClassCustody {
  custody: DemoStepData | null;
  deposit: DemoStepData | null;
  positions: DemoPosition[];
}

function baseCustody(seed: Journal, cls: SeedClass, people: readonly DemoPerson[]): ClassCustody {
  const register = requireEntry(seed, "base-register");
  const positions = arr(obj(register.data, "base-register").positions, "base-register.positions")
    .map((raw, index) => obj(raw, `base-register.positions[${String(index)}]`))
    .filter((position) => position.classId === cls.classId);
  const streams = new Set(positions.map((position) => str(position.streamId, "position.streamId")));
  const selfDeposits = Object.entries(seed.steps)
    .filter(([key, value]) => key.startsWith("base-self-deposit:") && value.done && streams.has(str(obj(value.data, key).streamId, `${key}.streamId`)))
    .map(([, value]) => value);
  return {
    custody: step("custody", [entry(seed, `base-cohort:${cls.key}`)]),
    deposit: step("deposit", [...selfDeposits, register], (tx) => {
      if (tx.label.startsWith("register_base_deposit")) {
        const stream = /\bstream (\d+)\b/.exec(tx.label)?.[1];
        return stream !== undefined && streams.has(stream);
      }
      return !tx.label.startsWith("register_base_cash");
    }),
    positions: positions.map((position) => ({
      positionId: digits(position.positionId, "position.positionId"),
      account: accountOf(people, str(position.who, "position.who")),
      source: `Sablier stream #${str(position.streamId, "position.streamId")}`,
    })),
  };
}

function solanaCustody(seed: Journal, cls: SeedClass, people: readonly DemoPerson[]): ClassCustody {
  const deposits = Object.entries(seed.steps).filter(([key, value]) => key.startsWith("sol-deposit:") && value.done && obj(value.data, key).classId === cls.classId);
  const who = deposits.map(([key]) => key.slice("sol-deposit:".length));
  return {
    custody: step("custody", who.map((name) => entry(seed, `sol-stream:${name}`))),
    deposit: step("deposit", deposits.map(([, value]) => value)),
    positions: deposits.map(([key, value]) => {
      const data = obj(value.data, key);
      const metadata = str(data.metadata, `${key}.metadata`);
      return { positionId: digits(data.positionId, `${key}.positionId`), account: accountOf(people, key.slice("sol-deposit:".length)), source: `Streamflow stream ${metadata.slice(0, 4)}…${metadata.slice(-4)}` };
    }),
  };
}

function cashStep(seed: Journal, venue: "near" | "base", participants: readonly string[], people: readonly DemoPerson[]): DemoStepData | null {
  if (venue === "near") return step("cash", [entry(seed, "near-cash")], (tx) => mentions(tx.label, participants, people));
  return step("cash", [entry(seed, "base-cash"), entry(seed, "base-register")], (tx) => {
    if (tx.label.startsWith("register_base_deposit")) return false;
    return mentions(tx.label, participants, people);
  });
}

/** Payout steps of `scripts/e2e-live.ts` and the round kind each one pays out of. */
const PAYOUT_OF: Record<string, DemoRoundKind> = { "payout:base-cash": "Tender", "payout:near-cash": "Exit", "payout:lien": "Advance" };

function payoutStep(live: Journal, kind: DemoRoundKind): DemoStepData | null {
  const keys = Object.entries(PAYOUT_OF)
    .filter(([, of]) => of === kind)
    .map(([key]) => key);
  return step("payout", keys.map((key) => entry(live, key)));
}

/** `payout:redeem` releases one position; it belongs to the scenario whose class holds it. */
function redeemStep(live: Journal, positions: readonly DemoPosition[]): DemoStepData | null {
  const redeem = entry(live, "payout:redeem");
  if (!redeem) return null;
  const positionId = digits(obj(redeem.data, "payout:redeem").position_id, "payout:redeem.position_id");
  return positions.some((position) => position.positionId === positionId) ? step("redeem", [redeem]) : null;
}

function present(steps: readonly (DemoStepData | null)[]): DemoStepData[] {
  return steps.filter((item): item is DemoStepData => item !== null);
}

const ROUND_SCENARIOS: readonly { key: Exclude<DemoScenarioKey, "no-key">; slug: string }[] = [
  { key: "tender", slug: "tender" },
  { key: "exit", slug: "exit" },
  { key: "advance", slug: "advance" },
];

function roundScenario(sources: ManifestSources, classes: readonly SeedClass[], people: readonly DemoPerson[], slug: string, key: DemoScenarioKey): DemoScenario | null {
  const { seed, live } = sources;
  const created = entry(seed, `round:${slug}`);
  const settled = entry(live, `settle:${slug}`);
  if (!created || !settled) return null;
  const round = roundRecord(created.data, `round:${slug}`);
  const cls = classById(classes, round.classId);
  const orders = orderRecords(requireEntry(seed, `orders:${slug}`).data, `orders:${slug}`);
  const venue = venueOf(created);
  const custody = cls.chain === "Base" ? baseCustody(seed, cls, people) : solanaCustody(seed, cls, people);
  const participants = [...new Set([round.creator, ...orders.map((order) => order.account)])];
  const close = entry(live, `close:${slug}`);
  const closeData = close && isObject(close.data) ? close.data : null;
  const open = entry(live, `open:${slug}`);
  const clear = entry(live, `clear:${slug}`);
  return {
    key,
    kind: round.kind,
    roundId: round.roundId,
    classKey: cls.key,
    creator: round.creator,
    orders,
    positions: custody.positions,
    keyLatencyMs: closeData && typeof closeData.latency_ms === "number" ? closeData.latency_ms : null,
    keyCheckedOffline: closeData ? optionalBool(closeData.unwrapped_offline_equal) : null,
    openings: open
      ? arr(open.data, `open:${slug}`).map((raw, index) => {
          const opening = obj(raw, `open:${slug}[${String(index)}]`);
          return { bidId: num(opening.bidId, `open:${slug}[${String(index)}].bidId`), matchesSealed: optionalBool(opening.matchesSealed), unopenable: optionalStr(opening.unopenable) };
        })
      : [],
    clearingMatchesReference: clear && isObject(clear.data) ? optionalBool(clear.data.matches) : null,
    steps: present([
      custody.custody,
      custody.deposit,
      cashStep(seed, venue, participants, people),
      step("create", [created]),
      step("seal", [requireEntry(seed, `orders:${slug}`)]),
      step("close", [close]),
      step("open", [open]),
      step("clear", [clear]),
      step("settle", [settled]),
      payoutStep(live, round.kind),
      redeemStep(live, custody.positions),
    ]),
  };
}

/** The round nobody closed (`e2e-live.ts cancel-no-key`): created, one bid, close refused, `cancel_no_key`, refund. */
function noKeyScenario(live: Journal, classes: readonly SeedClass[]): DemoScenario | null {
  const created = entry(live, "nokey:create");
  const settled = entry(live, "nokey:settle");
  if (!created || !settled) return null;
  const round = roundRecord(created.data, "nokey:create");
  const bid = requireEntry(live, "nokey:bid");
  return {
    key: "no-key",
    kind: round.kind,
    roundId: round.roundId,
    classKey: classById(classes, round.classId).key,
    creator: round.creator,
    orders: orderRecords(bid.data, "nokey:bid"),
    positions: [],
    keyLatencyMs: null,
    keyCheckedOffline: null,
    openings: [],
    clearingMatchesReference: null,
    steps: present([step("create", [created]), step("seal", [bid]), step("cancel", [entry(live, "nokey:close-refused"), entry(live, "nokey:cancel")]), step("settle", [settled])]),
  };
}

/**
 * Builds the manifest of one engine from its journals. Only rounds that reached settlement (or,
 * for the no-key round, its refund) become scenarios; a step the journals never recorded is left
 * out rather than shown empty.
 */
export function buildDemoManifest(sources: ManifestSources): DemoManifest {
  const engine = str(sources.seed.header.engine, "seed header engine");
  if (sources.live.header.engine !== engine) throw new ManifestError(`the live journal is for ${String(sources.live.header.engine)}, the seed journal for ${engine}`);
  const people = castPeople(sources.cast);
  const issuer = str(sources.cast.header.issuer, "cast header issuer");
  const token = parseToken(str(sources.cast.header.token, "cast header token"));
  const classes = seedClasses(sources.seed);
  const scenarios = [
    ...ROUND_SCENARIOS.map(({ key, slug }) => roundScenario(sources, classes, people, slug, key)),
    noKeyScenario(sources.live, classes),
  ].filter((scenario): scenario is DemoScenario => scenario !== null);
  if (scenarios.length === 0) throw new ManifestError(`no seeded round of ${engine} reached settlement: run scripts/e2e-live.ts first`);
  const used = new Set(scenarios.map((scenario) => scenario.classKey));
  return parseDemoManifest({
    version: DEMO_MANIFEST_VERSION,
    engine,
    sources: sources.paths,
    issuer,
    token,
    people,
    classes: classes.filter((cls) => used.has(cls.key)),
    scenarios,
  });
}
