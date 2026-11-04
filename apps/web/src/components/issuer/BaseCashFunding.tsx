"use client";

import { approveToken, decodeCashDeposited, depositCash, erc20Abi, waitForSafeHead, type CashDepositedLog } from "@rose/sdk";
import { Button } from "@/components/ui/Button";
import { FlowSteps } from "@/components/ui/FlowSteps";
import { useWallets } from "@/components/wallet/WalletProvider";
import { formatUsdc, venueLabel } from "@/lib/amounts";
import { deployedAddress } from "@/lib/deployment";
import { RoseActionError } from "@/lib/errors";
import { txLinks } from "@/lib/explorer";
import { useFlow } from "@/lib/use-action";
import { requireSuccessfulReceipt } from "@/lib/wallet/receipt";
import { registerCashLog } from "./base-registration";
import { baseClient, Hint, type IssuerBase } from "./shared";

/**
 * Base cash funding through RoseVault: approve, `depositCash(token, amount, creditTo, roundId)`,
 * Base safe finality, then `register_base_cash`. The engine credits the NEAR account named in the
 * log, which need not be the signer: the Fund tab credits the connected account by default, "Run
 * via DAO" credits the DAO, so a member funds the treasury's Tender from their own Base wallet.
 */
export function BaseCashFunding({
  base,
  token,
  amount,
  creditTo,
  roundId,
  onDone,
}: {
  base: IssuerBase;
  token: string;
  amount: bigint | null;
  creditTo: string;
  roundId: bigint;
  onDone?: () => void;
}) {
  const wallets = useWallets();
  const vault = deployedAddress("roseVault");
  const flow = useFlow({ onComplete: onDone });
  const label = venueLabel({ Base: { token } }, base.symbols).replace(/^Base /, "");

  const run = async () => {
    if (!vault || amount === null || amount <= 0n || !wallets.evm.address || !creditTo) return;
    const tokenAddress = token as `0x${string}`;
    const client = baseClient();
    let log: CashDepositedLog | null = null;
    await flow.start([
      {
        id: "approve",
        label: `Approve RoseVault for ${formatUsdc(amount)} ${label}`,
        run: async () => {
          const owner = wallets.evm.address!;
          const [balance, allowance] = await Promise.all([client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [owner] }), client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "allowance", args: [owner, vault] })]);
          if (balance < amount) throw new RoseActionError("insufficient_balance", "Not enough tokens on Base", `Your Base wallet holds ${formatUsdc(balance)}. Mint tUSDC from "Get test funds".`);
          if (allowance >= amount) return { message: "Allowance already sufficient" };
          const wallet = await wallets.getEvmWalletClient();
          const hash = await approveToken(wallet, tokenAddress, vault, amount);
          requireSuccessfulReceipt(await client.waitForTransactionReceipt({ hash }), "The approval");
          return { message: "Approved", links: txLinks("base", hash) };
        },
      },
      {
        id: "deposit",
        label: `depositCash(${formatUsdc(amount)}, ${creditTo}, round ${roundId.toString()})`,
        run: async ({ setDetail }) => {
          const wallet = await wallets.getEvmWalletClient();
          const hash = await depositCash(wallet, { vault, token: tokenAddress, amount, nearAccount: creditTo, roundId });
          setDetail("Waiting for the receipt…");
          const receipt = requireSuccessfulReceipt(await client.waitForTransactionReceipt({ hash }), "depositCash");
          log = decodeCashDeposited(receipt)[0] ?? null;
          if (!log) throw new RoseActionError("contract", "No CashDeposited log", "RoseVault did not emit CashDeposited.");
          return { message: `CashDeposited in block ${receipt.blockNumber.toString()}`, links: txLinks("base", hash) };
        },
      },
      {
        id: "finality",
        label: "Base finality: ~3 min (safe head plus a 30 s margin)",
        run: async ({ setDetail, signal }) => {
          await waitForSafeHead(client, log!.blockNumber, { signal, onProgress: (progress) => setDetail(progress.phase === "ready" ? "Safe." : progress.phase === "margin" ? "Safe head passed; 30 s margin…" : `Safe head ${progress.safeHead.toString()} / target ${progress.target.toString()}…`) });
          return { message: "Base finality reached" };
        },
      },
      {
        id: "register",
        label: "register_base_cash on the engine (MPC verification, ~7 s)",
        run: async ({ signal, setDetail }) => {
          const result = await registerCashLog(base.engine, wallets.sendNearCall, log!, { signal, onDetail: setDetail });
          if (result.outcome.outcome === "refused") throw new RoseActionError("contract", "Deposit refused", result.outcome.refused.reason);
          return { message: `${formatUsdc(amount)} credited to the Base cash of ${creditTo}`, links: result.txHash ? txLinks("near", result.txHash) : [] };
        },
      },
    ]);
  };

  const disabled = !vault
    ? "RoseVault is not deployed yet."
    : !wallets.evm.address
      ? "Connect a Base Sepolia wallet."
      : !wallets.near.accountId
        ? "Connect a NEAR wallet (it signs register_base_cash)."
        : !creditTo
          ? "Name the NEAR account to credit."
          : amount === null || amount <= 0n
            ? "Enter an amount."
            : null;

  return (
    <div className="flex flex-col gap-3">
      <Hint>depositCash pulls the tokens into RoseVault and emits CashDeposited; the engine credits the Base cash of {creditTo || "the named account"} after a ForeignTx proof at Base safe finality.</Hint>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void run()} disabled={disabled !== null || flow.running} loading={flow.running} loadingLabel="Running" title={disabled ?? undefined} data-fund-base>
          Deposit on Base
        </Button>
        {disabled ? <Hint>{disabled}</Hint> : null}
      </div>
      <FlowSteps steps={flow.steps} onRetry={() => void flow.retry()} running={flow.running} />
    </div>
  );
}
