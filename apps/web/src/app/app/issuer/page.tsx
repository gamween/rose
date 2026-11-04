import type { Metadata } from "next";
import { IssuerConsole } from "@/components/issuer/IssuerConsole";

export const metadata: Metadata = { title: "Issuer console" };

export default function IssuerPage() {
  return <IssuerConsole />;
}
