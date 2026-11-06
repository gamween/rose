"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { QUALITY_TIERS, initialTierIndex } from "@/lib/landing/quality";
import { ROUTES } from "@/lib/routes";
import { SITE_TAGLINE } from "@/lib/site";
import type { HitTarget, LandingScene, SceneStats } from "./scene/scene";

type Mode = "poster" | "live" | "static" | "fallback";

function readGpuRenderer(): string | null {
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  if (!gl) return null;
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return typeof renderer === "string" ? renderer : "";
}

function forcedTierFrom(search: URLSearchParams): number | null {
  const name = search.get("quality");
  const index = QUALITY_TIERS.findIndex((tier) => tier.name === name);
  return index >= 0 ? index : null;
}

/**
 * The pinned scroll sequence of the landing (spec 8.2). The WebGL scene is loaded with a dynamic
 * import after hydration, so the initial landing bundle only contains this shell.
 *
 * Developer tools, available on any deployment:
 * - `?fps` shows a frame-rate readout (fps, frame time, quality tier, live particles).
 * - `?quality=ultra|high|medium|low` pins a quality tier and disables adaptation.
 */
export function LandingSequence() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<Mode>("poster");
  const [reveal, setReveal] = useState(false);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [showFps, setShowFps] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!section || !stage || !canvas) return;

    let disposed = false;
    let scene: LandingScene | null = null;
    let launchReady = false;
    let hideTimer = 0;
    const cleanups: (() => void)[] = [];
    const search = new URLSearchParams(window.location.search);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wantsFps = search.has("fps");

    const renderer = readGpuRenderer();
    if (renderer === null) {
      queueMicrotask(() => setMode("fallback"));
      return;
    }

    const updateProgress = () => {
      const rect = section.getBoundingClientRect();
      const scrollable = section.offsetHeight - window.innerHeight;
      const progress = scrollable > 0 ? Math.min(1, Math.max(0, -rect.top / scrollable)) : 1;
      stage.style.setProperty("--progress", progress.toFixed(4));
      scene?.setProgress(progress);
    };

    const start = async () => {
      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-departure").trim() || "monospace";
      await document.fonts.load(`11px ${family}`).catch(() => undefined);
      const { createLandingScene } = await import("./scene/scene");
      if (disposed) return;
      const forcedTier = forcedTierFrom(search);
      try {
        scene = await createLandingScene({
          canvas,
          fontFamily: family,
          staticFrame: reducedMotion,
          forcedTier,
          initialTier: initialTierIndex({
            renderer,
            hardwareConcurrency: navigator.hardwareConcurrency ?? null,
            coarsePointer: window.matchMedia("(pointer: coarse)").matches,
            saveData: Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData),
          }),
          onStats: wantsFps ? setStats : undefined,
          onFrame: ({ tail, launchReady: ready }) => {
            launchReady = ready;
            stage.dataset.ready = ready ? "true" : "false";
            stage.style.setProperty("--tail-x", `${tail.x.toFixed(1)}px`);
            stage.style.setProperty("--tail-y", `${tail.y.toFixed(1)}px`);
          },
          onContextLost: () => setMode("fallback"),
        });
      } catch {
        setMode("fallback");
        return;
      }
      if (disposed) {
        scene.dispose();
        return;
      }
      const rect = stage.getBoundingClientRect();
      scene.resize(rect.width, rect.height);
      // A failed precompile only means the first frame compiles the programs itself.
      if (!reducedMotion) await scene.prepare().catch(() => undefined);
      if (disposed) return;
      updateProgress();
      setShowFps(wantsFps);
      setMode(reducedMotion ? "static" : "live");

      const resizeObserver = new ResizeObserver(([entry]) => {
        if (entry) scene?.resize(entry.contentRect.width, entry.contentRect.height);
      });
      resizeObserver.observe(stage);
      cleanups.push(() => resizeObserver.disconnect());
      if (reducedMotion) return;

      let visible = true;
      const sync = () => (visible && document.visibilityState === "visible" ? scene?.start() : scene?.stop());
      const intersection = new IntersectionObserver(([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        sync();
      });
      intersection.observe(section);
      document.addEventListener("visibilitychange", sync);
      window.addEventListener("scroll", updateProgress, { passive: true });
      cleanups.push(() => {
        intersection.disconnect();
        document.removeEventListener("visibilitychange", sync);
        window.removeEventListener("scroll", updateProgress);
      });
      sync();

      const onPointerMove = (event: PointerEvent) => {
        if (!scene || event.pointerType === "touch") return;
        const bounds = stage.getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;
        scene.setPointer((x / bounds.width) * 2 - 1, (y / bounds.height) * 2 - 1);
        const hit: HitTarget = scene.hitTest(x, y);
        const overButton = (event.target as Element | null)?.closest?.("[data-launch]") !== null;
        if (launchReady && (hit !== null || overButton)) {
          window.clearTimeout(hideTimer);
          stage.style.cursor = hit === null ? "" : "pointer";
          setReveal(true);
        } else {
          stage.style.cursor = "";
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(() => setReveal(false), 450);
        }
      };
      stage.addEventListener("pointermove", onPointerMove);
      cleanups.push(() => stage.removeEventListener("pointermove", onPointerMove));
    };

    void start();
    return () => {
      disposed = true;
      window.clearTimeout(hideTimer);
      cleanups.forEach((cleanup) => cleanup());
      scene?.dispose();
    };
  }, []);

  const phraseVisible = mode !== "live";

  return (
    <section ref={sectionRef} aria-labelledby="landing-phrase" className="relative h-[400vh] motion-reduce:h-svh" data-landing>
      <div
        ref={stageRef}
        data-mode={mode}
        data-reveal={reveal}
        className="landing-stage sticky top-0 h-svh w-full overflow-hidden bg-black"
      >
        <canvas
          ref={canvasRef}
          aria-hidden
          className={`pixelated absolute inset-0 size-full transition-opacity duration-700 ${mode === "live" || mode === "static" ? "opacity-100" : "opacity-0"}`}
        />
        <h1
          id="landing-phrase"
          className={
            phraseVisible
              ? `landing-phrase pointer-events-none absolute inset-x-4 text-center font-display leading-none tracking-tight ${mode === "static" ? "top-[20%] text-ink-100" : "top-1/2 -translate-y-1/2 text-ink-800"} text-[clamp(28px,6vw,72px)]`
              : "sr-only"
          }
        >
          What was locked, <span className={mode === "static" ? "text-ember-400" : "text-rose-600"}>rose.</span>
        </h1>
        <p className="sr-only">{SITE_TAGLINE} Scroll to wake the dragon.</p>
        {mode === "live" ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-8 flex flex-col items-center gap-2 font-display text-[11px] uppercase tracking-[0.2em] text-ink-400"
            style={{ opacity: "calc(1 - var(--progress, 0) * 25)" }}
          >
            Scroll
            <svg viewBox="0 0 5 3" width="10" height="6" shapeRendering="crispEdges">
              <path d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 1h1v1H3zM4 0h1v1H4z" fill="currentColor" />
            </svg>
          </div>
        ) : null}
        {mode === "live" ? (
          <p aria-hidden className="launch-hint" data-launch-hint>
            Hover the dragon to launch the app
          </p>
        ) : null}
        <Link href={ROUTES.app} data-launch className="launch-app">
          Launch app
          <span aria-hidden className="launch-app-arrow">
            →
          </span>
        </Link>
        {showFps && stats ? (
          <output className="tabular absolute left-3 top-16 z-10 rounded-sm border border-ink-700 bg-ink-950/85 px-2 py-1 text-[11px] text-ember-300">
            {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(1)} ms · {stats.tier} · {stats.particles} p
          </output>
        ) : null}
      </div>
      <noscript>
        <style>{`.launch-app{opacity:1!important;pointer-events:auto!important}`}</style>
      </noscript>
    </section>
  );
}
