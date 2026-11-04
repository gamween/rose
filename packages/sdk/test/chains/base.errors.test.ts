import {
  type Abi,
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  InsufficientFundsError,
  UserRejectedRequestError,
} from "viem";
import { describe, expect, it } from "vitest";
import { demoStreamFaucetAbi, roseVaultAbi } from "../../src/chains/base/abis.js";
import { classifyEvmError, describeVaultError } from "../../src/chains/base/errors.js";

function revert(abi: Abi, errorName: string, args: readonly unknown[]): BaseError {
  const data = encodeErrorResult({ abi, errorName, args });
  const reverted = new ContractFunctionRevertedError({ abi, data, functionName: "depositStream" });
  return new ContractFunctionExecutionError(reverted, { abi, functionName: "depositStream", args: [] });
}

describe("classifyEvmError", () => {
  it("recognizes a wallet rejection", () => {
    expect(classifyEvmError(new UserRejectedRequestError(new Error("denied"))).kind).toBe("rejected");
    expect(classifyEvmError(new Error("User rejected the request.")).kind).toBe("rejected");
  });

  it("recognizes insufficient funds", () => {
    const error = classifyEvmError(new InsufficientFundsError({ cause: new BaseError("insufficient funds") }));
    expect(error.kind).toBe("insufficient_funds");
  });

  it("decodes RoseVault custom errors into sentences", () => {
    const error = classifyEvmError(revert(roseVaultAbi, "NotStreamOwner", [82n, "0x000000000000000000000000000000000000dEaD"]));
    expect(error.kind).toBe("reverted");
    expect(error.revertName).toBe("NotStreamOwner");
    expect(error.message).toBe("You do not own stream 82 (owner 0x000000000000000000000000000000000000dEaD).");
  });

  it("decodes the faucet cooldown with an ISO time", () => {
    const error = classifyEvmError(revert(demoStreamFaucetAbi, "CooldownActive", [1793753725n]));
    expect(error.message).toBe("You already minted this class; next mint at 2026-11-04T00:55:25.000Z.");
  });

  it("maps unknown names and non-Error values", () => {
    expect(describeVaultError("Mystery")).toBe("The contract reverted with Mystery.");
    expect(classifyEvmError("boom")).toEqual({ kind: "unknown", message: "Unknown error." });
    expect(classifyEvmError(new BaseError("HTTP request failed.")).kind).toBe("rpc");
  });
});
