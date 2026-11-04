/**
 * The step model of the guided demo: turns one manifest scenario into the ordered steps the
 * player walks through, each with a title, what happened in plain words, its transactions, the
 * engine events that prove it, the live panel to show and how long autoplay stays on it. Pure and
 * unit-tested; the player only renders it.
 */

import type { DemoManifest, DemoScenario, DemoScenarioKey, DemoStepId, DemoTx } from "./manifest";

export type WalkStepId = DemoStepId | "verify";

/** Engine event names (`get_events`) that record each step on chain. */
const STEP_EVENTS: Record<WalkStepId, readonly string[]> = {
  custody: [],
  deposit: ["deposit_registered", "sol_deposit_attributed"],
  cash: ["cash_deposited", "base_cash_registered"],
  create: ["round_created"],
  seal: ["bid_placed"],
  close: ["key_requested", "key_received"],
  open: ["bid_opened"],
  clear: ["round_cleared", "lien_created"],
  verify: [],
  settle: ["bid_settled"],
  payout: ["cash_withdrawn", "payout_requested", "payout_signed", "claimable_taken"],
  redeem: ["position_release_requested", "position_released", "units_burned"],
  cancel: ["round_cancelled"],
};

export interface WalkStep {
  id: WalkStepId;
  title: string;
  /** What happened, in plain words. */
  body: string;
  txs: DemoTx[];
  /** When the journal recorded the step (ISO 8601), null for steps computed in the browser. */
  at: string | null;
  /** Round events (by name) that show this step in the engine's own history. */
  events: readonly string[];
  /** How long autoplay stays on the step. */
  durationMs: number;
}

export const SCENARIO_LABEL: Record<DemoScenarioKey, string> = {
  tender: "Tender",
  exit: "Exit",
  advance: "Advance",
  "no-key": "No key",
};

