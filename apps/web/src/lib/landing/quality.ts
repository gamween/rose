/**
 * Adaptive quality for the landing scene. Pure logic, no DOM: the scene feeds frame times and
 * applies the tier returned by `sample`.
 */

export type QualityTier = {
  name: "ultra" | "high" | "medium" | "low";
  /** Render pixels per CSS pixel. One render pixel is one dither cell. */
  pixelRatio: number;
  /** Maximum live fire and smoke particles. */
  particles: number;
  bloom: boolean;
};

export const QUALITY_TIERS: readonly QualityTier[] = [
  { name: "ultra", pixelRatio: 0.75, particles: 2600, bloom: true },
  { name: "high", pixelRatio: 0.5, particles: 1800, bloom: true },
  { name: "medium", pixelRatio: 0.4, particles: 1100, bloom: true },
  { name: "low", pixelRatio: 0.3, particles: 500, bloom: false },
];

export type ControllerOptions = {
  /** Frame budget in milliseconds (16.7 for 60 fps). */
  budgetMs: number;
  /** Frames averaged before a decision. */
  windowFrames: number;
  /** Average above `budgetMs * downgradeRatio` steps quality down. */
  downgradeRatio: number;
  /** Average below `budgetMs * upgradeRatio` for `upgradeWindows` consecutive windows steps quality up. */
  upgradeRatio: number;
  upgradeWindows: number;
  /** Frames longer than this are ignored (tab switch, debugger, first compile). */
  outlierMs: number;
  /** After a downgrade, upgrades are blocked for this many windows. */
  cooldownWindows: number;
  /** Maximum number of upgrades, to stop oscillation on borderline hardware. */
  maxUpgrades: number;
};

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
  budgetMs: 1000 / 60,
  windowFrames: 45,
  downgradeRatio: 1.25,
  upgradeRatio: 0.6,
  upgradeWindows: 4,
  outlierMs: 250,
  cooldownWindows: 6,
  maxUpgrades: 2,
};

export type QualityState = {
  tierIndex: number;
  samples: number[];
  goodWindows: number;
  cooldown: number;
  upgrades: number;
};

export function createQualityState(initialTier: number): QualityState {
  return {
    tierIndex: clampTier(initialTier),
    samples: [],
    goodWindows: 0,
    cooldown: 0,
    upgrades: 0,
  };
}

function clampTier(index: number): number {
  return Math.min(QUALITY_TIERS.length - 1, Math.max(0, Math.round(index)));
}

/** Feeds one frame time and returns the next state; `changed` tells the caller to apply a new tier. */
export function sampleFrame(
  state: QualityState,
  frameMs: number,
  options: ControllerOptions = DEFAULT_CONTROLLER_OPTIONS,
): { state: QualityState; changed: boolean } {
  if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > options.outlierMs) {
    return { state, changed: false };
  }
  const samples = [...state.samples, frameMs];
  if (samples.length < options.windowFrames) {
    return { state: { ...state, samples }, changed: false };
  }
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const cooldown = Math.max(0, state.cooldown - 1);
  const lastTier = QUALITY_TIERS.length - 1;

  if (average > options.budgetMs * options.downgradeRatio && state.tierIndex < lastTier) {
    return {
      state: { ...state, tierIndex: state.tierIndex + 1, samples: [], goodWindows: 0, cooldown: options.cooldownWindows },
      changed: true,
    };
  }

  if (average < options.budgetMs * options.upgradeRatio) {
    const goodWindows = state.goodWindows + 1;
    const canUpgrade = state.tierIndex > 0 && cooldown === 0 && state.upgrades < options.maxUpgrades;
    if (canUpgrade && goodWindows >= options.upgradeWindows) {
      return {
        state: { ...state, tierIndex: state.tierIndex - 1, samples: [], goodWindows: 0, cooldown, upgrades: state.upgrades + 1 },
        changed: true,
      };
    }
    return { state: { ...state, samples: [], goodWindows, cooldown }, changed: false };
  }

  return { state: { ...state, samples: [], goodWindows: 0, cooldown }, changed: false };
}

export type GpuHints = {
  renderer: string | null;
  hardwareConcurrency: number | null;
  coarsePointer: boolean;
  saveData: boolean;
};

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|lavapipe/i;
const WEAK_GPUS = /intel\(r\) (hd|uhd) graphics [2-6]\d{2}\b|intel hd graphics|mali-[4t]\d|adreno \(tm\) [3-5]\d{2}|powervr|apple a(9|10|11)\b/i;
const STRONG_GPUS = /apple m\d|apple gpu|nvidia|geforce|radeon|rtx|arc\b/i;

/** Picks the starting tier from static hints; the frame-time controller then refines it. */
export function initialTierIndex(hints: GpuHints): number {
  const renderer = hints.renderer ?? "";
  if (hints.saveData || SOFTWARE_RENDERERS.test(renderer)) return 3;
  if (WEAK_GPUS.test(renderer)) return 3;
  if (hints.coarsePointer) return 2;
  if (hints.hardwareConcurrency !== null && hints.hardwareConcurrency <= 4) return 2;
  if (STRONG_GPUS.test(renderer)) return 1;
  return 2;
}

