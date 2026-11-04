/**
 * Resumable step journal. Each named step runs once: its result and every transaction it sent
 * are written to a JSON file as soon as they exist, so a run that stopped half way resumes where
 * it stopped and never repeats a finished step. The public journal lives under
 * `deployments/e2e/` (hashes, links, gas: no secrets); a private one (sealed orders before they
 * are opened) lives under `~/.config/rose` with mode 600.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { baseTxUrl, solanaTxUrl } from "@rose/sdk";
import { log, nearTxUrl } from "./env.ts";

export type Chain = "near" | "base" | "solana";

/** One transaction of a step, with its explorer link. */
export interface TxRef {
  label: string;
  chain: Chain;
  hash: string;
  link: string;
  /** NEAR: gas burnt by the transaction and all its receipts. */
  gasTgas?: number;
  /** Base: gas used by the receipt. */
  gasUsed?: string;
  /** True for a transaction expected to fail (kept as evidence). */
  failed?: boolean;
  note?: string;
}

export function txRef(label: string, chain: Chain, hash: string, extra: Partial<Omit<TxRef, "label" | "chain" | "hash" | "link">> = {}): TxRef {
  const link = chain === "near" ? nearTxUrl(hash) : chain === "base" ? baseTxUrl(hash) : solanaTxUrl(hash);
  return { label, chain, hash, link, ...extra };
}

interface Entry {
  at: string;
  txs: TxRef[];
  data?: unknown;
  done: boolean;
}

interface JournalFile {
  header: Record<string, unknown>;
  steps: Record<string, Entry>;
}

/** What a running step can do: record a transaction now, and find one an earlier attempt sent. */
export interface StepScope {
  tx(ref: TxRef): void;
  sent(label: string): TxRef | undefined;
}

export class Journal {
  private readonly file: JournalFile;
  private readonly path: string;
  private readonly mode: number;

  constructor(path: string, header: Record<string, unknown>, mode = 0o644) {
    this.path = path;
    this.mode = mode;
    this.file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as JournalFile) : { header, steps: {} };
    this.file.header = { ...header, ...this.file.header };
    this.save();
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.file, null, 2)}\n`, { mode: this.mode });
  }

  done(key: string): boolean {
    return this.file.steps[key]?.done === true;
  }

  /** The stored result of a finished step (JSON: the caller names the shape it stored). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of stored JSON
  get<T>(key: string): T {
    const entry = this.file.steps[key];
    if (entry?.done !== true) throw new Error(`step ${key} has not run yet`);
    return entry.data as T;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of stored JSON
  find<T>(key: string): T | undefined {
    const entry = this.file.steps[key];
    return entry?.done === true ? (entry.data as T) : undefined;
  }

  /** Every transaction recorded so far, in step order. */
  transactions(): { step: string; tx: TxRef }[] {
    return Object.entries(this.file.steps).flatMap(([step, entry]) => entry.txs.map((tx) => ({ step, tx })));
  }

  keys(): string[] {
    return Object.keys(this.file.steps);
  }

  /** Runs `body` once per key; later calls return the stored result. */
  async step<T>(key: string, body: (scope: StepScope) => Promise<T>): Promise<T> {
    const existing = this.file.steps[key];
    if (existing?.done === true) return existing.data as T;
    const entry: Entry = existing ?? { at: new Date().toISOString(), txs: [], done: false };
    this.file.steps[key] = entry;
    const scope: StepScope = {
      tx: (ref) => {
        const known = entry.txs.some((t) => t.label === ref.label && t.hash === ref.hash);
        entry.txs = [...entry.txs.filter((t) => t.label !== ref.label), ref];
        this.save();
        if (!known) log(`  ${ref.label}: ${ref.link}${ref.gasTgas === undefined ? "" : ` (${ref.gasTgas} Tgas)`}${ref.failed === true ? " [failed as expected]" : ""}`);
      },
      sent: (label) => entry.txs.find((t) => t.label === label),
    };
    log(`- ${key}`);
    const data = await body(scope);
    entry.data = data;
    entry.done = true;
    entry.at = new Date().toISOString();
    this.save();
    return data;
  }

  /** Stores a value outside any step (for example derived addresses). */
  put(key: string, data: unknown): void {
    this.file.steps[key] = { at: new Date().toISOString(), txs: this.file.steps[key]?.txs ?? [], data, done: true };
    this.save();
  }
}