interface Context {
  manifest: DemoManifest;
  scenario: DemoScenario;
  name: (account: string) => string;
  classLabel: string;
  chain: "Base" | "Solana";
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The cast member a journal label is about (`Halden Ventures: withdraw_base_cash …`). */
function actorOf(manifest: DemoManifest, txs: readonly DemoTx[]): string | null {
  for (const tx of txs) {
    const person = manifest.people.find((candidate) => tx.label.includes(candidate.name) || tx.label.includes(candidate.account));
    if (person) return person.name;
  }
  return null;
}

function title(id: WalkStepId, ctx: Context): string {
  const { scenario } = ctx;
  switch (id) {
    case "custody":
      return ctx.chain === "Base" ? "The issuer creates the cohort in custody" : "The issuer creates the vesting streams";
    case "deposit":
      return "Holders deposit, proven by ForeignTx";
    case "cash":
      return scenario.kind === "Tender" ? "The issuer funds the budget" : "Participants fund escrows and bonds";
    case "create":
      return scenario.kind === "Tender" ? "The issuer launches the Tender" : scenario.kind === "Advance" ? "The holder opens an Advance" : "Anyone opens an Exit round";
    case "seal":
      return "Sealed orders: only ciphertext on chain";
    case "close":
      return "Close: the MPC releases the round key";
    case "open":
      return "Every order opened and verified on chain";
    case "clear":
      return "Clearing: one uniform price";
    case "verify":
      return "Verify: the browser recomputes the result";
    case "settle":
      return scenario.key === "no-key" ? "Everything is refunded" : "Settlement, order by order";
    case "payout":
      return scenario.kind === "Advance" ? "The lien is repaid from unlocks" : "Payout on the venue's chain";
    case "redeem":
      return "A holder redeems in kind";
    case "cancel":
      return "No key: the round is cancelled";
  }
}

function body(id: WalkStepId, ctx: Context, txs: readonly DemoTx[]): string {
  const { manifest, scenario, name, classLabel } = ctx;
  const issuer = manifest.issuer;
  const holders = list([...new Set(scenario.positions.map((position) => name(position.account)))]);
  const malformed = scenario.orders.filter((order) => order.malformed);
  const asks = scenario.orders.filter((order) => order.side === "Sell").length;
  const bids = scenario.orders.length - asks;
  switch (id) {
    case "custody":
      return ctx.chain === "Base"
        ? `${issuer} creates the ${classLabel} streams straight into rose's custody: one createStreams transaction on Base Sepolia deposits a non-cancelable Sablier Lockup stream per holder into RoseVault, the vault the engine controls through NEAR Chain Signatures.`
        : `${issuer} creates the ${classLabel} on Solana devnet: one non-cancelable Streamflow stream of ${manifest.token.symbol} per holder. The holders own them; rose holds nothing yet.`;
    case "deposit":
      return ctx.chain === "Base"
        ? `Each stream is registered on NEAR for ${holders}. The engine trusts no caller: it asks the NEAR MPC network (ForeignTx) to attest the RoseVault log on Base Sepolia and mints units only from the attested fields: as many units as the stream's allocation in base units.`
        : `${holders} hand their streams to an engine-derived deposit address (transfer_recipient). The engine proves it on Solana with ForeignTx (attribute_sol_deposit), signs the move into its vault with Chain Signatures and broadcasts it, then proves the vault holds the stream before minting units (register_sol_deposit).`;
    case "cash":
      return scenario.kind === "Tender"
        ? `Rounds settle in one cash venue. ${name(scenario.creator)} escrows the public budget plus the 30 bps fee as tUSDC in RoseVault on Base Sepolia, and the sellers post their bonds there; each deposit is attested on NEAR (register_base_cash).`
        : `This round settles in tUSDC on NEAR. Buyers escrow their budgets and every participant funds a bond, sent to the engine with ft_transfer_call.`;
    case "create":
      if (scenario.kind === "Tender") return `${name(scenario.creator)} launches a Tender on the ${classLabel}: a public budget and a public max price per locked token. Any holder of the class may answer with a sealed ask until the round closes.`;
      if (scenario.kind === "Advance") return `${name(scenario.creator)} encumbers units of the ${classLabel} and offers funders a senior claim on the first tokens they unlock. No oracle, no liquidation: the claim is repaid from unlocks.`;
      return `${name(scenario.creator)} opens an Exit round on the ${classLabel}; create_exit is open to anyone. Holders sell together and buyers bid, all sealed, at one uniform price.`;
    case "seal":
      return `${plural(scenario.orders.length, "sealed order", "sealed orders")} (${plural(asks, "ask", "asks")}, ${plural(bids, "bid", "bids")}). Each was encrypted on the participant's side, with the same rose-ibe wasm the app runs in your browser, to this round's identity, then posted with its public collateral and bond. On chain there is only a ciphertext: no price and no exact quantity until the key exists.${malformed.length > 0 ? ` ${list(malformed.map((order) => name(order.account)))} posted a deliberately malformed ciphertext that no key can open.` : ""}`;
    case "close": {
      const latency = scenario.keyLatencyMs !== null ? ` The key arrived by callback ${(scenario.keyLatencyMs / 1000).toFixed(1)} s later` : " The key arrived by callback";
      return `After the deadline anyone can call close: the engine asks the NEAR MPC network for the round's key (confidential key derivation).${latency} and was checked on chain with a pairing before it was stored.${scenario.keyCheckedOffline ? " The seed script also unwrapped the public MPC response itself and got the same key." : ""}`;
    }
    case "open":
      return `With the key public, anyone can open every order. Each opening is one transaction that the contract fully verifies (about 132 Tgas): no keeper and no challenge window.${malformed.length > 0 ? ` The malformed bid opens for nobody, its author included: ${name(malformed[0]?.account ?? "")}'s own opening was refused on chain.` : ""}`;
    case "clear":
      return `clear computes the clearing price and every fill in one bounded transaction. Every filled ${scenario.kind === "Tender" ? "seller" : "order"} trades at the same price; orders nobody opened are void.`;
    case "verify":
      return "This browser recomputes the clearing price and every fill from the opened orders with the same integer rules as the contract (the @rose/sdk reference), and compares them with what the engine stored.";
    case "settle":
      if (scenario.key === "no-key") return "settle_bid returns the escrow and the bond in full. Funds never moved anywhere else.";
      return `settle_bid applies one order at a time and anyone can call it: cash to sellers, ${scenario.kind === "Advance" ? "lien shares" : "units"} to buyers, refunds of unused escrow and fee, and bond refunds.${malformed.length > 0 ? " The unopened bid is void and its bond is slashed to the treasury." : ""}`;
    case "payout": {
      const actor = actorOf(manifest, txs) ?? "The seller";
      if (scenario.kind === "Advance") return `Sablier releases unlocked ${manifest.token.symbol} into RoseVault, ${actor} claims its lien share on NEAR (claim_base_tokens), and the transfer the engine signed with Chain Signatures pays it on Base Sepolia.`;
      if (txs.some((tx) => tx.chain === "base")) return `${actor} withdraws the proceeds on Base: the engine signs a RoseVault transfer with Chain Signatures, and the signed transfer is submitted on Base Sepolia (executeTransfer).`;
      const cash = `${actor} withdraws the proceeds from the engine as tUSDC on NEAR (withdraw_near_cash).`;
      if (!txs.some((tx) => tx.chain === "solana")) return cash;
      return `${cash} Tokens unlocked on Solana are paid out in two phases: claim_sol_tokens has the engine sign a durable-nonce transfer with Chain Signatures, the holder broadcasts it, and confirm_sol_payout proves through ForeignTx that the nonce advanced. A Solana redeem works the same way (redeem, broadcast, confirm_sol_redeem). Those transactions come from a separate holder run on the same engine.`;
    }
    case "redeem": {
      const actor = actorOf(manifest, txs) ?? "A holder";
      return `${actor} leaves custody: redeem burns the position's units on NEAR, the engine signs the release, and executeRelease hands the Sablier stream back to the holder's wallet on Base Sepolia.`;
    }
    case "cancel":
      return "Nobody closed this round before its key timeout. close is now refused on chain, and anyone can call cancel_no_key: the round is cancelled, nothing can ever be opened or cleared, and every escrow is refundable.";
  }
}

function duration(id: WalkStepId, txs: number): number {
  if (id === "clear") return 12_000;
  if (id === "verify") return 9_000;
  return Math.min(15_000, 7_000 + Math.min(txs, 8) * 1_000);
}

/** The ordered steps of one scenario; Verify follows the clearing it checks. */
export function walkthrough(manifest: DemoManifest, scenario: DemoScenario): WalkStep[] {
  const cls = manifest.classes.find((candidate) => candidate.key === scenario.classKey);
  const people = new Map(manifest.people.map((person) => [person.account, person.name]));
  const ctx: Context = {
    manifest,
    scenario,
    name: (account) => people.get(account) ?? account,
    classLabel: cls?.label ?? scenario.classKey,
    chain: cls?.chain ?? "Base",
  };
  const out: WalkStep[] = [];
  for (const data of scenario.steps) {
    out.push({ id: data.id, title: title(data.id, ctx), body: body(data.id, ctx, data.txs), txs: data.txs, at: data.at, events: STEP_EVENTS[data.id], durationMs: duration(data.id, data.txs.length) });
    if (data.id === "clear") out.push({ id: "verify", title: title("verify", ctx), body: body("verify", ctx, []), txs: [], at: null, events: [], durationMs: duration("verify", 0) });
  }
  return out;
}

export function clampStep(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}

/** `?round=` value: a scenario key or a round id; the first scenario otherwise. */
export function scenarioFromQuery(manifest: DemoManifest, value: string | null): DemoScenario {
  const first = manifest.scenarios[0];
  if (!first) throw new Error("A demo manifest always has a scenario.");
  if (!value) return first;
  return manifest.scenarios.find((scenario) => scenario.key === value || scenario.roundId === value) ?? first;
}

/** `?step=` value: a step id (`clear`) or a 1-based position; the first step otherwise. */
export function stepFromQuery(steps: readonly WalkStep[], value: string | null): number {
  if (!value) return 0;
  const byId = steps.findIndex((step) => step.id === value);
  if (byId >= 0) return byId;
  return /^\d+$/.test(value) ? clampStep(Number(value) - 1, steps.length) : 0;
}

export type KeyCommand = "next" | "prev" | "first" | "last" | "toggle";

/** Keyboard shortcuts of the player. */
export function keyCommand(key: string): KeyCommand | null {
  switch (key) {
    case "ArrowRight":
    case "PageDown":
    case "j":
      return "next";
    case "ArrowLeft":
    case "PageUp":
    case "k":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case " ":
    case "p":
      return "toggle";
    default:
      return null;
  }
}

/** Total autoplay time of a scenario. */
export function totalDuration(steps: readonly WalkStep[]): number {
  return steps.reduce((sum, step) => sum + step.durationMs, 0);
}
