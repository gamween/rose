import type { Metadata } from "next";
import { WalletSummary } from "@/components/wallet/WalletSummary";

export const metadata: Metadata = { title: "Portfolio" };

export default function PortfolioPage() {
  return <WalletSummary />;
}
