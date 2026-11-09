import { LandingFooter } from "@/components/chrome/LandingFooter";
import { TopNav } from "@/components/chrome/TopNav";
import { LandingSequence } from "@/components/landing/LandingSequence";
import { ButtonLink } from "@/components/ui/Button";
import { ROUTES } from "@/lib/routes";

export default function LandingPage() {
  return (
    <>
      <TopNav overlay minimal action={<ButtonLink href={ROUTES.app} size="sm">Launch app</ButtonLink>} />
      <main>
        <LandingSequence />
      </main>
      <LandingFooter />
    </>
  );
}
