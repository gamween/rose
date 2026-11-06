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
  type EngineViews,
  type SolDepositStageView,
  type SolDepositView,
  type StreamflowMetadata,
} from "@rose/sdk";
import { PublicKey, type Connection } from "@solana/web3.js";
import { ed25519KeyToSolanaAddress, mpcDerivedPublicKey } from "@/lib/engine-client";
import { RoseActionError } from "@/lib/errors";
import { sleep } from "@/lib/payouts";
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

/** The wallet's Streamflow streams with eligibility (valued at `nowSec`, the NEAR block time the engine checks against) and the class each would join. */
export async function listSolanaStreams(connection: Connection, views: EngineViews, recipient: PublicKey, nowSec: bigint, signal?: AbortSignal): Promise<SolanaStreamRow[]> {
  const listing = await listStreamflowStreamsForRecipient(connection, recipient);
  const mints = new Map<string, MintAccount | null>();
  const rows: SolanaStreamRow[] = [];
  for (const entry of listing) {
    const mintKey = entry.metadata.mint.toBase58();
    if (!mints.has(mintKey)) mints.set(mintKey, await readMintAccount(connection, entry.metadata.mint));
    const mint = mints.get(mintKey) ?? null;
    const verdict = solanaVerdict(entry.metadata, mint, entry.raw, nowSec);
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

/**
 * One stream as a deposit row, read again from the chain: what an interrupted deposit resumes
 * from once the stream has left the wallet (its class was recorded when the deposit started).
 */
export async function readSolanaStreamRow(connection: Connection, metadata: PublicKey, classId: string): Promise<SolanaStreamRow & { mint: MintAccount }> {
  const state = await readStreamflowStream(connection, metadata, "confirmed");
  const mint = await readMintAccount(connection, state.metadata.mint);
  if (!mint) {
    throw new RoseActionError(
      "rpc",
      "Could not read the mint",
      `The Solana RPC returned no 82-byte SPL mint account for ${state.metadata.mint.toBase58()} at finalized; the attribution needs its exact bytes. Retry in a few seconds.`,
      true,
    );
  }
  return { metadataPubkey: metadata.toBase58(), metadata: state.metadata, mint, verdict: { eligible: true, reasons: [] }, classId, classExists: true };
}

export type StreamLocation = "wallet" | "deposit_address" | "vault" | "elsewhere";

/** Where a stream of a deposit sits, as the holder reads it. */
export function streamLocation(recipient: string, owner: string, depositAddress: string | null, vault: string | null): StreamLocation {
  if (recipient === owner) return "wallet";
  if (vault !== null && recipient === vault) return "vault";
  if (depositAddress !== null && recipient === depositAddress) return "deposit_address";
  return "elsewhere";
}

/** What an interrupted deposit waits for, from its engine stage and where its stream sits; null when there is nothing to resume. */
export function pendingStatus(stage: StageName | null, location: StreamLocation): string | null {
  if (stage === "Registered" || stage === "Refused") return null;
  if (stage === null) return location === "deposit_address" ? "At your deposit address, not attributed yet: attribution is next." : null;
  if (location === "vault") return "In the engine's vault: the registration (MPC proof) is next.";
  return stage === "MoveSigned" ? "Attributed, and the engine signed the move into the vault: the broadcast is next." : "Attributed to you: the move into the vault is next.";
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
 * Polls that absorb view lag once a call returned: the wallets wait for the whole receipt tree
 * (`EXECUTED_OPTIMISTIC`), MPC callback included, so a stage still missing after them means the
 * proof was answered and did not match.
 */
export const SETTLED_POLLS = 2;

/** Why a proof sent by this tab left the deposit where it was. */
function proofMissError(expected: StageName[]): RoseActionError {
  return expected.includes("Registered") && !expected.includes("Attributed")
    ? new RoseActionError("mpc_timeout", "Registration proof did not match", "The MPC answered but the proof did not register the stream: the move is not final for the MPC nodes yet, or the stream changed between the read and the proof. Nothing was kept; retry with fresh bytes.", true)
    : new RoseActionError("mpc_timeout", "Attribution proof did not match", "The MPC answered but the proof did not match the bytes sent (the stream or its mint changed in flight, or the MPC failed). The record storage was returned; retry with fresh bytes.", true);
}

/**
 * Polls `get_sol_deposit` until the deposit reaches one of `expected` (or `Refused`). The MPC
 * answers a proof in about 7 s; one that never answers surfaces after about 2 min, so the
 * wait gives up a little later with a retryable error. With `sentNow` (this tab's call just
 * returned, callback included) a deposit still short of `expected` fails at once.
 */
export async function waitForStage(views: EngineViews, metadata: string, expected: StageName[], options: { signal?: AbortSignal; onPoll?: (elapsedMs: number) => void; sentNow?: boolean } = {}): Promise<SolDepositView> {
  const started = Date.now();
  for (let poll = 1; ; poll += 1) {
    const deposit = await views.raw.getSolDeposit(metadata, { signal: options.signal });
    if (deposit) {
      const stage = stageName(deposit.stage);
      if (stage === "Refused" || expected.includes(stage)) return deposit;
    }
    if (options.sentNow && poll >= SETTLED_POLLS) throw proofMissError(expected);
    const elapsed = Date.now() - started;
    options.onPoll?.(elapsed);
    if (elapsed > STAGE_WAIT_MS) {
      throw new RoseActionError("mpc_timeout", "MPC verification timed out", "The engine has not recorded the proof after 2.5 minutes: the stream may have changed in flight or the MPC nodes lag. Retry: the step re-reads the account and re-sends the proof.", true);
    }
    await sleep(STAGE_POLL_MS, options.signal);
  }
}
