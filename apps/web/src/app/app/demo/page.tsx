import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DemoPlayer } from "@/components/demo/DemoPlayer";
import { Skeleton } from "@/components/ui/Skeleton";
import { demoManifest } from "@/lib/demo/registry";

export const metadata: Metadata = {
  title: "Watch a full round",
  description: "A guided walkthrough of seeded rose rounds: real transactions on NEAR testnet, Base Sepolia and Solana devnet with their explorer links, and the engine's live views. No wallet needed.",
};

function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-16 w-full max-w-xl" />
      <Skeleton className="h-14 w-full rounded-lg" />
      <Skeleton className="h-72 w-full rounded-lg" />
    </div>
  );
}

/** `/app/demo` (spec 9): exists only when the configured engine has a committed demo manifest. */
export default function DemoRoute() {
  const manifest = demoManifest();
  if (!manifest) notFound();
  return (
    <Suspense fallback={<Loading />}>
      <DemoPlayer manifest={manifest} />
    </Suspense>
  );
}
