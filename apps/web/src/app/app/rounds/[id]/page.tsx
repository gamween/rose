import type { Metadata } from "next";
import { RoundDetailPage } from "@/components/rounds/RoundDetailPage";
import { deployed } from "@/lib/deployment";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Round #${id}`,
    description: "Public parameters, status timeline with the next action, sealed book, orders, clearing curves, fills, settlement links and verification of a rose round.",
  };
}

export default async function RoundRoute({ params }: { params: Params }) {
  const { id } = await params;
  return <RoundDetailPage roundId={id} configured={deployed("engineAccount") !== null} />;
}
