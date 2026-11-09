"use client";

import { useEffect, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { Tabs } from "@/components/ui/Tabs";
import { CohortTab } from "./CohortTab";
import { CreateClassTab } from "./CreateClassTab";
import { DistributeTab } from "./DistributeTab";
import { FundTab } from "./FundTab";
import { ResultsTab } from "./ResultsTab";
import { IssuerGate, useIssuerBase } from "./shared";
import { TenderTab } from "./TenderTab";

export type IssuerTab = "class" | "cohort" | "distribute" | "fund" | "tender" | "dao" | "results";

const TABS = [
  { id: "class", label: "Create a class" },
  { id: "cohort", label: "Cohort streams" },
  { id: "distribute", label: "Distribute units" },
  { id: "fund", label: "Fund" },
  { id: "tender", label: "Launch Tender" },
  { id: "dao", label: "Run via DAO" },
  { id: "results", label: "Results" },
] as const;

const TAB_IDS = new Set<string>(TABS.map((tab) => tab.id));

function tabFromHash(hash: string): IssuerTab {
  const id = hash.replace(/^#/, "");
  return TAB_IDS.has(id) ? (id as IssuerTab) : "class";
}

/** `/app/issuer`: the issuer's path from a class to a settled Tender, one tab per step, the tab in the URL hash. */
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

  return (
    <div className="flex flex-col gap-5" data-issuer-console>
      <header>
        <p className="text-[12px] text-ember-400 font-medium">Issuer console</p>
        <h1 className="mt-1 text-[22px] text-ink-50 font-semibold tracking-tight">Buy back locked allocations at one fair price</h1>
        <p className="mt-1 max-w-3xl text-[13px] text-ink-400">
          Create the class, put the cohort&apos;s streams in custody, distribute units, then launch and fund a Tender: a public budget and max price, sealed asks, one uniform clearing price and a public report. <LearnMore topic="issuer" />
        </p>
      </header>
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <Tabs items={TABS} value={tab} onChange={select} label="Issuer steps" className="min-w-max" />
      </div>
      <IssuerGate state={state} onRetry={() => void refresh()}>
        {(base) => (
          <div role="tabpanel" data-issuer-tab={tab}>
            {tab === "class" ? <CreateClassTab base={base} /> : null}
            {tab === "cohort" ? <CohortTab base={base} /> : null}
            {tab === "distribute" ? <DistributeTab base={base} /> : null}
            {tab === "tender" || tab === "dao" ? <TenderTab base={base} showDao={tab === "dao"} /> : null}
            {tab === "fund" ? <FundTab base={base} /> : null}
            {tab === "results" ? <ResultsTab base={base} /> : null}
          </div>
        )}
      </IssuerGate>
    </div>
  );
}
