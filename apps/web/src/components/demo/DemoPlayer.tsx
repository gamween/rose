"use client";

/**
 * "Watch a full round" (spec 9): steps through a seeded round with its real transactions and
 * explorer links, and the engine's live views. Works without any wallet. Prev / next buttons,
 * keyboard (arrows, J / K, Home / End, Space or P to play), autoplay for screen recording
 * (`?autoplay=1`), deep links (`?round=exit&step=clear`). Motion follows
 * `prefers-reduced-motion` (the global stylesheet shortens every transition).
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LearnMore } from "@/components/chrome/LearnMore";
import { ErrorState, NotDeployedState } from "@/components/rounds/shared";
import { Disclosure } from "@/components/ui/DetailsList";
import { Kbd } from "@/components/ui/Kbd";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { stepEvents } from "@/lib/demo/events";
import type { DemoManifest, DemoScenario } from "@/lib/demo/manifest";
import { clampStep, keyCommand, SCENARIO_LABEL, scenarioFromQuery, stepFromQuery, totalDuration, walkthrough, type WalkStep } from "@/lib/demo/walkthrough";
import { ROUTES } from "@/lib/routes";
import { LivePanel } from "./panels";
import { ChainTag, EventList, TxList } from "./records";
import { useDemoRound, type DemoLive } from "./useDemoRound";

function scenarioTitle(manifest: DemoManifest, scenario: DemoScenario): string {
  const cls = manifest.classes.find((candidate) => candidate.key === scenario.classKey);
  return `${SCENARIO_LABEL[scenario.key]} · round #${scenario.roundId}${cls ? ` · ${cls.label} on ${cls.chain}` : ""}`;
}

function chainsOf(step: WalkStep): ("near" | "base" | "solana")[] {
  return [...new Set(step.txs.map((tx) => tx.chain))];
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ["BUTTON", "A", "SUMMARY"].includes(target.tagName);
}

function writeQuery(scenario: DemoScenario, step: WalkStep | undefined, playing: boolean): void {
  const params = new URLSearchParams();
  params.set("round", scenario.key);
  if (step) params.set("step", step.id);
  if (playing) params.set("autoplay", "1");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

/** The deep-link query of the page (`?round=…&step=…&autoplay=1`), read on the server. */
export type DemoQuery = { round: string | null; step: string | null; autoplay: boolean };

