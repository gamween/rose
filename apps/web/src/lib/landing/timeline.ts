/**
 * Scroll timeline of the landing sequence (spec 8.2). `sequenceAt(progress)` maps the progress of
 * the pinned section (0 at the top, 1 at the end, already smoothed by a spring) to every animated
 * quantity, so the scene stays a pure function of progress plus a time-based idle layer.
 *
 * The story: the screen is dark under the phrase, the camera already close; the first scroll opens a
 * single eye in the dark, then the light comes up on the dragon, asleep, curled into a ball; it
 * wakes (breath, the neck uncurling and rising) and rears up on its hind legs while its wings
 * unfold in two beats into a full spread; as it reaches the top it drives one long jet of fire
 * upward with its whole body, swings to the left and sweeps twice from left to right across the
 * phrase, the second pass far stronger than the first, so the phrase cracks and rises until it has
 * left the screen through the top. The fire stops as the second pass reaches the right end and, in
 * the same motion, the dragon lowers itself onto all fours folding its wings, lies down stretched
 * out, its head resting on the ground ahead of it, and falls asleep, smoke drifting from its
 * nostrils, while the camera closes in on it for a large, detailed last shot. From the moment the
 * light comes up on it until the end, a faint aura of ember dots glows around the dragon.
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
  /** Moves from the first instant (no dead start) and settles at the end. */
  outSine: (t: number) => Math.sin((Math.PI / 2) * t),
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
  { start: 0.43, end: 0.52 },
  { start: 0.55, end: 0.65 },
];

export const PHASES = {
  /** After the eye has opened, the light comes up on the whole dragon. */
  reveal: [0.03, 0.17],
  /** With it, a faint aura of ember dots lights up around the dragon, and stays until the end. */
  aura: [0.05, 0.2],
  /** Overall wake (light, breath, smoke); the body parts follow their own staged keys. */
  wake: [0.17, 0.32],
  /** The dragon uncurls and raises its neck, still lying. */
  rise: [0.19, 0.3],
  /** The dragon rears up onto its hind legs, the camera easing back to keep it whole. */
  stand: [0.26, 0.385],
  /** The one sustained breath of fire, from its first flame (as the dragon reaches its full height) to its last. */
  breath: [0.37, 0.65],
  /** The phrase rises with the dragon, then the fire pushes it up and out through the top. */
  phrase: [0.2, 0.635],
  /** As the fire stops, the dragon lowers itself back onto all fours. */
  lower: [0.645, 0.745],
  sleep: [0.7, 0.8],
  /** The neck comes down and the dragon settles into its resting pose, stretched out. */
  rest: [0.68, 0.8],
  smoke: [0.7, 0.88],
  /** The camera closes in on the resting dragon. */
  close: [0.76, 0.95],
  launchReady: 0.95,
} as const;

/** Delay (in progress) of each bone of the spine behind the previous one, counting from the hips. */
export const SPINE_LAG = 0.0045;

/** One eye opens in the dark from the first scroll: a slit, a blink, then wide. */
const EYELID: readonly Key[] = [
  [0, 0],
  [0.018, 0.42, EASE.outSine],
  [0.028, 0.3, EASE.inOutSine],
  [0.06, 1, EASE.inOutSine],
  [0.755, 1],
  [0.785, 0.3, EASE.inOutSine],
  [0.797, 0.48, EASE.inOutSine],
  [0.825, 0, EASE.inOutSine],
];

const RISE: readonly Key[] = [
  [PHASES.rise[0], 0],
  [PHASES.rise[1], 1, EASE.inOutQuint],
];

/** Rearing up, past the full height and settling back (the follow-through travels up the neck). */
const STAND: readonly Key[] = [
  [PHASES.stand[0], 0],
  [PHASES.stand[1], 1.05, EASE.inOutQuint],
  [0.415, 1, EASE.inOutSine],
  [PHASES.lower[0], 1],
  [PHASES.lower[1], 0, EASE.inOutSine],
];

/**
 * The fire comes out as the dragon reaches its full height: the whole body pushes forward into the
 * jet, shoulders, neck and head driving it, holds, and pushes harder for the second pass.
 */
