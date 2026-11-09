"use client";

import { DemoClass, decodePositionMinted, mintDemoPosition, mintTestUsdc, mintTestUsdcCall } from "@rose/sdk";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Modal";
import { useToast, type ExplorerLink } from "@/components/ui/Toast";
import { useWallets } from "@/components/wallet/WalletProvider";
import { WalletsStatusRow } from "@/components/wallet/WalletsStatus";
import { deployedAddress, NEAR_TUSDC_ACCOUNT } from "@/lib/deployment";
import { RoseActionError, toActionError, type ActionError } from "@/lib/errors";
import { addressUrl, CHAIN_LABEL, txLinks, type ChainId } from "@/lib/explorer";
import { formatUnits } from "@/lib/format";
import { basePublicClient } from "@/lib/wallet/evm-demo";
import { nearDemoKeyIsOnAccount } from "@/lib/wallet/near-demo";
import { requireSuccessfulReceipt } from "@/lib/wallet/receipt";
import { createSolanaDemoPosition, demoPositionLinks } from "@/lib/wallet/solana-stream";
import { LearnMore } from "./LearnMore";

const NEAR_TUSDC_MINT = 1_000_000_000n;
const BASE_TUSDC_MINT = 1_000_000_000n;
/** Storage registration on the tUSDC NEP-141 for a first-time holder (refunded when already registered). */
const NEAR_TUSDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

type FaucetInfo = {
  limits: { perAddress: number; perIp: number; windowSeconds: number };
  chains: Record<"base" | "solana" | "near" | "solana-demo-token", { configured: boolean; amount: string; unit: string }>;
};

type FaucetSuccess =
  | { chain: "base"; txHash: string; amount: string; explorerUrl: string }
  | { chain: "solana"; signature: string; amount: string; explorerUrl: string }
  | { chain: "near"; accountId: string; txHash: string; amount: string; explorerUrl: string };

type FaucetFailure = { error: string; message: string; retryAfterSeconds?: number };

/** The faucet's own message is already human-readable; only its title and retry hint depend on the code. */
function faucetError(failure: FaucetFailure): RoseActionError {
  switch (failure.error) {
    case "rate_limited":
      return new RoseActionError("rate_limited", "Faucet limit reached", failure.message);
    case "already_funded":
      return new RoseActionError("rate_limited", "Already funded", failure.message);
    case "faucet_dry":
      return new RoseActionError("insufficient_balance", "Faucet empty", failure.message);
    case "not_configured":
      return new RoseActionError("not_deployed", "Faucet not configured", failure.message);
    case "invalid_request":
      return new RoseActionError("contract", "Request refused", failure.message);
    default:
      return new RoseActionError("rpc", "Faucet unavailable", failure.message, true);
  }
}

async function callFaucet(body: Record<string, string>): Promise<FaucetSuccess> {
  let response: Response;
  try {
    response = await fetch("/api/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new RoseActionError("rpc", "Network error", "The faucet did not answer. Check your connection and retry.", true);
  }
  let payload: FaucetSuccess | FaucetFailure;
  try {
    payload = (await response.json()) as FaucetSuccess | FaucetFailure;
  } catch {
    throw new RoseActionError("rpc", "Faucet unavailable", `The faucet answered HTTP ${String(response.status)} without a result. Retry in a minute.`, true);
  }
  if (!response.ok || "error" in payload) throw faucetError(payload as FaucetFailure);
  return payload;
}

type ActionState = { status: "idle" } | { status: "loading"; label: string } | { status: "success"; message: string; links: ExplorerLink[] } | { status: "error"; error: ActionError };

function useAction(onDone?: () => void): [ActionState, (label: string, run: () => Promise<{ message: string; links: ExplorerLink[] }>) => Promise<void>, () => void] {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const toast = useToast();
  const run = useCallback(
    async (label: string, action: () => Promise<{ message: string; links: ExplorerLink[] }>) => {
      setState({ status: "loading", label });
      const pending = toast.show({ tone: "pending", title: label });
      try {
        const result = await action();
        setState({ status: "success", message: result.message, links: result.links });
        toast.update(pending, { tone: "success", title: result.message, links: result.links });
        onDone?.();
      } catch (error) {
        const described = toActionError(error);
        setState({ status: "error", error: described });
        toast.update(pending, { tone: "error", title: described.title, description: described.message });
      }
    },
    [onDone, toast],
  );
  const reset = useCallback(() => setState({ status: "idle" }), []);
  return [state, run, reset];
}

function ActionRow({
  title,
  description,
  state,
  onRun,
  disabledReason,
  children,
}: {
  title: string;
  description: ReactNode;
  state: ActionState;
  onRun: () => void;
  disabledReason: string | null;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink-50">{title}</p>
          <p className="mt-0.5 text-[12px] text-ink-400">{description}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={onRun} disabled={disabledReason !== null} loading={state.status === "loading"} loadingLabel="Sending" title={disabledReason ?? undefined}>
          {state.status === "error" && state.error.retryable ? "Retry" : "Run"}
        </Button>
      </div>
      {children}
      {disabledReason ? <p className="text-[11px] text-ink-400">{disabledReason}</p> : null}
      {state.status === "success" ? (
        <p className="flex flex-wrap items-center gap-x-3 text-[12px] text-success-400">
          {state.message}
          {state.links.map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="text-[12px] text-ember-300 underline-offset-2 hover:underline font-medium">
              {link.label} ↗
            </a>
          ))}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="text-[12px] text-danger-400" role="alert">
          {state.error.title}: {state.error.message}
        </p>
      ) : null}
    </li>
  );
}

