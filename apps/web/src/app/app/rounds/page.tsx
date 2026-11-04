import type { Metadata } from "next";
import { RoundsPage } from "@/components/rounds/RoundsPage";
import { deployed } from "@/lib/deployment";

export const metadata: Metadata = {
  title: "Rounds",
  description: "Tender, Exit and Advance rounds: sealed bids, countdowns and the next action for whoever is looking.",
};

export default function RoundsRoute() {
  return <RoundsPage configured={deployed("engineAccount") !== null} />;
}