const THRUST: readonly Key[] = [
  [0.345, 0],
  [0.39, 1.1, EASE.inOutSine],
  [0.415, 1, EASE.inOutSine],
  [0.53, 1],
  [0.565, 1.25, EASE.inOutSine],
  [0.635, 1.25],
  [0.69, 0, EASE.inOutSine],
];

/** Strength of the jet: the second pass comes out far denser, wider, longer and brighter. */
const POWER: readonly Key[] = [
  [0.52, 1],
  [0.56, 1.8, EASE.inOutSine],
];

/**
 * The camera starts close on the sleeping ball; as the dragon uncurls it eases to the frame that
 * holds it whole standing, wings spread, and lying back down, and it closes in from there.
 */
const FRAME: readonly Key[] = [
  [0.2, 0],
  [0.36, 1, EASE.inOutQuint],
];

/**
 * Wings: they lift off the flanks, hold a beat, then rise to their full height with a slight
 * overshoot; as the fire stops they fold back down while the dragon lowers itself, resting just
 * off the back.
 */
const WING_FOLD: readonly Key[] = [
  [0.29, 1],
  [0.325, 0.62, EASE.outCubic],
  [0.345, 0.6, EASE.linear],
  [0.4, -0.06, EASE.inOutCubic],
  [0.43, 0, EASE.inOutSine],
  [0.645, 0],
  [0.75, 0.94, EASE.inOutSine],
  [0.775, 0.9, EASE.inOutSine],
];

/** Membranes: they open a little with the first lift, then spread wide; they furl as the dragon lowers itself. */
const WING_SPREAD: readonly Key[] = [
  [0.31, 0],
  [0.33, 0.15, EASE.outCubic],
  [0.35, 0.16, EASE.linear],
  [0.415, 1.06, EASE.inOutSine],
  [0.44, 1, EASE.inOutSine],
  [0.64, 1],
  [0.735, 0, EASE.inOutSine],
];

/**
 * Fire intensity: it bursts out, holds hard (only easing a little while the head swings back to
 * the left between the two sweeps) until the phrase has left the screen, then dies down.
 */
const BREATH: readonly Key[] = [
  [PHASES.breath[0], 0],
  [0.39, 1, EASE.inOutSine],
  [0.52, 1],
  [0.535, 0.85, EASE.inOutSine],
  [0.55, 1, EASE.inOutSine],
  [0.635, 1],
  [PHASES.breath[1], 0, EASE.inOutSine],
];

/**
 * The phrase's rise, 0 at rest and 1 once its lowest pixel has passed the top of the screen: it
 * lifts a little as the dragon rears, then the jet drives it up, faster and faster.
 */
const PHRASE: readonly Key[] = [
  [PHASES.phrase[0], 0],
  [0.37, 0.3, EASE.inOutSine],
  [0.42, 0.34, EASE.linear],
  [PHASES.phrase[1], 1, EASE.inQuad],
];

/** How much the body turns toward the jet target: from the first flame until the fire has died. */
const FOCUS: readonly Key[] = [
  [0.35, 0],
  [0.39, 1, EASE.inOutSine],
  [0.64, 1],
  [0.69, 0, EASE.inOutSine],
];

/** Deeper, slower breaths after the fire, settling as the dragon lies down. */
const HEAVE: readonly Key[] = [
  [0.64, 0],
  [0.685, 0.7, EASE.inOutSine],
  [0.8, 0, EASE.inOutSine],
];

/** Smoke builds from the mouth and nostrils as the dragon rears, flowing into the first flame. */
const SIMMER: readonly Key[] = [
  [0.25, 0],
  [0.36, 1, EASE.inOutSine],
  [0.39, 1],
  [0.44, 0, EASE.inOutSine],
];

/** The channels of the body, sampled per bone with a lag (see `SPINE_LAG`). */
export type BodyState = {
  /** 0 curled asleep, 1 uncurled with the neck raised. */
  rise: number;
  /** Settling into the stretched-out resting pose at the end (it overrides the other channels). */
  rest: number;
  /** 0 lying, 1 rearing on the hind legs (slightly above 1 at the overshoot). */
  stand: number;
  /** The push forward into the jet. */
  thrust: number;
};

export function bodyAt(rawProgress: number): BodyState {
  const progress = clamp01(rawProgress);
  return {
    rise: keyframes(RISE, progress),
    rest: EASE.inOutCubic(clamp01((progress - PHASES.rest[0]) / (PHASES.rest[1] - PHASES.rest[0]))),
    stand: keyframes(STAND, progress),
    thrust: keyframes(THRUST, progress),
  };
}

