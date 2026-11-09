/**
 * Scroll timeline of the landing sequence (spec 8.2). `sequenceAt(progress)` maps the progress of
 * the pinned section (0 at the top, 1 at the end, already smoothed by a spring) to every animated
 * quantity, so the scene stays a pure function of progress plus a time-based idle layer.
 *
 * The story: the dragon sleeps, small, curled into a ball under the phrase; the camera closes in
 * until it fills its final size; it wakes slowly (eyes, breath, the neck uncurling and rising),
 * rears up on its hind legs while its wings unfold in two beats into a full spread, coils back
 * drawing its breath and drives one long, hard jet of fire upward with its whole body, sweeping
 * twice from left to right across the phrase, which cracks and rises until it has left the screen
 * through the top. Then the fire stops, the dragon calms down, folds its wings in stages, lowers
 * itself onto all fours, curls back into its ball and falls asleep, and the camera pulls back
 * until it is small in the dark again.
 *
 * The body channels (`bodyAt`) are sampled by the scene a little later for each bone further from
 * the hips, so every move travels along the spine as a wave, from the hips up the neck to the head
 * and down the tail, and overshoots settle bone after bone.
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
  inQuad: (t: number) => t * t,
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

/** One left-to-right pass of the jet across the phrase, inside the one sustained breath. */
export type Sweep = { start: number; end: number };

export const SWEEPS: readonly Sweep[] = [
  { start: 0.48, end: 0.565 },
  { start: 0.595, end: 0.68 },
];

export const PHASES = {
  /** The camera closes in from the small sleeping dragon to its full size. */
  dolly: [0.02, 0.2],
  /** Overall wake (light, breath, smoke); the body parts follow their own staged keys. */
  wake: [0.17, 0.32],
  /** The dragon uncurls and raises its neck, still lying. */
  rise: [0.19, 0.3],
  /** The dragon rears up onto its hind legs, the camera easing back to keep it whole. */
  stand: [0.26, 0.385],
  /** The held breath before the fire. */
  inhale: [0.395, 0.488],
  /** The one sustained breath of fire, from its first flame to its last. */
  breath: [0.46, 0.72],
  /** The phrase rises with the dragon, then the fire pushes it up and out through the top. */
  phrase: [0.2, 0.69],
  /** The dragon lowers itself back onto all fours. */
  lower: [0.785, 0.875],
  sleep: [0.82, 0.92],
  /** The neck lowers and the dragon curls back into its ball. */
  curl: [0.795, 0.905],
  smoke: [0.82, 0.95],
  retreat: [0.88, 0.985],
  launchReady: 0.97,
} as const;

/** Delay (in progress) of each bone of the spine behind the previous one, counting from the hips. */
export const SPINE_LAG = 0.0045;

const EYELID: readonly Key[] = [
  [0.17, 0],
  [0.205, 0.4, EASE.inOutSine],
  [0.225, 0.28, EASE.inOutSine],
  [0.28, 1, EASE.inOutCubic],
  [0.86, 1],
  [0.89, 0.3, EASE.inOutSine],
  [0.902, 0.48, EASE.inOutSine],
  [0.93, 0, EASE.inOutSine],
];

const RISE: readonly Key[] = [
  [PHASES.rise[0], 0],
  [PHASES.rise[1], 1, EASE.inOutQuint],
  [PHASES.curl[0], 1],
  [PHASES.curl[1], 0, EASE.inOutQuint],
];

/** Rearing up, past the full height and settling back (the follow-through travels up the neck). */
const STAND: readonly Key[] = [
  [PHASES.stand[0], 0],
  [PHASES.stand[1], 1.05, EASE.inOutQuint],
  [0.415, 1, EASE.inOutSine],
  [PHASES.lower[0], 1],
  [PHASES.lower[1], 0, EASE.inOutQuint],
];

/** Drawing the breath: the body coils back, chest out, neck drawn into an S, head up. */
const COIL: readonly Key[] = [
  [0.395, 0],
  [0.44, 1, EASE.inOutSine],
  [0.45, 1, EASE.linear],
  [0.49, 0, EASE.inOutSine],
];

/** The fire comes out: the whole body recoils forward into the jet, shoulders, neck and head driving it, and holds there. */
const THRUST: readonly Key[] = [
  [0.445, 0],
  [0.49, 1.1, EASE.inOutSine],
  [0.51, 1, EASE.inOutSine],
  [0.69, 1],
  [0.745, 0, EASE.inOutSine],
];

