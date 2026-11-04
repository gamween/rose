"use client";

import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useWallets } from "./WalletProvider";

/** A wallet surface while the wallet libraries download (`what` is what they will reveal), or their failure with a retry. */
export function WalletsStatusRow({ what }: { what: string }) {
  const { walletsStatus, loadWallets } = useWallets();
  if (walletsStatus === "ready") return null;
  if (walletsStatus === "failed") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-danger-500/60 bg-danger-500/10 px-3 py-2 text-[12px] text-ink-200" role="alert" data-wallets-failed>
        <span>The wallet libraries did not load. Check your connection.</span>
        <Button variant="ghost" size="sm" onClick={() => void loadWallets().catch(() => undefined)} aria-label="Retry loading the wallet libraries">
          Retry
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="flex items-center gap-2 rounded-md border border-ink-750 bg-ink-900 px-3 py-2 text-[12px] text-ink-400" data-wallets-loading>
      <span aria-hidden className="inline-flex">
        <Spinner />
      </span>
      {what}
    </p>
  );
}
