import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DemoPlayer } from "@/components/demo/DemoPlayer";
import { demoManifest } from "@/lib/demo/registry";

export const metadata: Metadata = {
  title: "Watch a full round",
  description: "A guided walkthrough of seeded rose rounds: real transactions on NEAR testnet, Base Sepolia and Solana devnet with their explorer links, and the engine's live views. No wallet needed.",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * `/app/demo` (spec 9): exists only when the configured engine has a committed demo manifest. The
 * deep-link query is read here so the first step renders in the server HTML.
 */
export default async function DemoRoute({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const manifest = demoManifest();
  if (!manifest) notFound();
  const params = await searchParams;
  return <DemoPlayer manifest={manifest} query={{ round: first(params.round), step: first(params.step), autoplay: first(params.autoplay) === "1" }} />;
}
