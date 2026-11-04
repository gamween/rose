/**
 * Scroll timeline of the landing sequence (spec 8.2). `sequenceAt(progress)` maps the scroll
 * progress of the pinned section (0 at the top, 1 at the end) to every animated quantity, so the
 * scene stays a pure function of scroll plus a time-based idle layer.
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

export type FirePulse = {
  start: number;
  end: number;
  /** Flame front over the phrase (0 = first letter, 1 = last letter) before and after the pulse. */
  frontFrom: number;
  frontTo: number;
};

export const FIRE_PULSES: readonly FirePulse[] = [
  { start: 0.33, end: 0.44, frontFrom: 0, frontTo: 0.36 },
  { start: 0.46, end: 0.57, frontFrom: 0.36, frontTo: 0.72 },
  { start: 0.59, end: 0.7, frontFrom: 0.72, frontTo: 1 },
];

export const PHASES = {
  eyesOpen: [0.05, 0.15],
  bodyReveal: [0.13, 0.32],
  phraseExit: [0.7, 0.83],
  headDown: [0.77, 0.92],
  eyesClose: [0.8, 0.9],
  smoke: [0.83, 0.93],
  launchReady: 0.88,
} as const;

export type SequenceState = {
  /** Eye glow, 0 before the dragon appears. */
  eyes: number;
  /** Eyelid opening, 1 open, 0 closed (asleep). */
  eyelid: number;
  /** Body emergence from the dark. */
  body: number;
  /** Fire emission intensity, 0 between pulses. */
  fire: number;
  /** Index of the active pulse, or -1. */
  pulse: number;
  /** Flame front across the phrase, monotonic. */
  front: number;
  /** Glow of the letters of "rose", from smoldering to blazing. */
  rose: number;
  /** Phrase exit progress: grows and leaves through the top. */
  phraseExit: number;
  /** Head lowered to sleep. */
  sleep: number;
  /** Smoke drifting from the mouth. */
  smoke: number;
  /** Glow of the tail tip. */
  tail: number;
  /** The Launch app button may be revealed by hovering the dragon. */
  launchReady: boolean;
};

function pulseEnvelope(pulse: FirePulse, progress: number): number {
  if (progress <= pulse.start || progress >= pulse.end) return 0;
  const t = (progress - pulse.start) / (pulse.end - pulse.start);
  const attack = smoothstep(0, 0.18, t);
  const release = 1 - smoothstep(0.7, 1, t);
  return attack * release;
}

export function sequenceAt(rawProgress: number): SequenceState {
  const progress = clamp01(rawProgress);

  let fire = 0;
  let pulse = -1;
  let front = 0;
  FIRE_PULSES.forEach((candidate, index) => {
    const envelope = pulseEnvelope(candidate, progress);
    if (envelope > fire) {
      fire = envelope;
      pulse = index;
    }
    if (progress >= candidate.start) {
      const t = smoothstep(candidate.start + 0.15 * (candidate.end - candidate.start), candidate.end - 0.1 * (candidate.end - candidate.start), progress);
      front = lerp(candidate.frontFrom, candidate.frontTo, t);
    }
  });

  const roseFromFire = smoothstep(0.72, 1, front);
  const phraseExit = smoothstep(PHASES.phraseExit[0], PHASES.phraseExit[1], progress);
  const rose = clamp01(0.22 + 0.18 * smoothstep(0.3, 0.6, progress) + 0.45 * roseFromFire + 0.15 * phraseExit);

  const sleep = smoothstep(PHASES.headDown[0], PHASES.headDown[1], progress);
  const eyelid = 1 - smoothstep(PHASES.eyesClose[0], PHASES.eyesClose[1], progress);

  return {
    eyes: smoothstep(PHASES.eyesOpen[0], PHASES.eyesOpen[1], progress),
    eyelid,
    body: smoothstep(PHASES.bodyReveal[0], PHASES.bodyReveal[1], progress),
    fire,
    pulse,
    front,
    rose,
    phraseExit,
    sleep,
    smoke: smoothstep(PHASES.smoke[0], PHASES.smoke[1], progress),
    tail: clamp01(0.25 * smoothstep(0.2, 0.35, progress) + 0.75 * smoothstep(0.78, 0.92, progress)),
    launchReady: progress >= PHASES.launchReady,
  };
}
