/**
 * Solana reads of the deposit wizard: the holder's Streamflow streams with their mint accounts,
 * the exact bytes the engine proves (metadata at `finalized`, 82-byte mint), the per-holder
 * deposit address derived by the MPC, and the progress polls of a deposit through its stages.
 */

import {
  bytesToHex,
  decodeStreamflowMetadata,
  listStreamflowStreamsForRecipient,
  readStreamflowStream,
  TOKEN_PROGRAM_ID,
  type EngineViews,
  type SolDepositStageView,
  type SolDepositView,
  type StreamflowMetadata,
} from "@rose/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import { ed25519KeyToSolanaAddress, mpcDerivedPublicKey } from "@/lib/engine-client";
import { RoseActionError } from "@/lib/errors";
import { mintDecimals, SPL_MINT_ACCOUNT_LEN, solanaVerdict, streamflowScheduleArgs, type Verdict } from "./eligibility";

export type MintAccount = { owner: PublicKey; data: Uint8Array; decimals: number };

/** Reads a classic SPL mint account (`finalized`); null when it does not exist or is not 82 bytes. */
export async function readMintAccount(connection: Connection, mint: PublicKey): Promise<MintAccount | null> {
  const info = await connection.getAccountInfo(mint, "finalized");
  if (!info || info.data.length !== SPL_MINT_ACCOUNT_LEN) return null;
  const data = Uint8Array.from(info.data);
  return { owner: info.owner, data, decimals: mintDecimals(data) };
}

export type SolanaStreamRow = {
  metadataPubkey: string;
  metadata: StreamflowMetadata;
  mint: MintAccount | null;
  verdict: Verdict;
  classId: string | null;
  classExists: boolean | null;
};

/** The wallet's Streamflow streams with eligibility and the class each would join. */
export async function listSolanaStreams(connection: Connection, views: EngineViews, recipient: PublicKey, signal?: AbortSignal): Promise<SolanaStreamRow[]> {
  const listing = await listStreamflowStreamsForRecipient(connection, recipient);
  const mints = new Map<string, MintAccount | null>();
  const rows: SolanaStreamRow[] = [];
  for (const entry of listing) {
    const mintKey = entry.metadata.mint.toBase58();
    if (!mints.has(mintKey)) mints.set(mintKey, await readMintAccount(connection, entry.metadata.mint));
    const mint = mints.get(mintKey) ?? null;
    const verdict = solanaVerdict(entry.metadata, mint?.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : (mint?.owner ?? null));
    let classId: string | null = null;
    let classExists: boolean | null = null;
    if (verdict.eligible && mint) {
      try {
        classId = await views.raw.computeSolClassId(mintKey, mint.decimals, streamflowScheduleArgs(entry.metadata), { signal });
        classExists = (await views.raw.getClass(classId, { signal })) !== null;
      } catch (error) {
        verdict.eligible = false;
        verdict.reasons.push(error instanceof Error ? `The engine refuses this schedule: ${error.message.slice(0, 160)}` : "The engine refuses this schedule.");
      }
    }
    rows.push({ metadataPubkey: entry.metadataPubkey.toBase58(), metadata: entry.metadata, mint, verdict, classId, classExists });
  }
  return rows.sort((a, b) => Number(b.metadata.createdAt - a.metadata.createdAt));
}

/** The exact metadata bytes as hex, read at `finalized` right before an engine call (spec 7.2). */
export async function readMetadataHex(connection: Connection, metadata: PublicKey): Promise<{ hex: string; decoded: StreamflowMetadata; slot: number }> {
  const state = await readStreamflowStream(connection, metadata, "finalized");
  return { hex: bytesToHex(state.raw), decoded: decodeStreamflowMetadata(state.raw), slot: state.slot };
}

/** `dep/<account>/<class>` derived by the MPC (Ed25519 domain) through the engine's `deposit_path_of`. */
export async function depositAddressFor(views: EngineViews, engineAccount: string, nearAccount: string, classId: string, signal?: AbortSignal): Promise<{ path: string; address: string }> {
  const [path, config] = await Promise.all([views.raw.depositPathOf(nearAccount, classId, { signal }), views.getConfig({ signal })]);
  const key = await mpcDerivedPublicKey(path, engineAccount, config.sign_ed25519_domain, signal);
  return { path, address: ed25519KeyToSolanaAddress(key) };
}

export type StageName = "Attributed" | "MoveSigned" | "Registered" | "Refused";

export function stageName(stage: SolDepositStageView): StageName {
  if (typeof stage === "string") return stage;
  return "MoveSigned" in stage ? "MoveSigned" : "Registered";
}

const STAGE_WAIT_MS = 150_000;
const STAGE_POLL_MS = 3_000;

/**
 * Polls `get_sol_deposit` until the deposit reaches one of `expected` (or `Refused`). The MPC
 * answers a proof in about 7 s; one that never answers surfaces after about 2 min, so the
 * wait gives up a little later with a retryable error.
 */
export async function waitForStage(views: EngineViews, metadata: string, expected: StageName[], options: { signal?: AbortSignal; onPoll?: (elapsedMs: number) => void } = {}): Promise<SolDepositView> {
  const started = Date.now();
  for (;;) {
    const deposit = await views.raw.getSolDeposit(metadata, { signal: options.signal });
    if (deposit) {
      const stage = stageName(deposit.stage);
      if (stage === "Refused" || expected.includes(stage)) return deposit;
    }
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed);
    if (elapsed > STAGE_WAIT_MS) {
      throw new RoseActionError("mpc_timeout", "MPC verification timed out", "The engine has not recorded the proof after 2.5 minutes: the stream may have changed in flight or the MPC nodes lag. Retry: the step re-reads the account and re-sends the proof.", true);
    }
    await sleep(STAGE_POLL_MS, options.signal);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
