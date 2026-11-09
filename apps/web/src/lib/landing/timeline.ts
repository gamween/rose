/**
 * Scroll timeline of the landing sequence (spec 8.2). `sequenceAt(progress)` maps the scroll
 * progress of the pinned section (0 at the top, 1 at the end) to every animated quantity, so the
 * scene stays a pure function of scroll plus a time-based idle layer.
 *
 * The story: the dragon sleeps at the bottom of a black frame under the phrase; the camera closes
 * in, the dragon wakes and breathes fire upward in two left-to-right sweeps across the phrase,
 * which grows, rises, cracks and shatters; then the dragon falls back asleep and the camera pulls
 * back until it is small in the dark.
 */

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** One left-to-right pass of the fire across the phrase. */
export type Sweep = { start: number; end: number };

export const SWEEPS: readonly Sweep[] = [
  { start: 0.36, end: 0.52 },
  { start: 0.56, end: 0.72 },
];

export const PHASES = {
  dolly: [0.02, 0.3],
  wake: [0.22, 0.35],
  phrase: [0.26, 0.86],
  shatter: [0.62, 0.86],
  sleep: [0.74, 0.86],
  eyesClose: [0.76, 0.84],
  smoke: [0.78, 0.9],
  retreat: [0.74, 0.97],
  launchReady: 0.94,
} as const;

export type SequenceState = {
  /** Camera move from the opening frame (0) to the close-up on the dragon (1). */
  dolly: number;
  /** Camera move from the close-up (0) to the final wide frame, the dragon small (1). */
  retreat: number;
  /** Head raised, wings spread: 0 asleep, 1 awake (the final sleep is `sleep`). */
  wake: number;
  /** Head lowered again, wings folded, for the final sleep. */
  sleep: number;
  /** Light level on the dragon: dim asleep, full awake. */
  light: number;
  /** Eye glow. */
  eyes: number;
  /** Eyelid opening, 1 open, 0 closed (asleep). */
  eyelid: number;
  /** Fire emission intensity, 0 between and outside the sweeps. */
  fire: number;
  /** Aim of the jet across the phrase: 0 its left end, 1 its right end. */
  aim: number;
  /** Index of the sweep in progress, or -1. */
  sweep: number;
  /** How far each sweep has travelled across the phrase (0..1, monotonic). */
  cracks: readonly [number, number];
  /** The phrase grows and rises (0..1). */
  phrase: number;
  /** The cracked phrase breaks into falling, burning chunks (0..1, gone at 1). */
  shatter: number;
  /** Glow of the letters of "rose", from smoldering to blazing. */
  rose: number;
  /** Smoke drifting from the nostrils. */
  smoke: number;
  /** Glow of the tail tip. */
  tail: number;
  /** The Launch app button may be revealed by hovering the dragon. */
  launchReady: boolean;
};

function sweepTime(sweep: Sweep, progress: number): number {
  return clamp01((progress - sweep.start) / (sweep.end - sweep.start));
}

/** Jet position along a sweep: eased in and out so the flame lingers at both ends of the phrase. */
function sweepAim(t: number): number {
  const u = clamp01((t - 0.05) / 0.9);
  return 0.5 - 0.5 * Math.cos(Math.PI * u);
}

function sweepEnvelope(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  return smoothstep(0, 0.1, t) * (1 - smoothstep(0.9, 1, t));
}

export function sequenceAt(rawProgress: number): SequenceState {
  const progress = clamp01(rawProgress);
  const [first, second] = [SWEEPS[0]!, SWEEPS[1]!];

  let fire = 0;
  let sweep = -1;
  SWEEPS.forEach((candidate, index) => {
    const envelope = sweepEnvelope(sweepTime(candidate, progress));
    if (envelope > 0) {
      fire = envelope;
      sweep = index;
    }
  });
  const cracks: [number, number] = [sweepAim(sweepTime(first, progress)), sweepAim(sweepTime(second, progress))];

  // The head waits on the left before each pass, then swings back between the two passes.
  let aim = 0;
  if (progress >= second.start) aim = cracks[1];
  else if (progress >= first.end) aim = 1 - smoothstep(first.end, second.start, progress);
  else aim = cracks[0];

  const wake = smoothstep(PHASES.wake[0], PHASES.wake[1], progress);
  const sleep = smoothstep(PHASES.sleep[0], PHASES.sleep[1], progress);
  const smokePhase = smoothstep(PHASES.smoke[0], PHASES.smoke[1], progress);
  const rose = clamp01(0.25 + 0.75 * smoothstep(0.7, 1, cracks[0]));

  return {
    dolly: smoothstep(PHASES.dolly[0], PHASES.dolly[1], progress),
    retreat: smoothstep(PHASES.retreat[0], PHASES.retreat[1], progress),
    wake,
    sleep,
    light: lerp(lerp(0.4, 1, wake), 0.75, sleep),
    eyes: wake,
    eyelid: wake * (1 - smoothstep(PHASES.eyesClose[0], PHASES.eyesClose[1], progress)),
    fire,
    aim,
    sweep,
    cracks,
    phrase: smoothstep(PHASES.phrase[0], PHASES.phrase[1], progress),
    shatter: clamp01((progress - PHASES.shatter[0]) / (PHASES.shatter[1] - PHASES.shatter[0])),
    rose,
    smoke: lerp(lerp(0.35, 0, wake), 1, smokePhase),
    tail: lerp(lerp(0.45, 0.25, wake), 1, sleep),
    launchReady: progress >= PHASES.launchReady,
  };
}
