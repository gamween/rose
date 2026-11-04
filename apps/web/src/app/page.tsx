import { Footer } from "@/components/chrome/Footer";
import { TopNav } from "@/components/chrome/TopNav";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LandingSequence } from "@/components/landing/LandingSequence";
import { ProtocolStats } from "@/components/landing/ProtocolStats";
import { ButtonLink } from "@/components/ui/Button";
import { ROUTES } from "@/lib/routes";

export default function LandingPage() {
  return (
    <>
      <TopNav overlay action={<ButtonLink href={ROUTES.app} size="sm">Launch app</ButtonLink>} />
      <main>
        <LandingSequence />
        <HowItWorks />
        <ProtocolStats />
      </main>
      <Footer />
    </>
  );
}
