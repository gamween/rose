import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { TopNav } from "@/components/chrome/TopNav";
import { readDeployment } from "@/components/docs/deployment";
import { StatusPage } from "@/components/status/StatusPage";
import { ButtonLink } from "@/components/ui/Button";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Status",
  description: "Live checks of the rose deployment: keyless engine, contract versions, MPC latency, vault balances and recent verifications.",
};

export default function StatusRoute() {
  return (
    <>
      <TopNav
        action={
          <ButtonLink href={ROUTES.app} size="sm">
            Launch app
          </ButtonLink>
        }
      />
      <StatusPage deployment={readDeployment()} />
      <Footer />
    </>
  );
}
