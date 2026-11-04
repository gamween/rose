import type { Metadata } from "next";
import { readDeployment } from "@/components/docs/deployment";
import { PricesPage } from "@/components/prices/PricesPage";

export const metadata: Metadata = {
  title: "Prices",
  description: "Clearing prices of locked token classes: history per class, price against remaining lock time, discount to issuer-declared references.",
};

export default function PricesRoute() {
  return <PricesPage deployment={readDeployment()} />;
}