export function DemoPlayer({ manifest, query }: { manifest: DemoManifest; query: DemoQuery }) {
  const [scenarioKey, setScenarioKey] = useState(() => scenarioFromQuery(manifest, query.round).key);
  const scenario = useMemo(() => manifest.scenarios.find((candidate) => candidate.key === scenarioKey) ?? scenarioFromQuery(manifest, null), [manifest, scenarioKey]);
  const steps = useMemo(() => walkthrough(manifest, scenario), [manifest, scenario]);
  const [index, setIndex] = useState(() => stepFromQuery(walkthrough(manifest, scenarioFromQuery(manifest, query.round)), query.step));
  const [playing, setPlaying] = useState(() => query.autoplay);
  const current = steps[clampStep(index, steps.length)];
  const cardRef = useRef<HTMLDivElement>(null);
  const live = useDemoRound(scenario);
  const moved = useRef(false);
  /** Steps slide in once the visitor moves; the step served with the page is painted as is. */
  const [navigated, setNavigated] = useState(false);

  const go = useCallback(
    (next: number) => {
      moved.current = true;
      setNavigated(true);
      setIndex(clampStep(next, steps.length));
    },
    [steps.length],
  );

  const chooseScenario = (key: DemoScenario["key"]) => {
    moved.current = true;
    setNavigated(true);
    setScenarioKey(key);
    setIndex(0);
  };

  useEffect(() => {
    writeQuery(scenario, current, playing);
  }, [scenario, current, playing]);

  useEffect(() => {
    if (!moved.current) return;
    const card = cardRef.current;
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    if (top < 56 || top > window.innerHeight * 0.6) {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
    }
  }, [index, scenarioKey]);

  useEffect(() => {
    if (!playing || !current) return;
    const last = index >= steps.length - 1;
    const timer = window.setTimeout(() => {
      if (last) setPlaying(false);
      else go(index + 1);
    }, current.durationMs);
    return () => window.clearTimeout(timer);
  }, [current, go, index, playing, steps.length]);

  const togglePlay = useCallback(() => {
    if (!playing && index >= steps.length - 1) go(0);
    setPlaying(!playing);
  }, [go, index, playing, steps.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      // Every modal of the app is a native <dialog> (no role attribute): an open one owns the keyboard.
      if (document.querySelector("dialog[open]")) return;
      const command = keyCommand(event.key);
      if (!command) return;
      if (command === "toggle" && event.key === " " && isControl(event.target)) return;
      event.preventDefault();
      if (command === "next") go(index + 1);
      else if (command === "prev") go(index - 1);
      else if (command === "first") go(0);
      else if (command === "last") go(steps.length - 1);
      else togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, steps.length, togglePlay]);

  if (!current) return null;

  return (
    <div className="-mb-6 flex flex-col gap-5" data-demo={scenario.key}>
      <header className="flex flex-col gap-4">
        <div>
          <h1 className="text-[22px] text-ink-50 md:text-[26px] font-semibold tracking-tight">Watch a full round</h1>
          <p className="mt-1.5 text-[13px] text-ink-400">
            <span title={`Seeded rounds of the fictional ${manifest.issuer} (${manifest.token.symbol}) on ${manifest.engine}`}>Real testnet transactions of a seeded round, one step at a time. No wallet needed.</span>{" "}
            <LearnMore topic="sealedRounds" />
          </p>
        </div>
        <div role="radiogroup" aria-label="Seeded round" className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          {manifest.scenarios.map((candidate) => {
            const active = candidate.key === scenario.key;
            return (
              <button
                key={candidate.key}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => chooseScenario(candidate.key)}
                data-demo-scenario={candidate.key}
                title={scenarioTitle(manifest, candidate).split(" · ").slice(1).join(" · ")}
                className={cn(
                  "shrink-0 rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                  active ? "border-ember-500 bg-ember-700/20 text-ember-200" : "border-ink-700 bg-ink-850 text-ink-200 hover:border-ink-500",
                )}
              >
                {SCENARIO_LABEL[candidate.key]}
              </button>
            );
          })}
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[264px_minmax(0,1fr)]">
        <nav aria-label="Steps" className="hidden lg:sticky lg:top-20 lg:block">
          <ol className="flex flex-col gap-0.5">
            {steps.map((step, position) => {
              const state = position < index ? "done" : position === index ? "active" : "upcoming";
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => go(position)}
                    aria-current={state === "active" ? "step" : undefined}
                    data-demo-step-link={step.id}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                      state === "active" ? "bg-ink-800 text-ink-50" : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
                    )}
                  >
                    <span className={cn("tabular mt-px w-5 shrink-0 text-[11px]", state === "active" ? "text-ember-300" : state === "done" ? "text-success-400" : "text-ink-400")}>{String(position + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 leading-snug">{step.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div ref={cardRef} className="flex min-w-0 scroll-mt-20 flex-col gap-4">
          <div className="flex gap-1 lg:hidden" aria-hidden>
            {steps.map((step, position) => (
              <span key={step.id} className={cn("h-1 flex-1 rounded-full", position < index ? "bg-ember-700" : position === index ? "bg-ember-400" : "bg-ink-750")} />
            ))}
          </div>
          <StepView key={`${scenario.key}:${current.id}`} animate={navigated} manifest={manifest} scenario={scenario} step={current} position={index} total={steps.length} playing={playing} live={live} />
        </div>
      </div>

      <div className="sticky bottom-0 z-30 -mx-4 border-t border-ink-750 bg-ink-950/90 backdrop-blur-md md:-mx-6" data-demo-controls>
        <div className="relative flex h-14 items-center gap-2 px-4 md:px-6">
          <Button variant="secondary" size="sm" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous step" data-demo-prev>
            ← <span className="hidden sm:inline">Previous</span>
          </Button>
          <Button size="sm" onClick={togglePlay} aria-pressed={playing} data-demo-play>
            {playing ? "Pause" : index >= steps.length - 1 ? "Replay" : "Play"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => go(index + 1)} disabled={index >= steps.length - 1} aria-label="Next step" data-demo-next>
            <span className="hidden sm:inline">Next</span> →
          </Button>
          <span className="tabular ml-1 text-[12px] text-ink-300" aria-live="polite" data-demo-counter>
            {String(index + 1)} / {String(steps.length)}
          </span>
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-ink-400 md:flex" title={`About ${String(Math.round(totalDuration(steps) / 60_000))} min on autoplay`}>
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <Kbd>Space</Kbd>
          </span>
          <ButtonLink href={`${ROUTES.rounds}/${scenario.roundId}`} variant="ghost" size="sm" className="ml-auto md:ml-2">
            Round #{scenario.roundId} live
          </ButtonLink>
          {playing ? <span key={`${scenario.key}:${current.id}`} aria-hidden className="demo-progress absolute inset-x-0 top-0 h-0.5 origin-left bg-ember-400" style={{ animationDuration: `${String(current.durationMs)}ms` }} /> : null}
        </div>
      </div>
    </div>
  );
}

type LiveQuery = ReturnType<typeof useDemoRound>;

function StepView({ animate, manifest, scenario, step, position, total, playing, live }: { animate: boolean; manifest: DemoManifest; scenario: DemoScenario; step: WalkStep; position: number; total: number; playing: boolean; live: LiveQuery }) {
  return (
    <article className={cn("flex flex-col gap-4", animate && "demo-step")} aria-labelledby="demo-step-title" data-demo-step={step.id} data-demo-playing={playing ? "true" : "false"}>
      <div className="rounded-lg border border-ink-750 bg-ink-900 px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <span className="tabular text-ember-300 font-medium">
            Step {String(position + 1)} of {String(total)}
          </span>
          {chainsOf(step).map((chain) => (
            <ChainTag key={chain} chain={chain} />
          ))}
          {step.at ? <span className="tabular ml-auto">{new Date(step.at).toISOString().replace("T", " ").slice(0, 16)} UTC</span> : <span className="ml-auto">computed in this browser</span>}
        </div>
        <h2 id="demo-step-title" className="mt-2 text-[18px] text-ink-50 md:text-[20px] font-semibold">
          {step.title}
        </h2>
        <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-ink-200">{step.body}</p>
      </div>
      <div className="flex flex-col gap-4" data-demo-live={liveStatus(live, scenario)}>
        <LiveSection manifest={manifest} scenario={scenario} step={step} live={live} />
        <OnChainRecord manifest={manifest} scenario={scenario} step={step} live={live} />
      </div>
    </article>
  );
}

/** The live read's state for the step's round: a previous round's data still on screen counts as loading. */
function liveStatus(live: LiveQuery, scenario: DemoScenario): "ok" | "loading" | "error" | "not_deployed" {
  const { state } = live;
  if (state.status === "ok") return state.value.round.roundId.toString() === scenario.roundId ? "ok" : "loading";
  return state.status;
}

function LiveSection({ manifest, scenario, step, live }: { manifest: DemoManifest; scenario: DemoScenario; step: WalkStep; live: LiveQuery }) {
  const { state, retry } = live;
  const stale = state.status === "ok" && state.value.round.roundId.toString() !== scenario.roundId;
  if (state.status === "loading" || stale) {
    return (
      <div className="flex flex-col gap-3" aria-busy>
        <Skeleton className="h-36 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }
  if (state.status === "not_deployed") return <NotDeployedState detail={state.detail} />;
  if (state.status === "error") {
    return (
      <div className="ui-surface rounded-lg">
        <ErrorState message={`${state.message} The transactions below stay verifiable on their explorers.`} onRetry={retry} />
      </div>
    );
  }
  return <LiveContent manifest={manifest} scenario={scenario} step={step} live={state.value} />;
}

/**
 * The step's proof, one click away: the engine history entries it wrote and the transactions on
 * their explorers, collapsed under one line that counts them.
 */
function OnChainRecord({ manifest, scenario, step, live }: { manifest: DemoManifest; scenario: DemoScenario; step: WalkStep; live: LiveQuery }) {
  const value = live.state.status === "ok" && live.state.value.round.roundId.toString() === scenario.roundId ? live.state.value : null;
  const events = useMemo(() => (value ? stepEvents(manifest, scenario, step, value.events, value.round.venue === "Near") : []), [value, manifest, scenario, step]);
  const showsEvents = value !== null && step.id !== "verify" && step.id !== "custody";
  if (!showsEvents && step.txs.length === 0) return null;
  const counts = [showsEvents ? `${String(events.length)} engine event${events.length === 1 ? "" : "s"}` : null, step.txs.length > 0 ? `${String(step.txs.length)} transaction${step.txs.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  return (
    <Disclosure summary={`On-chain record · ${counts}`}>
      <div className="flex flex-col gap-4" data-demo-record>
        {showsEvents && value ? (
          <EventList
            events={events}
            decimals={value.cls.decimals}
            classId={value.cls.classId}
            emptyHint={value.skippedEvents > 0 ? `No readable history entry for this step (${String(value.skippedEvents)} entries of this staging engine cannot be decoded).` : "The engine's history holds no entry for this step: it records rounds, deposits and payouts, not every foreign-chain transaction."}
          />
        ) : null}
        {step.txs.length > 0 ? <TxList txs={step.txs} /> : null}
      </div>
    </Disclosure>
  );
}

function LiveContent({ manifest, scenario, step, live }: { manifest: DemoManifest; scenario: DemoScenario; step: WalkStep; live: DemoLive }) {
  return (
    <div className="flex flex-col gap-4 empty:hidden">
      <LivePanel manifest={manifest} scenario={scenario} step={step} live={live} />
      {step.id === "verify" ? (
        <p className="text-[12px] text-ink-400">
          The same check runs on every settled round page.{" "}
          <Link href={`${ROUTES.rounds}/${scenario.roundId}`} className="text-ember-300 underline-offset-2 hover:underline">
            Open round #{scenario.roundId}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
