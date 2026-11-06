import { describe, expect, it, vi } from "vitest";
import { SABLIER_PROTOCOL_LOCKUP, vaultStreamFeeWei } from "./sablier-fee";

const LOCKUP = "0xA65A1ecEf02C2B9BDc604951c6A6D02335D4532e";
const COMPTROLLER = "0x0000008ABbFf7a84a2fE09f9A9b74D3BC2072399";
const VAULT = "0x62358c4f6fadb303f3a7d18ad34a1afcc1174d06";

describe("Sablier fee of the cohort streams", () => {
  it("asks the Lockup's comptroller for the fee of RoseVault, the sender of every stream createStreams creates", async () => {
    const readContract = vi.fn(({ functionName }: { functionName: string }) => Promise.resolve(functionName === "comptroller" ? COMPTROLLER : 7n));
    const fee = await vaultStreamFeeWei({ readContract } as never, LOCKUP, VAULT);
    expect(fee).toBe(7n);
    expect(readContract.mock.calls.map(([call]) => call)).toMatchObject([
      { address: LOCKUP, functionName: "comptroller" },
      { address: COMPTROLLER, functionName: "calculateMinFeeWeiFor", args: [SABLIER_PROTOCOL_LOCKUP, VAULT] },
    ]);
  });
});
