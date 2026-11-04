import { describe, expect, it } from "vitest";
import { hashTypedData, type Address } from "viem";
import { roseVaultAbi } from "../../src/chains/base/abis.js";
import { executeRelease, type ReleaseAuthorization } from "../../src/chains/base/vault.js";
import type { SignerClient } from "../../src/chains/base/sablier.js";
import type { PublicClient } from "viem";

/** A wallet that records the arguments and the value of its `writeContract` calls. */
function recordingWallet(): { wallet: SignerClient; calls: unknown[][]; values: unknown[] } {
  const calls: unknown[][] = [];
  const values: unknown[] = [];
  const wallet = {
    writeContract: (request: { args: unknown[]; value?: bigint }) => {
      calls.push(request.args);
      values.push(request.value);
      return Promise.resolve("0x01");
    },
  } as unknown as SignerClient;
  return { wallet, calls, values };
}

/** A client whose Sablier `calculateMinFeeWei` returns `fee`. */
function feeClient(fee: bigint): PublicClient {
  return { readContract: (request: { functionName: string }) => Promise.resolve(request.functionName === "calculateMinFeeWei" ? fee : 0n) } as unknown as PublicClient;
}

const VAULT: Address = "0x00000000000000000000000000000000000A11cE";
const release: ReleaseAuthorization = {
  lockup: "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e",
  streamId: 81n,
  to: "0x000000000000000000000000000000000000b0b0",
  id: 8n,
};
const signature = { v: 27, r: "0x01", s: "0x02" } as const;

describe("RoseVault Release", () => {
  it("signs the vestedToRecipient flag (known-answer digests shared with Foundry and the engine)", () => {
    const releaseType = roseVaultAbi.find((item) => item.type === "function" && item.name === "hashRelease");
    expect(releaseType?.inputs[0]?.components.map((c) => c.name)).toEqual(["lockup", "streamId", "to", "vestedToRecipient", "id"]);
    const domain = { name: "RoseVault", version: "1", chainId: 84532, verifyingContract: VAULT } as const;
    const types = { Release: [{ name: "lockup", type: "address" }, { name: "streamId", type: "uint256" }, { name: "to", type: "address" }, { name: "vestedToRecipient", type: "bool" }, { name: "id", type: "uint256" }] } as const;
    const digest = (vestedToRecipient: boolean) => hashTypedData({ domain, types, primaryType: "Release", message: { ...release, vestedToRecipient } });
    expect(digest(false)).toBe("0xab3684e318c5c016035a36f948f02e970040e271317ea09a327d2c59f6fef666");
    expect(digest(true)).toBe("0x1aa2f755fbde4c0062a5437278478f1b0f3820980c2ef5560ac419d7dc5eafe3");
  });

  it("submits the flag of the payout kind, false for a redeem when omitted", async () => {
    const { wallet, calls } = recordingWallet();
    await executeRelease(wallet, feeClient(0n), { vault: VAULT, authorization: { ...release, vestedToRecipient: true }, ...signature });
    await executeRelease(wallet, feeClient(0n), { vault: VAULT, authorization: release, ...signature });
    expect(calls.map((args) => (args[0] as { vestedToRecipient: boolean }).vestedToRecipient)).toEqual([true, false]);
    expect(calls[0]?.[0]).toEqual({ ...release, vestedToRecipient: true });
  });

  it("sends Sablier's withdrawal fee, read for the stream, plus the margin", async () => {
    const { wallet, values } = recordingWallet();
    await executeRelease(wallet, feeClient(0n), { vault: VAULT, authorization: release, ...signature });
    await executeRelease(wallet, feeClient(7n), { vault: VAULT, authorization: release, feeMarginWei: 3n, ...signature });
    expect(values).toEqual([0n, 10n]);
  });
});
