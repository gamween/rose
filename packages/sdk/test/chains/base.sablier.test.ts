import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { SABLIER_LOCKUP_V4, baseAddressUrl, baseTxUrl, createBaseClient } from "../../src/chains/base/client.js";
import { must } from "./must.js";
import { checkEligibility, listOwnedStreams, LockupModel, readStream, type SablierStream } from "../../src/chains/base/sablier.js";

const eligible: SablierStream = {
  streamId: 82n,
  owner: "0xFa76B8f304d2A87FCAee0c258A76118368d0d671",
  token: "0x17E75069DD837EDA977AbEDF7a455aDda42868A9",
  decimals: 18,
  deposited: 100_000n * 10n ** 18n,
  withdrawn: 0n,
  refunded: 0n,
  start: 1778201663,
  cliff: 1809737663,
  end: 1872809663,
  granularity: 1,
  unlockAmounts: { start: 0n, cliff: 25_000n * 10n ** 18n },
  cancelable: false,
  transferable: true,
  wasCanceled: false,
  isDepleted: false,
  lockupModel: LockupModel.LINEAR,
  withdrawable: 0n,
};

describe("checkEligibility", () => {
  it("accepts a transferable non-cancelable LL stream with tokens left", () => {
    expect(checkEligibility(eligible)).toEqual({ eligible: true, reasons: [] });
  });

  it("lists every failing rule", () => {
    const result = checkEligibility({ ...eligible, cancelable: true, transferable: false, wasCanceled: true, isDepleted: true, lockupModel: LockupModel.TRANCHED });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["not_linear", "cancelable", "not_transferable", "canceled", "depleted"]);
  });

  it("refuses a stream with less than one whole token left after the vested withdrawal", () => {
    const almostVested = { ...eligible, deposited: 10n ** 18n * 5n, withdrawn: 10n ** 18n * 2n, withdrawable: 10n ** 18n * 2n + 10n ** 17n };
    expect(checkEligibility(almostVested).reasons).toEqual(["below_minimum"]);
    expect(checkEligibility(almostVested, { minimumDeposit: 10n ** 17n }).eligible).toBe(true);
  });
});

describe("Lockup reads", () => {
  it("reads every stream field in one multicall plus the token decimals", async () => {
    const calls: string[] = [];
    const client = {
      chain: { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } },
      multicall: ({ contracts }: { contracts: { functionName: string }[] }) => {
        calls.push(...contracts.map((c) => c.functionName));
        const byName: Record<string, unknown> = {
          ownerOf: eligible.owner,
          getUnderlyingToken: eligible.token,
          getDepositedAmount: eligible.deposited,
          getWithdrawnAmount: 0n,
          getRefundedAmount: 0n,
          getStartTime: 1778201663,
          getCliffTime: 1809737663,
          getEndTime: 1872809663,
          getGranularity: 1,
          getUnlockAmounts: { start: 0n, cliff: eligible.unlockAmounts.cliff },
          isCancelable: false,
          isTransferable: true,
          wasCanceled: false,
          isDepleted: false,
          getLockupModel: 0,
          withdrawableAmountOf: 0n,
        };
        return Promise.resolve(contracts.map((c) => byName[c.functionName]));
      },
      readContract: ({ functionName }: { functionName: string }) => {
        calls.push(functionName);
        return Promise.resolve(18);
      },
    } as unknown as PublicClient;
    const stream = await readStream(client, 82n);
    expect(stream).toEqual(eligible);
    expect(calls).toHaveLength(17);
    expect(calls.at(-1)).toBe("decimals");
  });

  it("scans ownerOf backwards from nextStreamId in batches", async () => {
    const batches: bigint[][] = [];
    const client = {
      chain: { contracts: { multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11" } } },
      readContract: () => Promise.resolve(84n),
      multicall: ({ contracts }: { contracts: { args: readonly [bigint] }[] }) => {
        const ids = contracts.map((c) => c.args[0]);
        batches.push(ids);
        return Promise.resolve(
          ids.map((id) => (id === 83n || id === 70n ? { status: "success", result: eligible.owner.toLowerCase() } : id === 75n ? { status: "failure", error: new Error("burned") } : { status: "success", result: "0x0000000000000000000000000000000000000001" })),
        );
      },
    } as unknown as PublicClient;
    const found = await listOwnedStreams(client, eligible.owner, { fromId: 64n, batchSize: 10 });
    expect(found).toEqual([83n, 70n]);
    expect(batches.map((b) => b.length)).toEqual([10, 10]);
    expect(must(batches[0])[0]).toBe(83n);
    expect(must(batches[1]).at(-1)).toBe(64n);
  });
});

describe("constants and calldata", () => {
  it("builds explorer links", () => {
    expect(baseTxUrl("0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(baseAddressUrl(SABLIER_LOCKUP_V4)).toBe("https://sepolia.basescan.org/address/0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e");
  });

  it("creates a client on chain 84532 with multicall enabled", () => {
    const client = createBaseClient({ fetch: () => Promise.reject(new Error("offline")) });
    expect(client.chain?.id).toBe(84532);
    expect(client.chain?.contracts?.multicall3?.address).toBe("0xca11bde05977b3631167028862be2a173976ca11");
  });
});
