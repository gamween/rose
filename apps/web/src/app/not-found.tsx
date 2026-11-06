import type { Metadata } from "next";
import { Footer } from "@/components/chrome/Footer";
import { TopNav } from "@/components/chrome/TopNav";
import { ButtonLink } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ROUTES } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Page not found",
};

/** Every unknown URL: the site chrome, what happened, and the ways back. */
export default function NotFound() {
  return (
    <>
      <TopNav
        action={
          <ButtonLink href={ROUTES.app} size="sm">
            Launch app
          </ButtonLink>
        }
      />
      <main className="mx-auto flex min-h-[60vh] w-full max-w-[1440px] items-center justify-center px-4 py-16 md:px-6" data-not-found>
        <EmptyState
          illustration="ember"
          title="This page does not exist"
          description="The link may be mistyped, or the page moved. Rounds, docs and the live deployment status are one click away."
          action={
            <div className="flex flex-wrap items-center justify-center gap-3">
              <ButtonLink href={ROUTES.app}>Back to the app</ButtonLink>
              <ButtonLink href={ROUTES.docs} variant="secondary">
                Docs
              </ButtonLink>
              <ButtonLink href={ROUTES.status} variant="ghost">
                Status
              </ButtonLink>
            </div>
          }
        />
      </main>
      <Footer />
    </>
  );
}
