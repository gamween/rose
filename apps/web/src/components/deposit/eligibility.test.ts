import { LockupModel, TOKEN_PROGRAM_ID, type SablierStream, type StreamflowMetadata } from "@rose/sdk";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { baseLogReplayKey, baseVerdict, mintDecimals, mintHasFreezeAuthority, remainingToLock, sablierScheduleArgs, scanRange, solanaVerdict, streamflowChargesFees, streamflowScheduleArgs } from "./eligibility";

const stream: SablierStream = {
  streamId: 82n,
  owner: "0xFa76B8f304d2A87FCAee0c258A76118368d0d671",
  token: "0x17E75069DD837EDA977AbEDF7a455aDda42868A9",
  decimals: 18,
  deposited: 100n * 10n ** 18n,
  withdrawn: 10n * 10n ** 18n,
  refunded: 0n,
  start: 1_778_201_663,
  cliff: 1_809_737_663,
  end: 1_872_809_663,
  granularity: 1,
  unlockAmounts: { start: 0n, cliff: 25n * 10n ** 18n },
  cancelable: false,
  transferable: true,
  wasCanceled: false,
  isDepleted: false,
  lockupModel: LockupModel.LINEAR,
  withdrawable: 5n * 10n ** 18n,
};

const key = (seed: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 0)));

const metadata: StreamflowMetadata = {
  magic: 0n,
  version: 1,
  createdAt: 1n,
  amountWithdrawn: 0n,
  canceledAt: 0n,
  endTime: 1_800_000_000n,
  lastWithdrawnAt: 0n,
  sender: key(1),
  senderTokens: key(2),
  recipient: key(3),
  recipientTokens: key(4),
  mint: key(5),
  escrowTokens: key(6),
  streamflowTreasury: key(7),
  streamflowTreasuryTokens: key(8),
  partner: key(9),
  partnerTokens: key(10),
  startTime: 1_700_000_000n,
  netAmountDeposited: 1_000_000_000n,
  period: 3600n,
  amountPerPeriod: 1_630_434n,
  cliff: 1_700_604_800n,
  cliffAmount: 100_000_000n,
  cancelableBySender: false,
  cancelableByRecipient: false,
  automaticWithdrawal: false,
  transferableBySender: false,
  transferableByRecipient: true,
  canTopup: false,
  withdrawFrequency: 0n,
  pausable: false,
  canUpdateRate: false,
  closed: false,
  currentPauseStart: 0n,
  pauseCumulative: 0n,
  lastRateChangeTime: 0n,
  fundsUnlockedAtLastRateChange: 0n,
};

describe("baseVerdict", () => {
  it("accepts an eligible stream and explains every failing rule", () => {
    expect(baseVerdict(stream, null)).toEqual({ eligible: true, reasons: [] });
    const verdict = baseVerdict({ ...stream, cancelable: true, lockupModel: LockupModel.DYNAMIC }, null);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toEqual(["Only Lockup Linear streams can be deposited.", "The stream is cancelable; the sender must renounce it first."]);
  });
  it("refuses a token without decimals() and an unreadable stream", () => {
    expect(baseVerdict(stream, "The token has no decimals().").reasons).toEqual(["The token has no decimals()."]);
    expect(baseVerdict(null, "The token has no decimals().")).toEqual({ eligible: false, reasons: ["The token has no decimals()."] });
    expect(baseVerdict(null, null).reasons).toEqual(["The stream could not be read."]);
  });
  it("computes the amount left to lock and the schedule arguments", () => {
    expect(remainingToLock(stream)).toBe(85n * 10n ** 18n);
    expect(remainingToLock({ ...stream, withdrawable: 200n * 10n ** 18n })).toBe(0n);
    expect(sablierScheduleArgs(stream)).toEqual({
      start: 1_778_201_663,
      cliff: 1_809_737_663,
      end: 1_872_809_663,
      granularity: 1,
      deposited: (100n * 10n ** 18n).toString(),
      start_unlock: "0",
      cliff_unlock: (25n * 10n ** 18n).toString(),
    });
  });
});

const FEE_FREE = new Uint8Array(1104);
/** A classic 6-decimal mint without a freeze authority (`COption` tag 0 at byte 46). */
const MINT_DATA = (() => {
  const data = new Uint8Array(82);
  data[44] = 6;
  return data;
})();
const CLASSIC_MINT = { owner: TOKEN_PROGRAM_ID, data: MINT_DATA, decimals: 6 };
const NOW = 1_750_000_000n;