/**
 * As the dragon uncurls, the camera eases from the close-up on the sleeping ball to the frame that
 * holds it whole standing, wings spread, and lying back down; it pulls back from there.
 */
const FRAME: readonly Key[] = [
  [0.2, 0],
  [0.36, 1, EASE.inOutQuint],
];

/**
 * Wings: they lift off the flanks, hold a beat, then rise to their full height with a slight
 * overshoot; after the fire they lower in two beats as the dragon settles.
 */
const WING_FOLD: readonly Key[] = [
  [0.29, 1],
  [0.325, 0.62, EASE.outCubic],
  [0.345, 0.6, EASE.linear],
  [0.4, -0.06, EASE.inOutCubic],
  [0.43, 0, EASE.inOutSine],
  [0.725, 0],
  [0.755, 0.22, EASE.inOutCubic],
  [0.765, 0.24, EASE.linear],
  [0.8, 0.62, EASE.inOutCubic],
  [0.812, 0.6, EASE.inOutSine],
  [0.86, 1.03, EASE.inOutCubic],
  [0.88, 1, EASE.inOutSine],
];

/** Membranes: they open a little with the first lift, then spread wide; they furl in stages after the fire. */
const WING_SPREAD: readonly Key[] = [
  [0.31, 0],
  [0.33, 0.15, EASE.outCubic],
  [0.35, 0.16, EASE.linear],
  [0.415, 1.06, EASE.inOutSine],
  [0.44, 1, EASE.inOutSine],
  [0.72, 1],
  [0.755, 0.55, EASE.inOutCubic],
  [0.768, 0.5, EASE.linear],
  [0.8, 0.12, EASE.inOutCubic],
  [0.84, 0, EASE.inOutCubic],
];

const INHALE: readonly Key[] = [
  [PHASES.inhale[0], 0],
  [0.44, 1, EASE.inOutSine],
  [0.447, 1, EASE.linear],
  [PHASES.inhale[1], 0, EASE.inOutSine],
];

/**
 * Fire intensity: it bursts out, holds hard (only easing a little while the head swings back to
 * the left between the two sweeps) until the phrase has left the screen, then dies down.
 */
const BREATH: readonly Key[] = [
  [PHASES.breath[0], 0],
  [0.477, 1, EASE.inOutSine],
  [0.565, 1],
  [0.58, 0.82, EASE.inOutSine],
  [0.595, 1, EASE.inOutSine],
  [0.695, 1],
  [PHASES.breath[1], 0, EASE.inOutSine],
];

/**
 * The phrase's rise, 0 at rest and 1 once its lowest pixel has passed the top of the screen: it
 * lifts a little as the dragon rears, then the jet drives it up, faster and faster.
 */
const PHRASE: readonly Key[] = [
  [PHASES.phrase[0], 0],
  [0.37, 0.3, EASE.inOutSine],
  [0.475, 0.34, EASE.linear],
  [PHASES.phrase[1], 1, EASE.inQuad],
];

/** How much the head turns toward the jet target: from before the breath until the fire has died. */
const FOCUS: readonly Key[] = [
  [0.39, 0],
  [0.44, 1, EASE.inOutSine],
  [0.705, 1],
  [0.75, 0, EASE.inOutSine],
];

/** Deep, slow breaths after the fire, settling as the dragon lies down. */
const HEAVE: readonly Key[] = [
  [0.695, 0],
  [0.74, 1, EASE.inOutSine],
  [0.85, 0, EASE.inOutSine],
];

/** The channels of the body, sampled per bone with a lag (see `SPINE_LAG`). */
export type BodyState = {
  /** 0 curled asleep, 1 uncurled with the neck raised. */
  rise: number;
  /** 0 lying, 1 rearing on the hind legs (slightly above 1 at the overshoot). */
  stand: number;
  /** The coil back before the breath. */
  coil: number;
  /** The push forward into the jet. */
  thrust: number;
};

export function bodyAt(rawProgress: number): BodyState {
  const progress = clamp01(rawProgress);
  return { rise: keyframes(RISE, progress), stand: keyframes(STAND, progress), coil: keyframes(COIL, progress), thrust: keyframes(THRUST, progress) };
}

