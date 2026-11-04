import type { Metadata } from "next";
import { DepositWizard } from "@/components/deposit/DepositWizard";

export const metadata: Metadata = { title: "Deposit" };

export default function DepositPage() {
  return <DepositWizard />;
}