describe("solanaVerdict", () => {
  it("refuses a stream whose withdrawals pay Streamflow or partner fees", () => {
    const withFee = new Uint8Array(1104);
    new DataView(withFee.buffer).setFloat32(321, 0.25, true);
    expect(streamflowChargesFees(FEE_FREE)).toBe(false);
    expect(streamflowChargesFees(withFee)).toBe(true);
    expect(solanaVerdict(metadata, CLASSIC_MINT, withFee, NOW).reasons).toEqual(["Withdrawals from the stream pay Streamflow or partner fees; the engine only holds fee-free streams."]);
  });

  it("accepts a stream the sender cannot change on a classic mint", () => {
    expect(solanaVerdict(metadata, CLASSIC_MINT, FEE_FREE, NOW)).toEqual({ eligible: true, reasons: [] });
  });
  it("adds the automatic withdrawal and Token-2022 rules to the SDK rules", () => {
    const verdict = solanaVerdict({ ...metadata, automaticWithdrawal: true, canTopup: true }, { ...CLASSIC_MINT, owner: key(42) }, FEE_FREE, NOW);
    expect(verdict.reasons).toEqual([
      "The sender can top the stream up, which would change the schedule.",
      "The stream withdraws automatically; the engine must control every withdrawal.",
      "The mint is not a classic SPL Token mint (Token-2022 is not supported).",
    ]);
    expect(solanaVerdict(metadata, null, FEE_FREE, NOW).reasons).toEqual(["The mint account could not be read."]);
  });
  it("refuses what the engine refuses at attribution: a freezable mint, history, dust and a fully unlocked stream", () => {
    const freezable = Uint8Array.from(MINT_DATA);
    freezable[46] = 1;
    expect(mintHasFreezeAuthority(MINT_DATA)).toBe(false);
    expect(mintHasFreezeAuthority(freezable)).toBe(true);
    expect(solanaVerdict(metadata, { ...CLASSIC_MINT, data: freezable }, FEE_FREE, NOW).reasons).toEqual(["The mint has a freeze authority: its holder could freeze the vault's token account and block every payout."]);
    expect(solanaVerdict({ ...metadata, pauseCumulative: 60n }, CLASSIC_MINT, FEE_FREE, NOW).reasons).toEqual(["The stream was paused or re-rated; its unlocks no longer follow the plain schedule."]);
    expect(solanaVerdict({ ...metadata, amountWithdrawn: 999_500_000n }, CLASSIC_MINT, FEE_FREE, NOW).reasons).toEqual(["The stream holds less than one whole token."]);
    expect(solanaVerdict({ ...metadata, amountWithdrawn: 1_000_000_000n }, CLASSIC_MINT, FEE_FREE, NOW).reasons).toEqual(["The stream is fully withdrawn."]);
    expect(solanaVerdict(metadata, CLASSIC_MINT, FEE_FREE, 1_800_000_000n).reasons).toEqual(["The stream is fully unlocked: withdraw it instead."]);
  });
  it("builds the class-id arguments: times as numbers, token amounts as U64 strings", () => {
    expect(streamflowScheduleArgs(metadata)).toEqual({
      start_time: 1_700_000_000,
      end_time: 1_800_000_000,
      net_amount_deposited: "1000000000",
      period: 3600,
      amount_per_period: "1630434",
      cliff: 1_700_604_800,
      cliff_amount: "100000000",
    });
  });
});

describe("keys, mints and ranges", () => {
  it("strips 0x and lowercases the transaction hash of a Base replay key", () => {
    expect(baseLogReplayKey({ transactionHash: "0xABCDef01", logIndex: 2 })).toEqual({ BaseLog: { tx_hash: "abcdef01", log_index: 2 } });
  });
  it("reads the decimals byte of an 82-byte mint account", () => {
    const data = new Uint8Array(82);
    data[44] = 6;
    expect(mintDecimals(data)).toBe(6);
    expect(() => mintDecimals(new Uint8Array(10))).toThrow(/82/);
  });
  it("never scans below id 1", () => {
    expect(scanRange(500n, 200n)).toEqual({ fromId: 301n, toId: 500n });
    expect(scanRange(50n, 200n)).toEqual({ fromId: 1n, toId: 50n });
  });
});
