import { decodeFunctionData, encodeAbiParameters, multicall3Abi, type Hex } from "viem";
import { MOCK } from "./engine-mock";

/**
 * `eth_call` answers for the reads the app pages batch through Multicall3 (viem's `multicall`
 * batching): ERC-20 metadata, RoseVault's replay bitmap, balances. Specs extend it with
 * `extra` for the selectors they need.
 */
export type EvmCallHandler = (to: string, data: Hex) => Hex | undefined;

export function evmCall(to: string, data: Hex, extra?: EvmCallHandler): Hex {
  const custom = extra?.(to, data);
  if (custom !== undefined) return custom;
  const selector = data.slice(0, 10);
  switch (selector) {
    case "0x95d89b41":
      return encodeAbiParameters([{ type: "string" }], [to.toLowerCase() === MOCK.demoToken ? "CINDR" : "tUSDC"]);
    case "0x313ce567":
      return encodeAbiParameters([{ type: "uint8" }], [to.toLowerCase() === MOCK.demoToken ? 18 : 6]);
    case "0x022d187c":
      return encodeAbiParameters([{ type: "bool" }], [false]);
    case "0x70a08231":
      return encodeAbiParameters([{ type: "uint256" }], [0n]);
    default:
      throw new Error(`Unmocked selector ${selector}`);
  }
}

/** Multicall3 `aggregate3(calls)`: every inner call answered by `evmCall`, all successful. */
export function aggregate3(data: Hex, extra?: EvmCallHandler): Hex {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  const calls = decoded.args[0] as readonly { target: string; callData: Hex }[];
  return encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
    [calls.map((call) => ({ success: true, returnData: evmCall(call.target, call.callData, extra) }))],
  );
}

/** A `baseRequest` hook answering `eth_call` (direct or through Multicall3). */
export function evmCallRequest(extra?: EvmCallHandler): (method: string, params: unknown[]) => unknown {
  return (method, params) => {
    if (method !== "eth_call") return undefined;
    const call = params[0] as { to: string; data: Hex };
    return call.data.startsWith("0x82ad56cb") ? aggregate3(call.data, extra) : evmCall(call.to, call.data, extra);
  };
}