export type SequenceState = BodyState & {
  /** Camera move from the opening frame (0) to the dragon at full size (1). */
  dolly: number;
  /** Camera move from the full size (0) to the frame of the standing dragon (1). */
  frame: number;
  /** Camera move from the full size (0) to the final wide frame, the dragon small (1). */
  retreat: number;
  /** Overall wakefulness: 0 asleep, 1 awake (the final sleep is `sleep`). */
  wake: number;
  /** Overall return to sleep. */
  sleep: number;
  /** Wings, 0 raised to 1 folded on the flanks (slightly below 0 at the overshoot). */
  wingFold: number;
  /** Wing membranes, 0 furled to 1 spread (slightly above 1 at the overshoot). */
  wingSpread: number;
  /** The held breath before the fire: chest swollen, head drawn back. */
  inhale: number;
  /** Deep breaths after the fire. */
  heave: number;
  /** How much the head turns toward the jet target. */
  focus: number;
  /** Light level on the dragon: dim asleep, full awake. */
  light: number;
  /** Eye glow. */
  eyes: number;
  /** Eyelid opening, 1 open, 0 closed (asleep). */
  eyelid: number;
  /** Fire emission intensity. */
  fire: number;
  /** Aim of the jet across the phrase: 0 its left end, 1 its right end. */
  aim: number;
  /** Index of the sweep in progress, or -1. */
  sweep: number;
  /** How far each sweep has travelled across the phrase (0..1, monotonic). */
  cracks: readonly [number, number];
  /** Rise of the phrase: 0 at rest, 1 once it has left the screen through the top. */
  phrase: number;
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

export function sequenceAt(rawProgress: number): SequenceState {
  const progress = clamp01(rawProgress);
  const [first, second] = [SWEEPS[0]!, SWEEPS[1]!];

  const sweep = SWEEPS.findIndex((candidate) => progress > candidate.start && progress < candidate.end);
  const cracks: [number, number] = [sweepAim(sweepTime(first, progress)), sweepAim(sweepTime(second, progress))];

  // The head waits on the left before each pass and swings back between them, the fire still
  // pouring; after the second pass it comes back to the middle as the last letters leave.
  let aim = cracks[0];
  if (progress >= second.end) aim = 1 - 0.5 * EASE.inOutSine(clamp01((progress - second.end) / 0.02));
  else if (progress >= second.start) aim = cracks[1];
  else if (progress >= first.end) aim = 1 - EASE.inOutSine(clamp01((progress - first.end) / (second.start - first.end)));

  const wake = EASE.inOutQuint(clamp01((progress - PHASES.wake[0]) / (PHASES.wake[1] - PHASES.wake[0])));
  const sleep = EASE.inOutQuint(clamp01((progress - PHASES.sleep[0]) / (PHASES.sleep[1] - PHASES.sleep[0])));
  const smokePhase = smoothstep(PHASES.smoke[0], PHASES.smoke[1], progress);
  const rose = clamp01(0.25 + 0.75 * smoothstep(0.7, 1, cracks[0]));

  return {
    dolly: EASE.inOutQuint(clamp01((progress - PHASES.dolly[0]) / (PHASES.dolly[1] - PHASES.dolly[0]))),
    frame: keyframes(FRAME, progress),
    retreat: EASE.inOutQuint(clamp01((progress - PHASES.retreat[0]) / (PHASES.retreat[1] - PHASES.retreat[0]))),
    wake,
    sleep,
    ...bodyAt(progress),
    wingFold: keyframes(WING_FOLD, progress),
    wingSpread: keyframes(WING_SPREAD, progress),
    inhale: keyframes(INHALE, progress),
    heave: keyframes(HEAVE, progress),
    focus: keyframes(FOCUS, progress),
    light: lerp(lerp(0.4, 1, wake), 0.75, sleep),
    eyes: smoothstep(0.17, 0.29, progress),
    eyelid: keyframes(EYELID, progress),
    fire: keyframes(BREATH, progress),
    aim,
    sweep,
    cracks,
    phrase: keyframes(PHRASE, progress),
    rose,
    smoke: lerp(lerp(0.35, 0, wake), 1, smokePhase),
    tail: lerp(lerp(0.45, 0.25, wake), 1, sleep),
    launchReady: progress >= PHASES.launchReady,
  };
}