function ChainHeading({ chain, address, kind }: { chain: ChainId; address: string | null; kind: "external" | "demo" | null }) {
  return (
    <h3 className="flex items-center gap-2 text-[12px] text-ink-200 font-medium">
      {CHAIN_LABEL[chain]}
      {kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
      {address ? <span className="font-mono truncate normal-case tracking-normal text-ink-400">{address}</span> : <span className="normal-case tracking-normal text-ink-400">not connected</span>}
    </h3>
  );
}

/** The "Get test funds" panel of the testnet banner: every action wired end to end. */
export function GetTestFundsDrawer({ open, onClose, onConnect }: { open: boolean; onClose: () => void; onConnect: (chain: ChainId) => void }) {
  const wallets = useWallets();
  const [info, setInfo] = useState<FaucetInfo | null>(null);
  const refresh = wallets.refreshBalances;
  const [nearAccount, runNearAccount] = useAction(refresh);
  const [nearMint, runNearMint] = useAction(refresh);
  const [baseGas, runBaseGas] = useAction(refresh);
  const [baseMint, runBaseMint] = useAction(refresh);
  const [basePosition, runBasePosition] = useAction(refresh);
  const [solGas, runSolGas] = useAction(refresh);
  const [solPosition, runSolPosition] = useAction(refresh);
  const [demoClass, setDemoClass] = useState<0 | 1>(DemoClass.SEED);

  useEffect(() => {
    if (!open) return;
    void fetch("/api/faucet")
      .then((response) => (response.ok ? (response.json() as Promise<FaucetInfo>) : null))
      .then((payload) => setInfo(payload))
      .catch(() => setInfo(null));
  }, [open]);

  const baseTusdc = deployedAddress("baseTestUsdc");
  const demoFaucet = deployedAddress("demoStreamFaucet");
  const nearDemo = wallets.near.kind === "demo" ? wallets.near.demo : null;

  const connectHint = (chain: ChainId) => (
    <button type="button" onClick={() => onConnect(chain)} className="text-ember-300 underline-offset-2 hover:underline">
      Connect a {CHAIN_LABEL[chain]} wallet
    </button>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Get test funds"
      description={
        info
          ? `Faucet limits: ${String(info.limits.perAddress)} request per address and ${String(info.limits.perIp)} per IP per chain every ${String(Math.round(info.limits.windowSeconds / 3600))} h. Test assets only.`
          : "Testnet assets only. Nothing here has value."
      }
    >
      <div className="flex flex-col gap-5">
        <WalletsStatusRow what={wallets.restoring ? "Restoring your wallets…" : "Loading the wallet libraries…"} />
        <section className="flex flex-col gap-2">
          <ChainHeading chain="near" address={wallets.near.accountId} kind={wallets.near.kind} />
          <ul className="flex flex-col gap-2">
            <ActionRow
              title="Create the demo account with test NEAR"
              description={
                nearDemo
                  ? wallets.near.demoAccountExists
                    ? `${nearDemo.accountId} already exists on testnet.`
                    : `Creates ${nearDemo.accountId} through the NEAR testnet faucet helper (the same service near-cli-rs uses, 10 NEAR), or from the project's funder account when the helper is rate limited.`
                  : wallets.near.kind === "external"
                    ? "Your external wallet already has an account. The helper only creates new demo accounts."
                    : connectHint("near")
              }
              state={nearAccount}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !nearDemo ? "Needs the NEAR demo wallet." : wallets.near.demoAccountExists ? "Already created." : null}
              onRun={() =>
                void runNearAccount("Creating the NEAR demo account", async () => {
                  if (!nearDemo) throw new Error("No NEAR demo wallet.");
                  const create = async (demo: { accountId: string; publicKey: string }) => (await callFaucet({ chain: "near", accountId: demo.accountId, publicKey: demo.publicKey })) as { txHash: string; amount: string };
                  let demo = nearDemo;
                  let result: { txHash: string; amount: string };
                  try {
                    result = await create(demo);
                  } catch (error) {
                    if (!(error instanceof RoseActionError) || !/already exists/.test(error.message)) throw error;
                    /* The id is taken: by this very key (an earlier creation whose answer was lost), or by someone else. */
                    if (await nearDemoKeyIsOnAccount(demo)) {
                      wallets.markNearDemoCreated();
                      return { message: `Account ${demo.accountId} already exists with this demo key`, links: [{ href: addressUrl("near", demo.accountId), label: "Account on near.rocks" }] };
                    }
                    demo = await wallets.renewNearDemoAccountId();
                    result = await create(demo);
                  }
                  wallets.markNearDemoCreated();
                  return { message: `Account ${demo.accountId} created with ${result.amount}`, links: txLinks("near", result.txHash) };
                })
              }
            />
            <ActionRow
              title="Mint 1,000 tUSDC on NEAR"
              description={
                <>
                  Public capped mint on {NEAR_TUSDC_ACCOUNT}: 10,000 tUSDC per account per 24-hour window, which starts at your first mint after the previous window ended. Attaches 0.00125 NEAR of storage on first use.
                  {wallets.balances.nearTusdc !== null ? ` Balance: ${formatUnits(wallets.balances.nearTusdc, 6)} tUSDC.` : ""}
                </>
              }
              state={nearMint}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.near.accountId ? "Connect a NEAR wallet first." : nearDemo && !wallets.near.demoAccountExists ? "Create the demo account first." : null}
              onRun={() =>
                void runNearMint("Minting tUSDC on NEAR", async () => {
                  const outcome = await wallets.sendNearCall(mintTestUsdcCall(NEAR_TUSDC_ACCOUNT, NEAR_TUSDC_MINT, NEAR_TUSDC_STORAGE_DEPOSIT));
                  return { message: "1,000 tUSDC minted on NEAR", links: txLinks("near", outcome.transaction.hash) };
                })
              }
            />
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <ChainHeading chain="base" address={wallets.evm.address} kind={wallets.evm.kind} />
          <ul className="flex flex-col gap-2">
            <ActionRow
              title={`Send ${info ? formatUnits(BigInt(info.chains.base.amount), 18, 4) : "0.002"} ETH for gas`}
              description={wallets.evm.address ? "From the project's Base Sepolia hot wallet through /api/faucet." : connectHint("base")}
              state={baseGas}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.evm.address ? "Connect a Base Sepolia wallet first." : info && !info.chains.base.configured ? "The Base faucet is not configured on this deployment." : null}
              onRun={() =>
                void runBaseGas("Sending Base Sepolia ETH", async () => {
                  const result = (await callFaucet({ chain: "base", address: wallets.evm.address ?? "" })) as { txHash: string; amount: string };
                  return { message: `${formatUnits(BigInt(result.amount), 18, 4)} ETH sent`, links: txLinks("base", result.txHash) };
                })
              }
            />
            <ActionRow
              title="Mint 1,000 tUSDC on Base"
              description={
                <>
                  Public capped mint on rose Test USDC: 10,000 tUSDC per address per 24-hour window, which starts at your first mint after the previous window ended. Needs a little ETH for gas.
                  {wallets.balances.baseTusdc !== null ? ` Balance: ${formatUnits(wallets.balances.baseTusdc, 6)} tUSDC.` : ""}
                </>
              }
              state={baseMint}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.evm.address ? "Connect a Base Sepolia wallet first." : !baseTusdc ? "Test USDC is not deployed yet." : null}
              onRun={() =>
                void runBaseMint("Minting tUSDC on Base", async () => {
                  if (!baseTusdc) throw new Error("Test USDC is not deployed.");
                  const wallet = await wallets.getEvmWalletClient();
                  const hash = await mintTestUsdc(wallet, baseTusdc, BASE_TUSDC_MINT);
                  requireSuccessfulReceipt(await basePublicClient().waitForTransactionReceipt({ hash }), "The tUSDC mint");
                  return { message: "1,000 tUSDC minted on Base", links: txLinks("base", hash) };
                })
              }
            />
            <ActionRow
              title="Mint me a demo vesting position"
              description="DemoStreamFaucet creates a non-cancelable, transferable Sablier LL stream of the demo token to your address (one per class per 24 h), ready to deposit."
              state={basePosition}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.evm.address ? "Connect a Base Sepolia wallet first." : !demoFaucet ? "DemoStreamFaucet is not deployed yet." : null}
              onRun={() =>
                void runBasePosition("Minting a demo vesting position", async () => {
                  if (!demoFaucet) throw new Error("DemoStreamFaucet is not deployed.");
                  const wallet = await wallets.getEvmWalletClient();
                  const hash = await mintDemoPosition(wallet, demoFaucet, demoClass);
                  const receipt = requireSuccessfulReceipt(await basePublicClient().waitForTransactionReceipt({ hash }), "The demo position mint");
                  const minted = decodePositionMinted(receipt);
                  return { message: minted ? `Sablier stream #${minted.streamId.toString()} minted` : "Demo position minted", links: txLinks("base", hash) };
                })
              }
            >
              <div className="flex items-center gap-2 text-[12px]">
                <span className="text-ink-400">Class</span>
                {(
                  [
                    [DemoClass.SEED, "Seed cohort"],
                    [DemoClass.KOL, "KOL cohort"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDemoClass(value)}
                    aria-pressed={demoClass === value}
                    className={demoClass === value ? "rounded-sm border border-ember-500 bg-ember-700/25 px-2 py-0.5 text-ink-50" : "rounded-sm border border-ink-700 px-2 py-0.5 text-ink-300 hover:border-ink-500"}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </ActionRow>
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <ChainHeading chain="solana" address={wallets.solana.publicKey} kind={wallets.solana.kind} />
          <ul className="flex flex-col gap-2">
            <ActionRow
              title={`Send ${info ? formatUnits(BigInt(info.chains.solana.amount), 9, 3) : "0.05"} SOL`}
              description={wallets.solana.publicKey ? "From the project's devnet hot wallet through /api/faucet (the devnet RPC airdrop is closed)." : connectHint("solana")}
              state={solGas}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.solana.publicKey ? "Connect a Solana devnet wallet first." : info && !info.chains.solana.configured ? "The Solana faucet is not configured on this deployment." : null}
              onRun={() =>
                void runSolGas("Sending devnet SOL", async () => {
                  const result = (await callFaucet({ chain: "solana", address: wallets.solana.publicKey ?? "" })) as { signature: string; amount: string };
                  return { message: `${formatUnits(BigInt(result.amount), 9, 3)} SOL sent`, links: txLinks("solana", result.signature) };
                })
              }
            />
            <ActionRow
              title="Create a demo Streamflow position"
              description="Creates a non-cancelable, transferable Streamflow stream of 1,000 demo tokens to your own address. The faucet sends the demo tokens when your wallet holds fewer than 1,000; your wallet pays about 0.012 SOL of rent and fees (send SOL first)."
              state={solPosition}
              disabledReason={wallets.restoring ? "Restoring your wallets…" : !wallets.solana.publicKey ? "Connect a Solana devnet wallet first." : info && !info.chains["solana-demo-token"].configured ? "The Solana demo token faucet is not configured on this deployment." : null}
              onRun={() =>
                void runSolPosition("Creating a Streamflow position", async () => {
                  const signer = wallets.getSolanaSigner();
                  const result = await createSolanaDemoPosition(signer);
                  return { message: `Streamflow stream ${result.metadataId.slice(0, 8)}… created`, links: demoPositionLinks(result) };
                })
              }
            />
          </ul>
        </section>
        <p className="text-[12px] text-ink-400">
          Test ETH for the project itself comes from the Sepolia PoW faucet bridged through the official L1StandardBridge; the hot wallets refill from it. <LearnMore topic="faq" label="Faucet FAQ" />
        </p>
      </div>
    </Drawer>
  );
}
