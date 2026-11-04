import { RoseActionError } from "@/lib/errors";

/**
 * `waitForTransactionReceipt` resolves for reverted transactions too: a flow reports success only
 * after this check. `what` names the action in the error ("The tUSDC mint").
 */
export function requireSuccessfulReceipt<R extends { status: "success" | "reverted" }>(receipt: R, what: string): R {
  if (receipt.status !== "success") {
    throw new RoseActionError("contract", "Transaction reverted", `${what} reverted on Base Sepolia. Nothing changed; open the transaction on Basescan for the reason.`);
  }
  return receipt;
}
