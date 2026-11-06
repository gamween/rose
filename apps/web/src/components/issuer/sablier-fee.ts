/**
 * Sablier's withdrawal fee for the streams `createStreams` creates. Lockup's
 * `calculateMinFeeWei(streamId)` asks its comptroller for the fee of the stream's sender
 * (`SablierLockup.sol`, verified source on Sourcify), and RoseVault creates every cohort stream
 * with itself as the sender, so the fee of the streams not created yet is
 * `comptroller.calculateMinFeeWeiFor(Protocol.Lockup, RoseVault)`: another stream's fee belongs to
 * another sender, whose custom fee may differ.
 */

import type { Address, PublicClient } from "viem";

/** `Protocol.Lockup` of Sablier's comptroller (`enum Protocol { Airdrops, Flow, Lockup, Staking, Bob }`, evm-utils v2.0.1). */
export const SABLIER_PROTOCOL_LOCKUP = 2;

export const sablierComptrollerAbi = [
  { type: "function", name: "comptroller", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "calculateMinFeeWeiFor",
    stateMutability: "view",
    inputs: [
      { name: "protocol", type: "uint8" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** The per-stream fee of a stream whose sender is RoseVault, read from the Lockup's current comptroller. */
export async function vaultStreamFeeWei(client: Pick<PublicClient, "readContract">, lockup: Address, vault: Address): Promise<bigint> {
  const comptroller = await client.readContract({ address: lockup, abi: sablierComptrollerAbi, functionName: "comptroller" });
  return client.readContract({ address: comptroller, abi: sablierComptrollerAbi, functionName: "calculateMinFeeWeiFor", args: [SABLIER_PROTOCOL_LOCKUP, vault] });
}
