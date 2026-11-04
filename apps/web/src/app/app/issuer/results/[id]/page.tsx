import type { Metadata } from "next";
import { TenderResults } from "@/components/issuer/TenderResults";

export const metadata: Metadata = { title: "Tender results" };

export default async function TenderResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TenderResults roundId={id} printable={false} />;
}