export type SequenceState = BodyState & {
  /** Camera move from the full size (0) to the frame of the standing dragon (1). */
  frame: number;
  /** Camera move from the standing frame (0) to the close, detailed last shot of the resting dragon (1). */
  close: number;
  /** Smoke drifting from the mouth as the dragon rears, before the first flame. */
  simmer: number;
  /** Overall wakefulness: 0 asleep, 1 awake (the final sleep is `sleep`). */
  wake: number;
  /** Overall return to sleep. */
  sleep: number;
  /** Wings, 0 raised to 1 folded on the flanks (slightly below 0 at the overshoot). */
  wingFold: number;
  /** Wing membranes, 0 furled to 1 spread (slightly above 1 at the overshoot). */
  wingSpread: number;
  /** Deep breaths after the fire. */
  heave: number;
  /** How much the head turns toward the jet target. */
  focus: number;
  /** Light level on the dragon: dim asleep, full awake. */
  light: number;
  /** How far the light has come up on the dragon: 0 only the open eye shows, 1 all of it. */
  reveal: number;
  /** The aura around the dragon: 0 before it wakes, then 1 until the end. */
  aura: number;
  /** Eye glow. */
  eyes: number;
  /** Eyelid opening, 1 open, 0 closed (asleep). */
  eyelid: number;
  /** Fire emission intensity. */
  fire: number;
  /** Strength of the jet: 1 for the first pass, higher for the second. */
  power: number;
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

  // The first flame goes straight up into the middle of the phrase, then the head swings to the
  // left; it sweeps right, swings back left between the passes with the fire still pouring, and
  // stays at the right end where the second pass stops.
  let aim = progress < first.start ? 0.5 - 0.5 * EASE.inOutSine(clamp01((progress - PHASES.breath[0] - 0.02) / (first.start - PHASES.breath[0] - 0.02))) : cracks[0];
  if (progress >= second.start) aim = cracks[1];
  else if (progress >= first.end) aim = 1 - EASE.inOutSine(clamp01((progress - first.end) / (second.start - first.end)));

  const wake = EASE.inOutQuint(clamp01((progress - PHASES.wake[0]) / (PHASES.wake[1] - PHASES.wake[0])));
  const sleep = EASE.inOutQuint(clamp01((progress - PHASES.sleep[0]) / (PHASES.sleep[1] - PHASES.sleep[0])));
  const smokePhase = smoothstep(PHASES.smoke[0], PHASES.smoke[1], progress);
  const rose = clamp01(0.25 + 0.75 * smoothstep(0.7, 1, cracks[0]));

  return {
    frame: keyframes(FRAME, progress),
    close: EASE.inOutQuint(clamp01((progress - PHASES.close[0]) / (PHASES.close[1] - PHASES.close[0]))),
    simmer: keyframes(SIMMER, progress),
    wake,
    sleep,
    ...bodyAt(progress),
    wingFold: keyframes(WING_FOLD, progress),
    wingSpread: keyframes(WING_SPREAD, progress),
    heave: keyframes(HEAVE, progress),
    focus: keyframes(FOCUS, progress),
    light: lerp(lerp(0.4, 1, wake), 0.75, sleep),
    reveal: EASE.inOutSine(clamp01((progress - PHASES.reveal[0]) / (PHASES.reveal[1] - PHASES.reveal[0]))),
    aura: EASE.inOutSine(clamp01((progress - PHASES.aura[0]) / (PHASES.aura[1] - PHASES.aura[0]))),
    eyes: smoothstep(0, 0.012, progress),
    eyelid: keyframes(EYELID, progress),
    fire: keyframes(BREATH, progress),
    power: keyframes(POWER, progress),
    aim,
    sweep,
    cracks,
    phrase: keyframes(PHRASE, progress),
    rose,
    smoke: lerp(lerp(0.35 * smoothstep(PHASES.reveal[0], PHASES.reveal[1], progress), 0, wake), 1, smokePhase),
    tail: lerp(lerp(0.45, 0.25, wake), 1, sleep),
    launchReady: progress >= PHASES.launchReady,
  };
}
