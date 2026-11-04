/**
 * The Base cash venue steps of `CashDeposit` (approve, `depositCash`, safe head, registration
 * arguments and the checked registration). They carry viem, so the round page downloads them only
 * when a deposit on Base starts.
 */

export { approveToken, decodeCashDeposited, depositCash, registerBaseCashArgs, waitForSafeHead } from "@rose/sdk";
export { basePublicClient } from "@/lib/wallet/evm-demo";
export { replayKeyOf } from "@/components/issuer/base-registration";
export { registerCashDeposit } from "./cash-registration";
