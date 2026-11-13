"use client";

import { useEffect, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Button } from "@/components/ui/Button";
import { Stepper } from "@/components/ui/Stepper";
import { Tabs } from "@/components/ui/Tabs";
import { CohortTab } from "./CohortTab";
import { CreateClassTab } from "./CreateClassTab";
import { DistributeTab } from "./DistributeTab";
import { FundTab } from "./FundTab";
import { ResultsTab } from "./ResultsTab";
import { IssuerGate, useIssuerBase } from "./shared";
import { TenderTab } from "./TenderTab";

/** Every place of the console, in the URL hash: the five steps, the DAO variant of the launch step, and the results. */
export type IssuerTab = "class" | "cohort" | "distribute" | "fund" | "tender" | "dao" | "results";

type Step = "class" | "cohort" | "distribute" | "fund" | "tender";

const STEPS: readonly { id: Step; label: string }[] = [
  { id: "class", label: "Class" },
  { id: "cohort", label: "Cohort streams" },
  { id: "distribute", label: "Distribute units" },
  { id: "fund", label: "Fund" },
  { id: "tender", label: "Launch Tender" },
];

const VIEWS = [
  { id: "setup", label: "New Tender" },
  { id: "results", label: "Results" },
] as const;

const TAB_IDS = new Set<string>(["class", "cohort", "distribute", "fund", "tender", "dao", "results"]);

function tabFromHash(hash: string): IssuerTab {
  const id = hash.replace(/^#/, "");
  return TAB_IDS.has(id) ? (id as IssuerTab) : "class";
}

/**
 * `/app/issuer`: a launchpad-style create flow. "New Tender" walks the five steps one at a time
 * (Back / Continue under the step); "Results" lists the issuer's Tenders. The place lives in the
 * URL hash, so `#fund` or `#dao` links straight to it.
 */
export function IssuerConsole() {
  const [tab, setTab] = useState<IssuerTab>("class");
  const { state, refresh } = useIssuerBase();

  useEffect(() => {
    const sync = () => setTab(tabFromHash(window.location.hash));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = (next: IssuerTab) => {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  };

  const step: Step = tab === "dao" ? "tender" : tab === "results" ? "class" : tab;
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const previous = STEPS[stepIndex - 1];
  const next = STEPS[stepIndex + 1];

  return (
    <div className="flex flex-col gap-5" data-issuer-console>
      <header className="flex flex-col gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink-50">Issuer console</h1>
          <p className="mt-1 text-[13px] text-ink-400">
            Buy back your cohort&apos;s locked allocations at one fair price. <LearnMore topic="issuer" />
          </p>
        </div>
        <Tabs items={VIEWS} value={tab === "results" ? "results" : "setup"} onChange={(view) => select(view === "results" ? "results" : step)} label="Issuer views" />
      </header>
      <IssuerGate state={state} onRetry={() => void refresh()}>
        {(base) =>
          tab === "results" ? (
            <div role="tabpanel" data-issuer-tab="results">
              <ResultsTab base={base} />
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <Stepper steps={STEPS} value={step} onChange={select} label="Issuer steps" />
              <div role="tabpanel" aria-label={STEPS[stepIndex]?.label} data-issuer-tab={tab}>
                {tab === "class" ? <CreateClassTab base={base} /> : null}
                {tab === "cohort" ? <CohortTab base={base} /> : null}
                {tab === "distribute" ? <DistributeTab base={base} /> : null}
                {tab === "fund" ? <FundTab base={base} /> : null}
                {tab === "tender" || tab === "dao" ? <TenderTab base={base} showDao={tab === "dao"} onSigner={(dao) => select(dao ? "dao" : "tender")} /> : null}
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-ink-750 pt-4">
                {previous ? (
                  <Button variant="ghost" onClick={() => select(previous.id)} data-step-back>
                    ← {previous.label}
                  </Button>
                ) : (
                  <span />
                )}
                {next ? (
                  <Button variant="secondary" onClick={() => select(next.id)} data-step-next>
                    Continue: {next.label} →
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => select("results")} data-step-next>
                    See results →
                  </Button>
                )}
              </div>
            </div>
          )
        }
      </IssuerGate>
    </div>
  );
}
