"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ConnectModal } from "@/components/wallet/ConnectModal";
import { useWallets } from "@/components/wallet/WalletProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat } from "@/components/ui/Stat";
import { LearnMore } from "@/components/chrome/LearnMore";
import { deployed } from "@/lib/deployment";
import { addressUrl, CHAIN_LABEL, type ChainId } from "@/lib/explorer";
import { formatUnits } from "@/lib/format";
import { ROUTES } from "@/lib/routes";

function Amount({ value, decimals, digits = 2 }: { value: bigint | null; decimals: number; digits?: number }) {
  const { balances } = useWallets();
  if (value === null) return balances.updatedAt === null ? <Skeleton className="inline-block h-5 w-16 align-middle" /> : <>—</>;
  return <>{formatUnits(value, decimals, digits)}</>;
}

function ChainCard({
  chain,
  address,
  walletName,
  kind,
  stats,
  onConnect,
}: {
  chain: ChainId;
  address: string | null;
  walletName: string | null;
  kind: "external" | "demo" | null;
  stats: { label: string; value: ReactNode; unit: string }[];
  onConnect: () => void;
}) {
  return (
    <Card>
      <CardHeader
        title={CHAIN_LABEL[chain]}
        description={
          address ? (
            <a href={addressUrl(chain, address)} target="_blank" rel="noreferrer" className="tabular break-all underline-offset-2 hover:underline">
              {address}
            </a>
          ) : (
            "Not connected"
          )
        }
        action={
          address ? (
            <span className="flex items-center gap-2 text-[12px] text-ink-400">
              {walletName}
              {kind === "demo" ? <Badge tone="ember">Demo</Badge> : null}
            </span>
          ) : (
            <Button size="sm" variant="secondary" onClick={onConnect}>
              Connect
            </Button>
          )
        }
      />
      <CardBody>
        <dl className="grid grid-cols-2 gap-4">
          {stats.map((stat) => (
            <Stat key={stat.label} label={stat.label} value={address ? stat.value : "—"} unit={stat.unit} />
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

const SECTIONS = [
  { href: ROUTES.rounds, title: "Rounds", body: "Tender, Exit and Advance rounds with sealed bids and countdowns." },
  { href: "/app/deposit", title: "Deposit", body: "Bring a Sablier or Streamflow position into custody and mint units." },
  { href: ROUTES.issuer, title: "Issuer console", body: "Create classes, distribute units and launch a Tender." },
  { href: "/app/advance", title: "Advance", body: "Borrow against future unlocks, or fund one." },
  { href: ROUTES.prices, title: "Prices", body: "Clearing prices per class and discount to reference." },
] as const;

/** `/app` entry: the connected wallets with their balances, the engine status and the sections. */
export function WalletSummary() {
  const wallets = useWallets();
  const [connect, setConnect] = useState<ChainId | null>(null);
  const engine = deployed("engineAccount");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] text-ink-50">Portfolio</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Your wallets on the three testnets and what they hold. {engine ? `Engine: ${engine}.` : "The engine is not deployed yet; units and rounds appear here once it is."}{" "}
            <LearnMore topic="concepts" />
          </p>
        </div>
        <Button size="sm" onClick={() => setConnect("near")}>
          {wallets.anyConnected ? "Connect another wallet" : "Connect a wallet"}
        </Button>
      </header>
      <div className="grid gap-4 md:grid-cols-3" data-wallet-summary>
        <ChainCard
          chain="near"
          address={wallets.near.accountId}
          walletName={wallets.near.walletName}
          kind={wallets.near.kind}
          stats={[
            { label: "Balance", value: <Amount value={wallets.balances.nearYocto} decimals={24} />, unit: "NEAR" },
            { label: "Cash", value: <Amount value={wallets.balances.nearTusdc} decimals={6} />, unit: "tUSDC" },
          ]}
          onConnect={() => setConnect("near")}
        />
        <ChainCard
          chain="base"
          address={wallets.evm.address}
          walletName={wallets.evm.walletName}
          kind={wallets.evm.kind}
          stats={[
            { label: "Gas", value: <Amount value={wallets.balances.baseEthWei} decimals={18} digits={4} />, unit: "ETH" },
            { label: "Cash", value: <Amount value={wallets.balances.baseTusdc} decimals={6} />, unit: "tUSDC" },
          ]}
          onConnect={() => setConnect("base")}
        />
        <ChainCard
          chain="solana"
          address={wallets.solana.publicKey}
          walletName={wallets.solana.walletName}
          kind={wallets.solana.kind}
          stats={[{ label: "Gas", value: <Amount value={wallets.balances.solLamports} decimals={9} digits={3} />, unit: "SOL" }]}
          onConnect={() => setConnect("solana")}
        />
      </div>
      <section>
        <h2 className="mb-3 font-display text-[11px] uppercase tracking-wide text-ink-400">Sections</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <Link href={section.href} className="flex h-full flex-col gap-1 rounded-lg border border-ink-750 bg-ink-850 px-4 py-3 transition-colors hover:border-ink-500 hover:bg-ink-800">
                <span className="font-display text-[13px] text-ink-50">{section.title}</span>
                <span className="text-[12px] text-ink-400">{section.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <ConnectModal open={connect !== null} onClose={() => setConnect(null)} initialChain={connect ?? "near"} />
    </div>
  );
}
