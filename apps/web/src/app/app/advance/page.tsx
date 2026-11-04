import type { Metadata } from "next";
import { AdvancePage } from "@/components/advance/AdvancePage";

export const metadata: Metadata = { title: "Advance" };

export default function Page() {
  return <AdvancePage />;
}
