import { NearRpcError } from "@rose/sdk";
import { describe, expect, it } from "vitest";
import { failureToActionError, RoseActionError, toActionError } from "./errors";

describe("human-readable errors", () => {
  it("recognizes a wallet rejection", () => {
    expect(toActionError(new Error("User rejected the request."))).toMatchObject({ kind: "rejected", retryable: true });
    expect(toActionError({ code: 4001, message: "MetaMask Tx Signature: User denied transaction signature." })).toMatchObject({ kind: "rejected" });
  });

  it("recognizes an MPC timeout with a retry", () => {
    const error = toActionError(new Error("Smart contract panicked: Request has timed out."));
    expect(error.kind).toBe("mpc_timeout");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("Retry");
  });

  it("keeps the engine's key-timeout refusals as contract errors, not MPC timeouts", () => {
    const reached = toActionError(new Error("Smart contract panicked: Key timeout reached: the round can only be cancelled (cancel_no_key)"));
    expect(reached).toMatchObject({ kind: "contract", retryable: false });
    expect(reached.message).toBe("Key timeout reached: the round can only be cancelled (cancel_no_key)");
    expect(toActionError(new Error("Smart contract panicked: Key timeout not reached"))).toMatchObject({ kind: "contract", message: "Key timeout not reached" });
    expect(toActionError(new Error("Smart contract panicked: key_timeout must be between 1 minute and 7 days"))).toMatchObject({ kind: "contract" });
    expect(toActionError(new Error("Callback failed: PromiseError"))).toMatchObject({ kind: "mpc_timeout" });
    expect(toActionError(new Error("TimeoutError: signal timed out"))).toMatchObject({ kind: "rpc", retryable: true });
  });

  it("reads 4001 as a rejection only when it is the wallet's error code", () => {
    expect(toActionError(new Error("Smart contract panicked: Attach the storage deposit for rose-demo-a4001b.testnet"))).toMatchObject({ kind: "contract" });
    expect(toActionError(new Error("Smart contract panicked: Insufficient cash: 40010000 needed"))).toMatchObject({ kind: "insufficient_balance" });
    expect(toActionError({ code: 4001, message: "Request denied" })).toMatchObject({ kind: "rejected" });
  });

  it("keeps an engine panic that mentions an expiry as a contract error", () => {
    expect(toActionError(new Error("Smart contract panicked: Signature request expired"))).toMatchObject({ kind: "contract", message: "Signature request expired" });
  });

  it("recognizes an expired Solana blockhash with a retry", () => {
    expect(toActionError(new Error("Transaction simulation failed: Blockhash not found"))).toMatchObject({ kind: "expired_blockhash", retryable: true });
    expect(toActionError(new Error("TransactionExpiredBlockheightExceededError: block height exceeded"))).toMatchObject({ kind: "expired_blockhash" });
  });

  it("recognizes insufficient balances on every chain", () => {
    expect(toActionError(new Error("insufficient funds for gas * price + value"))).toMatchObject({ kind: "insufficient_balance" });
    expect(toActionError(new Error("Transfer: insufficient lamports 0, need 5000"))).toMatchObject({ kind: "insufficient_balance" });
    // viem, Base Sepolia account without ETH (live, 2026-11-04).
    expect(toActionError(new Error("Execution reverted with reason: gas required exceeds allowance (0)."))).toMatchObject({ kind: "insufficient_balance" });
    expect(toActionError(new Error("Smart contract panicked: Insufficient cash")).message).toContain("Deposit tUSDC");
  });

  it("maps NEAR RPC errors to not deployed and unreachable", () => {
    expect(toActionError(new NearRpcError("no_contract", "No contract is deployed on x."))).toMatchObject({ kind: "not_deployed" });
    expect(toActionError(new NearRpcError("unreachable", "down"))).toMatchObject({ kind: "rpc", retryable: true });
  });

  it("passes RoseActionError through and describes execution failures", () => {
    const own = new RoseActionError("no_wallet", "No wallet", "Connect first.");
    expect(toActionError(own)).toBe(own);
    const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Round not found" } } } };
    expect(failureToActionError(failure)).toMatchObject({ kind: "contract", message: "Round not found" });
  });
});
