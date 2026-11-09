import { JOINTS } from "@/lib/voxel/dragon";

/**
 * Scroll timeline of the landing sequence (spec 8.2). `sequenceAt(progress)` maps the progress of
 * the pinned section (0 at the top, 1 at the end, already smoothed by a spring) to every animated
 * quantity, so the scene stays a pure function of progress plus a time-based idle layer.
 *
 * The story: the dragon sleeps, small, under the phrase; the camera closes in until it fills its
 * final size; it wakes slowly (eyes, breath, the neck rising in an arc, the wings unfolding in two
 * beats), draws a breath and breathes fire upward in two left-to-right sweeps across the phrase,
 * which grows, rises, cracks and shatters; then it falls back asleep and the camera pulls back
 * until it is small in the dark again.
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

export type Ease = (t: number) => number;

/** Easing curves on [0, 1]. */
export const EASE = {
  linear: (t: number) => t,
  inOutSine: (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  /** Smootherstep: zero velocity and acceleration at both ends, for the weightiest moves. */
  inOutQuint: (t: number) => t * t * t * (t * (6 * t - 15) + 10),
} satisfies Record<string, Ease>;

/** A key of a channel: at `at`, the value is `value`, reached from the previous key with `ease`. */
export type Key = readonly [at: number, value: number, ease?: Ease];

/** Piecewise eased interpolation through `keys` (sorted by `at`); holds the end values outside. */
export function keyframes(keys: readonly Key[], progress: number): number {
  const first = keys[0]!;
  if (progress <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i += 1) {
    const [at, value, ease = EASE.inOutSine] = keys[i]!;
    if (progress < at) {
      const [from, start] = keys[i - 1]!;
      return lerp(start, value, ease((progress - from) / (at - from)));
    }
  }
  return keys[keys.length - 1]![1];
}

/** One left-to-right pass of the fire across the phrase. */
export type Sweep = { start: number; end: number };

export const SWEEPS: readonly Sweep[] = [
  { start: 0.45, end: 0.58 },
  { start: 0.61, end: 0.74 },
];

export const PHASES = {
  /** The camera closes in from the small sleeping dragon to its full size. */
  dolly: [0.02, 0.24],
  /** Overall wake (light, breath, smoke); the body parts follow their own staged keys. */
  wake: [0.19, 0.4],
  /** The neck rises joint by joint, from the first joint of its base starting to its last one done. */
  rise: [0.22, 0.365],
  /** The held breath before the first sweep. */
  inhale: [0.37, 0.48],
  phrase: [0.3, 0.86],
  shatter: [0.66, 0.86],
  sleep: [0.76, 0.9],
  /** The neck sinks joint by joint, the head first and the base last. */
  lower: [0.77, 0.9],
  smoke: [0.8, 0.94],
  retreat: [0.8, 0.98],
  launchReady: 0.96,
} as const;

/** Delay (in progress) between the first and the last neck joint to move as the neck rises or sinks. */
const NECK_STAGGER = 0.065;

const EYELID: readonly Key[] = [
  [0.19, 0],
  [0.225, 0.4, EASE.inOutSine],
  [0.245, 0.28, EASE.inOutSine],
  [0.3, 1, EASE.inOutCubic],
  [0.8, 1],
  [0.835, 0.3, EASE.inOutSine],
  [0.85, 0.48, EASE.inOutSine],
  [0.895, 0, EASE.inOutCubic],
];

/** Far wing: a first lift, a held beat, the full spread with a slight overshoot, then the same folding in two beats. */
const WING_FOLD: readonly Key[] = [
  [0.24, 1],
  [0.29, 0.7, EASE.outCubic],
  [0.31, 0.67, EASE.linear],
  [0.37, -0.07, EASE.inOutCubic],
  [0.405, 0, EASE.inOutSine],
  [0.775, 0],
  [0.815, 0.45, EASE.inOutCubic],
  [0.83, 0.42, EASE.inOutSine],
  [0.885, 1.04, EASE.inOutCubic],
  [0.905, 1, EASE.inOutSine],
];

const INHALE: readonly Key[] = [
  [PHASES.inhale[0], 0],
  [0.42, 1, EASE.inOutSine],
  [0.44, 1, EASE.linear],
  [PHASES.inhale[1], 0, EASE.inOutSine],
];

/** How much the head turns toward the jet target, from the inhale to the start of the sleep. */
const FOCUS: readonly Key[] = [
  [0.36, 0],
  [0.43, 1, EASE.inOutSine],
  [0.76, 1],
  [0.8, 0, EASE.inOutSine],
];

export type SequenceState = {
  /** Camera move from the opening frame (0) to the dragon at full size (1). */
  dolly: number;
  /** Camera move from the full size (0) to the final wide frame, the dragon small (1). */
  retreat: number;
  /** Overall wakefulness: 0 asleep, 1 awake (the final sleep is `sleep`). */
  wake: number;
  /** Overall return to sleep. */
  sleep: number;
  /** Per neck joint, from the base: 0 lying down, 1 raised. */
  neck: readonly number[];
  /** Far wing, 0 spread (slightly below 0 at the overshoot) to 1 folded. */
  wingFold: number;
  /** The held breath before the fire: chest swollen, head drawn back. */
  inhale: number;
  /** How much the head turns toward the jet target. */
  focus: number;
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

/** Raised share of each neck joint: the base leads on the way up, the head leads on the way down. */
function neckAt(progress: number): number[] {
  const last = JOINTS.length - 1;
  const [riseStart, riseEnd] = PHASES.rise;
  const [lowerStart, lowerEnd] = PHASES.lower;
  return JOINTS.map((_, i) => {
    const up = riseStart + (NECK_STAGGER * i) / last;
    const down = lowerStart + (NECK_STAGGER * (last - i)) / last;
    const raised = EASE.inOutQuint(clamp01((progress - up) / (riseEnd - riseStart - NECK_STAGGER)));
    const lowered = EASE.inOutQuint(clamp01((progress - down) / (lowerEnd - lowerStart - NECK_STAGGER)));
    return raised * (1 - lowered);
  });
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
  else if (progress >= first.end) aim = 1 - EASE.inOutSine(clamp01((progress - first.end) / (second.start - first.end)));
  else aim = cracks[0];

  const wake = EASE.inOutQuint(clamp01((progress - PHASES.wake[0]) / (PHASES.wake[1] - PHASES.wake[0])));
  const sleep = EASE.inOutQuint(clamp01((progress - PHASES.sleep[0]) / (PHASES.sleep[1] - PHASES.sleep[0])));
  const smokePhase = smoothstep(PHASES.smoke[0], PHASES.smoke[1], progress);
  const rose = clamp01(0.25 + 0.75 * smoothstep(0.7, 1, cracks[0]));

  return {
    dolly: EASE.inOutQuint(clamp01((progress - PHASES.dolly[0]) / (PHASES.dolly[1] - PHASES.dolly[0]))),
    retreat: EASE.inOutQuint(clamp01((progress - PHASES.retreat[0]) / (PHASES.retreat[1] - PHASES.retreat[0]))),
    wake,
    sleep,
    neck: neckAt(progress),
    wingFold: keyframes(WING_FOLD, progress),
    inhale: keyframes(INHALE, progress),
    focus: keyframes(FOCUS, progress),
    light: lerp(lerp(0.4, 1, wake), 0.75, sleep),
    eyes: smoothstep(0.19, 0.31, progress),
    eyelid: keyframes(EYELID, progress),
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
