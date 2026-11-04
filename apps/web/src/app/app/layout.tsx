import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/chrome/AppShell";
import { WalletProvider } from "@/components/wallet/WalletProvider";

export const metadata: Metadata = {
  title: { default: "App", template: "%s · rose" },
};

/** The `/app` shell: wallet context plus the global chrome (spec 8.3 "Global"). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <AppShell>{children}</AppShell>
    </WalletProvider>
  );
}
