import {
  Color,
  Group,
  InstancedBufferAttribute,
  Mesh,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { BODY_BONE, HEAD_BONE, JOINTS, ROOT_BONE, WINGS, buildDragonInSteps, type DragonModel } from "@/lib/voxel/dragon";
import { PHASES, sequenceAt, lerp, clamp01, smoothstep, type SequenceState } from "@/lib/landing/timeline";
import { QUALITY_TIERS, createQualityState, sampleFrame, type QualityState, type QualityTier } from "@/lib/landing/quality";
import { stepSpring, type Spring } from "@/lib/landing/spring";
import { ParticlePool, instancedBox } from "./particles";
import { DitherPipeline } from "./post";
import { DragonRig, type Pose } from "./rig";
import {
  dragonFragment,
  dragonVertex,
  fireFragment,
  particleVertex,
  smokeFragment,
  textFragment,
  textVertex,
} from "./shaders";
import { TEXT_SUBDIVISION, buildVoxelText, type VoxelText } from "./text";

export type SceneStats = { fps: number; frameMs: number; tier: QualityTier["name"]; particles: number };

export type FrameAnchors = {
  /** Point just under the dragon, in CSS pixels relative to the canvas, where "Launch app" appears. */
  launch: { x: number; y: number };
  launchReady: boolean;
};

export type HitTarget = "tail" | "dragon" | null;

export type SceneOptions = {
  canvas: HTMLCanvasElement;
  fontFamily: string;
  staticFrame: boolean;
  initialTier: number;
  /** Fixed tier (from `?quality=`), disables adaptation. */
  forcedTier: number | null;
  onStats?: (stats: SceneStats) => void;
  onFrame?: (anchors: FrameAnchors) => void;
  onContextLost?: () => void;
};

export type LandingScene = {
  /** Compiles every program ahead of the first animated frame (call after the first `resize`). */
  prepare: () => Promise<void>;
  /** Scroll progress of the pinned section; the scene glides toward it with a spring. */
  setProgress: (progress: number) => void;
  hitTest: (x: number, y: number) => HitTarget;
  resize: (width: number, height: number) => void;
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

const FOV = 24;
const TAN_HALF_FOV = Math.tan((FOV * Math.PI) / 360);
/** The phrase lives in a plane in front of the dragon, the fire just behind it so it never covers the letters. */
const TEXT_Z = 60;
const FIRE_Z = 50;
/** While the dragon draws its breath, its snout tips this far (in units of the distance to the target) above the target. */
const INHALE_REAR = 0.45;
/** Rate (1/s) at which the point the head aims at follows its goal. */
const AIM_RATE = 9;
/** Natural frequency of the spring the scene follows the scroll with (1/s): a step settles in about a second. */
const PROGRESS_OMEGA = 4.5;
/** Strength of the glints that the blazing "rose" and the jet front leave on the other letters. */
const ROSE_GLINT = 50;
const JET_GLINT = 60;
/** The glint lights float this far in front of the letters (design pixels). */
const GLINT_LIGHT_Z = 3;
/** How much the dragon darkens behind the phrase, so the letters always read on a dark band. */
const VEIL_STRENGTH = 0.82;
/** Render pixels per design pixel of the phrase below which letters lose rows to aliasing. */
const MIN_TEXT_PIXELS_PER_DESIGN_PIXEL = 1.7;
/** World size of the fire and smoke particles relative to the distance from the camera. */
const PARTICLE_UNIT_DISTANCE = 200;

/**
 * A camera framing of the dragon: the share of the screen width its body spans, where its center
 * sits on screen (normalized device coordinates) and how far the camera looks down at it.
 */
type Shot = { share: number; x: number; y: number; elevation: number };

/** A screen box (normalized device coordinates) the standing dragon must fit in, and the camera elevation. */
type Fit = { left: number; right: number; bottom: number; top: number; elevation: number };

/** Composition per orientation. */
type Layout = {
  /** The opening frame: the dragon asleep, small, under the phrase. */
  open: Shot;
  /** The dragon at its full size, the largest it ever appears: the camera closes in to it as it wakes. */
  full: Shot;
  /**
   * Where the standing dragon, wings spread, fits whole: the camera eases there as it rears, so
   * it breathes fire never cropped, under the phrase it drives off the top of the screen.
   */
  stand: Fit;
  /** The final frame: the dragon asleep again, as small as at the start or smaller. */
  far: Shot;
  /** Share of the screen width the phrase spans at rest, and how much wider it grows. */
  textShare: number;
  textGrow: number;
  /** Vertical position of the phrase (NDC) at rest. */
  textY: number;
  /** Furthest the jet reaches toward the screen edges (NDC). */
  sweepEdge: number;
  /** Fire emission and particle size relative to the landscape jet. */
  fireScale: number;
};

const LANDSCAPE: Layout = {
  open: { share: 0.16, x: 0, y: -0.3, elevation: 0.16 },
  full: { share: 0.46, x: 0.04, y: -0.46, elevation: 0.12 },
  stand: { left: -0.84, right: 0.84, bottom: -0.95, top: 0.34, elevation: 0.04 },
  far: { share: 0.14, x: 0, y: -0.14, elevation: 0.2 },
  textShare: 0.54,
  textGrow: 0.3,
  textY: 0.16,
  sweepEdge: 0.88,
  fireScale: 1,
};

const PORTRAIT: Layout = {
  open: { share: 0.3, x: 0, y: -0.3, elevation: 0.16 },
  full: { share: 0.8, x: -0.04, y: -0.5, elevation: 0.12 },
  stand: { left: -0.92, right: 0.92, bottom: -0.92, top: 0.3, elevation: 0.04 },
  far: { share: 0.28, x: 0, y: -0.12, elevation: 0.2 },
  textShare: 0.8,
  textGrow: 0.1,
  textY: 0.14,
  sweepEdge: 0.92,
  fireScale: 0.6,
};

function random(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function mixShot(a: Shot, b: Shot, t: number, out: Shot): Shot {
  out.share = Math.exp(lerp(Math.log(a.share), Math.log(b.share), t));
  out.x = lerp(a.x, b.x, t);
  out.y = lerp(a.y, b.y, t);
  out.elevation = lerp(a.elevation, b.elevation, t);
  return out;
}

function createDragonMesh(model: DragonModel, uniforms: Record<string, { value: unknown }>): Mesh {
  const geometry = instancedBox(1, 1, 1);
  geometry.setAttribute("aOffset", new InstancedBufferAttribute(model.positions, 3));
  geometry.setAttribute("aColor", new InstancedBufferAttribute(model.colors, 3));
  geometry.setAttribute("aData", new InstancedBufferAttribute(model.data, 4));
  geometry.setAttribute("aSkinBones", new InstancedBufferAttribute(model.skinBones, 4));
  geometry.setAttribute("aSkinWeights", new InstancedBufferAttribute(model.skinWeights, 4));
  geometry.instanceCount = model.count;
  const mesh = new Mesh(geometry, new ShaderMaterial({ vertexShader: dragonVertex, fragmentShader: dragonFragment, uniforms }));
  mesh.frustumCulled = false;
  return mesh;
}

function createTextMesh(text: VoxelText, uniforms: Record<string, { value: unknown }>): Mesh {
  const geometry = instancedBox(1 / TEXT_SUBDIVISION, 1 / TEXT_SUBDIVISION, 2.2);
  geometry.setAttribute("aOffset", new InstancedBufferAttribute(text.offsets, 3));
  geometry.setAttribute("aLetter", new InstancedBufferAttribute(text.letters, 3));
  geometry.setAttribute("aCrack", new InstancedBufferAttribute(text.cracks, 4));
  geometry.setAttribute("aEdge", new InstancedBufferAttribute(text.edges, 2));
  geometry.instanceCount = text.count;
  const mesh = new Mesh(geometry, new ShaderMaterial({ vertexShader: textVertex, fragmentShader: textFragment, uniforms }));
  mesh.frustumCulled = false;
  return mesh;
}

/** Ends the current task so the browser can paint and handle input between the setup steps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Bounds = { min: Vector3; max: Vector3 };

/** Pose of the rig at a point of the sequence, the head aiming at `aim` as far as the sequence turns it. */
function poseAt(rig: DragonRig, progress: number, aim: Vector3): void {
  const state = sequenceAt(progress);
  rig.update({ neck: state.neck, time: 0, stand: state.stand, yaw: 0, aim, aimWeight: Math.max(state.focus, state.stand), jaw: 0, wingFold: state.wingFold, wingSpread: state.wingSpread });
}

/** Bounds of the dragon asleep: the width the shots frame and the point they center. */
function sleepingFrame(model: DragonModel, rig: DragonRig): { width: number; focus: Vector3; front: number } {
  const bounds: Bounds = { min: new Vector3(), max: new Vector3() };
  poseAt(rig, 0, new Vector3());
  rig.bounds(model, bounds.min, bounds.max);
  const { min, max } = bounds;
  return { width: max.x - min.x, focus: new Vector3((min.x + max.x) / 2, min.y + 0.35 * (max.y - min.y), (min.z + max.z) / 2), front: max.z };
}

/**
 * Bounds of the dragon over the whole time the camera holds the standing frame: rising, wings
 * spreading (overshoot included), its head turned anywhere between its resting gaze and the far
 * ends of the phrase, then lying back down until the camera pulls back.
 */
function standingBounds(model: DragonModel, rig: DragonRig): Bounds {
  const total: Bounds = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
  const min = new Vector3();
  const max = new Vector3();
  const aim = new Vector3();
  const head = new Vector3();
  for (let progress = PHASES.stand[0] + 0.04; progress <= PHASES.retreat[0]; progress += 0.025) {
    for (const [dx, dy] of [
      [0, 0],
      [-200, 200],
      [200, 200],
    ] as const) {
      poseAt(rig, progress, rig.gaze(aim));
      rig.transform(model.anchors.head, HEAD_BONE, head);
      poseAt(rig, progress, aim.set(head.x + dx, head.y + dy, head.z));
      rig.bounds(model, min, max);
      total.min.min(min);
      total.max.max(max);
    }
  }
  return total;
}

/**
 * Builds the scene in short tasks: the voxel dragon first (pure CPU, one task per body part), then
 * the GPU objects, so the page stays responsive while the landing loads.
 */
export async function createLandingScene(options: SceneOptions): Promise<LandingScene> {
  const { canvas } = options;
  const model = await buildDragonInSteps(nextTask);
  const { anchors } = model;
  const rig = new DragonRig(anchors);
  const frame = sleepingFrame(model, rig);
  await nextTask();
  const standing = standingBounds(model, rig);
  await nextTask();
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  // Clear alpha 0: the empty background is crisp black for the dither pass and never blooms.
  renderer.setClearColor(new Color(0x000000), 0);
  renderer.autoClear = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 4000);
  const pipeline = new DitherPipeline(renderer);

  const lightUniforms = {
    uLightPos: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3(30, 60, 120)] },
    uLightColor: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
    uLightRange: { value: [34, 26, 40, 220] },
    uKeyDir: { value: new Vector3(0.45, 0.75, 0.5).normalize() },
    uKeyColor: { value: new Vector3() },
    uRimDir: { value: new Vector3(-0.7, 0.45, -0.55).normalize() },
    uRimColor: { value: new Vector3() },
  };
  const time = { value: 0 };

  const dragonUniforms = {
    ...lightUniforms,
    uBones: { value: rig.bones },
    uTime: time,
    uBreathPhase: { value: 0 },
    uBreathDepth: { value: 0.01 },
    uSwell: { value: 0 },
    uEyes: { value: 0 },
    uEyelid: { value: 0 },
    uFire: { value: 0 },
    uTail: { value: 0 },
    uSmoke: { value: 0 },
    uBackGlow: { value: 0 },
    uChest: { value: new Vector3(...anchors.chest) },
    uVeilBox: { value: new Vector4(0, 0, 0, 0) },
    uVeilSoft: { value: new Vector2(0.08, 0.12) },
    uVeil: { value: 0 },
  };
  const dragon = createDragonMesh(model, dragonUniforms);
  scene.add(dragon);

  const textUniforms = {
    ...lightUniforms,
    uTime: time,
    uWidth: { value: 1 },
    uCracks: { value: new Vector2(-1, -1) },
    uSweep: { value: -1 },
    uPush: { value: 0 },
    uFire: { value: 0 },
    uRose: { value: 0 },
    uRoseLights: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] },
    uJetLight: { value: new Vector4() },
    uTextScale: { value: 1 },
  };
  const textGroup = new Group();
  scene.add(textGroup);
  let text: VoxelText | null = null;
  let textMesh: Mesh | null = null;
  let roseVoxels: number[] = [];
  let lines: 1 | 2 = 1;
  const phrase = { y: 0, share: 1, left: -1, right: 1 };

  const maxParticles = QUALITY_TIERS[0]!.particles;
  const jetUniforms = { uFrontPoint: { value: new Vector3() }, uFrontDir: { value: new Vector3(1, 0, 0) }, uFadeRange: { value: new Vector2(1, 9) } };
  const fire = new ParticlePool(maxParticles, particleVertex, fireFragment, { additive: true, uniforms: jetUniforms });
  const smoke = new ParticlePool(360, particleVertex, smokeFragment, {
    additive: false,
    uniforms: { ...jetUniforms, uSmokeColor: { value: new Vector3(0.42, 0.36, 0.33) } },
  });
  scene.add(fire.mesh, smoke.mesh);

  let layout = LANDSCAPE;
  let tierIndex = options.forcedTier ?? options.initialTier;
  let quality: QualityState = createQualityState(tierIndex);
  let width = 1;
  let height = 1;
  let target = 0;
  let progressSpring: Spring | null = null;
  let state: SequenceState = sequenceAt(0);
  let breathPhase = 0;
  const aim = new Vector3();
  const pose: Pose = { neck: state.neck, time: 0, stand: 0, yaw: 0, aim, aimWeight: 0, jaw: 0, wingFold: 1, wingSpread: 0 };
  let aimReady = false;
  const shot: Shot = { ...LANDSCAPE.open };
  const shotScratch: Shot = { ...LANDSCAPE.open };
  const standShot: Shot = { ...LANDSCAPE.full };
  let fireAccumulator = 0;
  let smokeAccumulator = 0;
  let sparkAccumulator = 0;
  let emberAccumulator = 0;
  let running = false;
  let frameHandle = 0;
  let lastTime = 0;
  let fade = 0;
  const statWindow = { frames: 0, elapsed: 0, last: 0 };
  const scratch = new Vector3();
  const forward = new Vector3(0, 0, -1);
  const up = new Vector3(0, 1, 0);
  const right = new Vector3(1, 0, 0);
  const mouth = new Vector3();
  const jetDirection = new Vector3(1, 0, 0);
  const jetTarget = new Vector3();
  const flameMid = new Vector3();
  const headLight = new Vector3();
  const headLightColor = new Vector3(0.75, 0.42, 0.3);
  const aimGoal = new Vector3();
  const skull = new Vector3();

  /** CSS pixels per design pixel of the phrase at rest (before it grows). */
  function cssPixelsPerTextPixel(): number {
    return text ? (layout.textShare * width) / text.width : 1;
  }

  function applyTier(index: number): void {
    tierIndex = index;
    const tier = QUALITY_TIERS[index]!;
    // Narrow screens draw the phrase small: keep enough render pixels per design pixel for the
    // letters to stay legible whatever the tier (a 375 px screen stays far below the desktop pixel count).
    const textFloor = MIN_TEXT_PIXELS_PER_DESIGN_PIXEL / Math.max(cssPixelsPerTextPixel(), 1e-3);
    renderer.setPixelRatio(Math.min(1, Math.max(tier.pixelRatio, textFloor)));
    renderer.setSize(width, height, false);
    const buffer = renderer.getDrawingBufferSize(new Vector2());
    pipeline.setSize(buffer.x, buffer.y);
    pipeline.bloomEnabled = tier.bloom;
    fire.setLimit(tier.particles);
  }

  function rebuildText(): void {
    const wanted: 1 | 2 = width / height < 1 ? 2 : 1;
    if (text && wanted === lines && textMesh) return;
    lines = wanted;
    if (textMesh) {
      textGroup.remove(textMesh);
      textMesh.geometry.dispose();
      (textMesh.material as ShaderMaterial).dispose();
    }
    text = buildVoxelText(options.fontFamily, lines);
    textMesh = createTextMesh(text, textUniforms);
    textGroup.add(textMesh);
    textUniforms.uWidth.value = text.width;
    roseVoxels = [];
    for (let i = 0; i < text.count; i += 1) if ((text.letters[i * 3 + 1] ?? 0) > 0.5) roseVoxels.push(i);
  }

  /** Point where the ray through a screen position (NDC) meets the plane of constant `z`. */
  function onPlane(ndcX: number, ndcY: number, z: number, out: Vector3): Vector3 {
    out.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position);
    return out.multiplyScalar((z - camera.position.z) / out.z).add(camera.position);
  }

  /** Distance of a point from the camera along its view axis. */
  function depthOf(point: Vector3): number {
    return scratch.copy(point).sub(camera.position).dot(forward);
  }

  /**
   * The shot that holds the standing dragon whole inside `fit`: the closest camera (at the fit's
   * elevation) for which every corner of its standing bounds projects inside the box.
   */
  function fitStandingShot(fit: Fit, out: Shot): Shot {
    const aspect = width / height;
    const cos = Math.cos(fit.elevation);
    const sin = Math.sin(fit.elevation);
    const corners: [number, number, number][] = [];
    for (const x of [standing.min.x, standing.max.x]) {
      for (const y of [standing.min.y, standing.max.y]) {
        for (const z of [standing.min.z, standing.max.z]) {
          const dx = x - frame.focus.x;
          const dy = y - frame.focus.y;
          const dz = z - frame.focus.z;
          corners.push([dx, dy * cos - dz * sin, -dy * sin - dz * cos]);
        }
      }
    }
    // For a camera `distance` back from the focus and shifted by (a, b) in its own plane, a corner
    // lands at x = (px - a) / (depth * tan * aspect) and y = (py - b) / (depth * tan): each bound
    // of the box limits the shift, and the shot exists once the limits leave room for one.
    const shift = (distance: number, axis: 0 | 1, low: number, high: number, scale: number) => {
      let from = -Infinity;
      let to = Infinity;
      for (const corner of corners) {
        const depth = corner[2] + distance;
        from = Math.max(from, corner[axis] - high * depth * scale);
        to = Math.min(to, corner[axis] - low * depth * scale);
      }
      return from <= to ? (from + to) / 2 : null;
    };
    let near = 1;
    let far = 20000;
    for (let i = 0; i < 40; i += 1) {
      const distance = (near + far) / 2;
      const fits = shift(distance, 0, fit.left, fit.right, TAN_HALF_FOV * aspect) !== null && shift(distance, 1, fit.bottom, fit.top, TAN_HALF_FOV) !== null;
      if (fits) far = distance;
      else near = distance;
    }
    const halfHeight = far * TAN_HALF_FOV;
    out.share = frame.width / (far * 2 * TAN_HALF_FOV * aspect);
    out.x = -(shift(far, 0, fit.left, fit.right, TAN_HALF_FOV * aspect) ?? 0) / (halfHeight * aspect);
    out.y = -(shift(far, 1, fit.bottom, fit.top, TAN_HALF_FOV) ?? 0) / halfHeight;
    out.elevation = fit.elevation;
    return out;
  }

  /** The camera is a pure function of the (spring-smoothed) progress: nothing else moves it. */
  function updateCamera(): void {
    layout = width / height < 1 ? PORTRAIT : LANDSCAPE;
    mixShot(layout.open, layout.full, state.dolly, shotScratch);
    mixShot(shotScratch, standShot, state.frame, shotScratch);
    mixShot(shotScratch, layout.far, state.retreat, shot);
    const aspect = width / height;
    const distance = frame.width / (shot.share * 2 * TAN_HALF_FOV * aspect);
    const halfHeight = distance * TAN_HALF_FOV;

    camera.aspect = aspect;
    // Clip planes follow the distance: a narrow portrait frame puts the far shot thousands of units away.
    camera.near = distance * 0.05;
    camera.far = distance * 4;
    camera.rotation.set(-shot.elevation, 0, 0);
    forward.set(0, -Math.sin(shot.elevation), -Math.cos(shot.elevation));
    up.set(0, Math.cos(shot.elevation), -Math.sin(shot.elevation));
    camera.position
      .copy(frame.focus)
      .addScaledVector(forward, -distance)
      .addScaledVector(right, -shot.x * halfHeight * aspect)
      .addScaledVector(up, -shot.y * halfHeight);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  /** Phrase-relative position (0 left edge, 1 right edge) of a screen position along the sweep. */
  function acrossPhrase(sweep: number): number {
    return lerp(phrase.left, phrase.right, sweep) / (2 * phrase.share) + 0.5;
  }

  function crackFront(sweep: number): number {
    if (sweep <= 0) return -1;
    if (sweep >= 1) return 2;
    return acrossPhrase(sweep);
  }

  /**
   * The phrase grows a little as it rises from its resting place to just past the top edge of the
   * screen: at `phrase` 1 its lowest pixel, chunks lifted by the jet included, has left the screen.
   */
  function updateText(): void {
    if (!text) return;
    phrase.share = layout.textShare * (1 + layout.textGrow * smoothstep(0, 0.6, state.phrase));
    const halfHeight = phrase.share * (text.height / text.width) * camera.aspect;
    const exit = 1 + halfHeight * (1 + 6 / text.height) + 0.01;
    phrase.y = lerp(layout.textY, exit, state.phrase);
    phrase.left = Math.max(-phrase.share - 0.06, -layout.sweepEdge);
    phrase.right = Math.min(phrase.share + 0.06, layout.sweepEdge);
    onPlane(0, phrase.y, TEXT_Z, textGroup.position);
    const visibleWidth = 2 * depthOf(textGroup.position) * TAN_HALF_FOV * camera.aspect;
    textGroup.scale.setScalar((phrase.share * visibleWidth) / text.width);
    textGroup.quaternion.copy(camera.quaternion);
    textGroup.visible = state.phrase < 1;
    textGroup.updateMatrixWorld();
    textUniforms.uCracks.value.set(crackFront(state.cracks[0]), crackFront(state.cracks[1]));
    textUniforms.uSweep.value = acrossPhrase(state.aim);
    textUniforms.uPush.value = smoothstep(0.12, 0.6, state.phrase);
    textUniforms.uFire.value = state.fire;
    textUniforms.uRose.value = state.rose;
    onPlane(lerp(phrase.left, phrase.right, state.aim), phrase.y, FIRE_Z, jetTarget);
    updateGlintLights();
    updateVeil();
  }

  /**
   * Point lights for the glints on the phrase: one per letter of "rose", flickering with the
   * embers and drifting a little so the highlights crawl along the edges, and one at the front of
   * the jet as it passes over the letters.
   */
  function updateGlintLights(): void {
    if (!text) return;
    const whole = 1 - smoothstep(0.85, 1, state.phrase);
    const glow = ROSE_GLINT * (0.35 + 0.65 * state.rose) * whole;
    const centers = text.letterCenters;
    textUniforms.uRoseLights.value.forEach((light, k) => {
      const center = centers[centers.length - 5 + k];
      if (!center) return;
      const t = time.value;
      const flicker = 0.78 + 0.14 * Math.sin(t * (2.1 + k * 0.6) + k * 1.9) + 0.08 * Math.sin(t * (5.3 + k * 1.3) + k * 4.1);
      textGroup.localToWorld(scratch.set(center.x + Math.sin(t * 0.9 + k * 2.3) * 0.8, center.y + Math.sin(t * 1.3 + k) * 1.2, GLINT_LIGHT_Z));
      light.set(scratch.x, scratch.y, scratch.z, glow * flicker);
    });
    const front = (acrossPhrase(state.aim) - 0.5) * text.width;
    textGroup.localToWorld(scratch.set(front, 0, GLINT_LIGHT_Z));
    textUniforms.uJetLight.value.set(scratch.x, scratch.y, scratch.z, JET_GLINT * state.fire * whole);
    textUniforms.uTextScale.value = textGroup.scale.x;
  }

  /** Screen box of the phrase (NDC), padded by half a line, for the dragon's veil. */
  function updateVeil(): void {
    if (!text || !textGroup.visible) {
      dragonUniforms.uVeil.value = 0;
      return;
    }
    const halfWidth = text.width / 2;
    const halfHeight = text.height / 2;
    const low = textGroup.localToWorld(scratch.set(-halfWidth, -halfHeight, 0)).project(camera);
    const lowX = low.x;
    const lowY = low.y;
    const high = textGroup.localToWorld(scratch.set(halfWidth, halfHeight, 0)).project(camera);
    const padY = (high.y - lowY) * (lines === 1 ? 0.45 : 0.22);
    const padX = padY * (height / width) * 1.5;
    dragonUniforms.uVeilBox.value.set((lowX + high.x) / 2, (lowY + high.y) / 2, Math.abs(high.x - lowX) / 2 + padX, Math.abs(high.y - lowY) / 2 + padY);
    dragonUniforms.uVeilSoft.value.set(padX * 2.5 + 0.02, padY * 2.5 + 0.02);
    dragonUniforms.uVeil.value = VEIL_STRENGTH;
  }

  /**
   * The body follows the timeline's staged, eased channels directly. Once the dragon stands, its
   * head turns toward a point that glides with a short exponential smoothing: its resting gaze
   * ahead, then the jet target on the phrase (above it while it draws its breath).
   */
  function updatePose(dt: number): void {
    rig.gaze(aimGoal);
    rig.transform(anchors.head, HEAD_BONE, skull);
    scratch.copy(jetTarget).addScaledVector(up, INHALE_REAR * state.inhale * jetTarget.distanceTo(skull));
    aimGoal.lerp(scratch, state.focus);
    if (aimReady && dt > 0) aim.lerp(aimGoal, 1 - Math.exp(-AIM_RATE * dt));
    else aim.copy(aimGoal);
    aimReady = true;
    pose.neck = state.neck;
    pose.time = time.value;
    pose.stand = state.stand;
    pose.yaw = Math.sin(time.value * 0.33) * 0.04;
    pose.aimWeight = Math.max(state.focus, state.stand);
    pose.jaw = Math.min(1, state.fire * 1.4);
    pose.wingFold = state.wingFold;
    pose.wingSpread = state.wingSpread;
    rig.update(pose);
    rig.transform(anchors.mouth, HEAD_BONE, mouth);
    jetDirection.copy(jetTarget).sub(mouth).normalize();
  }

  function simulate(dt: number): void {
    const tier = QUALITY_TIERS[tierIndex]!;
    const unit = depthOf(mouth) / PARTICLE_UNIT_DISTANCE;
    const jetLength = jetTarget.distanceTo(mouth);
    fireAccumulator += state.fire * 640 * layout.fireScale * dt * (tier.particles / maxParticles + 0.3);
    while (fireAccumulator >= 1) {
      fireAccumulator -= 1;
      const speed = jetLength * random(1.2, 1.55);
      const spread = 0.09;
      const along = Math.random() ** 2 * 0.7;
      fire.spawn({
        x: mouth.x + jetDirection.x * speed * along + random(-0.8, 0.8) * unit,
        y: mouth.y + jetDirection.y * speed * along + random(-0.8, 0.8) * unit,
        z: mouth.z + jetDirection.z * speed * along + random(-0.8, 0.8) * unit,
        vx: (jetDirection.x + random(-spread, spread)) * speed,
        vy: (jetDirection.y + random(-spread, spread)) * speed,
        vz: (jetDirection.z + random(-spread * 0.5, spread * 0.5)) * speed,
        life: random(1.1, 1.5),
        size: random(0.8, 1.4) * unit * (0.5 + 0.5 * layout.fireScale),
        growth: random(1, 1.9),
        kind: 0,
        age: along,
      });
    }

    if (text && textMesh && textGroup.visible) {
      if (roseVoxels.length > 0) {
        sparkAccumulator += (2 + 10 * state.rose) * dt;
        while (sparkAccumulator >= 1) {
          sparkAccumulator -= 1;
          const index = roseVoxels[Math.floor(Math.random() * roseVoxels.length)]!;
          const world = textGroup.localToWorld(scratch.set(text.offsets[index * 3]!, text.offsets[index * 3 + 1]!, 1.2));
          fire.spawn({
            x: world.x,
            y: world.y,
            z: world.z,
            vx: random(-0.6, 0.6) * unit,
            vy: random(2.5, 5.5) * unit,
            vz: random(-0.4, 0.4),
            life: random(1.4, 2.6),
            size: textGroup.scale.x * 0.7,
            growth: -0.6,
            kind: 1,
          });
        }
      }
      // The cracked letters shed embers from their fissures while the jet drives them up.
      emberAccumulator += 140 * state.fire * layout.fireScale * dt;
      const front = Math.max(textUniforms.uCracks.value.x, textUniforms.uCracks.value.y);
      while (emberAccumulator >= 1) {
        emberAccumulator -= 1;
        const index = Math.floor(Math.random() * text.count);
        if (text.cracks[index * 4]! < 0.5 || text.offsets[index * 3]! / text.width + 0.5 > front) continue;
        const world = textGroup.localToWorld(scratch.set(text.offsets[index * 3]!, text.offsets[index * 3 + 1]!, 1.2));
        fire.spawn({
          x: world.x,
          y: world.y,
          z: world.z,
          vx: random(-2.5, 2.5) * unit,
          vy: random(1, 6) * unit,
          vz: random(-1, 1),
          life: random(0.7, 1.6),
          size: textGroup.scale.x * random(0.4, 0.8),
          growth: -0.7,
          kind: 1,
        });
      }
    }

    smokeAccumulator += (state.smoke * 12 + state.heave * 10 + state.wake * (1 - state.fire) * (1 - state.sleep) * 3) * dt;
    while (smokeAccumulator >= 1) {
      smokeAccumulator -= 1;
      rig.transform(anchors.nostrils[Math.random() < 0.5 ? 0 : 1]!, HEAD_BONE, scratch);
      smoke.spawn({
        x: scratch.x + random(-0.3, 0.3),
        y: scratch.y + random(0, 0.5),
        z: scratch.z + random(-0.3, 0.3),
        vx: random(0.6, 1.6),
        vy: random(1.6, 2.6),
        vz: random(-0.2, 0.3),
        life: random(3.5, 6),
        size: random(0.45, 0.8),
        growth: random(0.6, 1.2),
        kind: 2,
      });
    }

    jetUniforms.uFrontPoint.value.copy(jetTarget);
    jetUniforms.uFrontDir.value.copy(jetDirection);
    jetUniforms.uFadeRange.value.set(1, 9).multiplyScalar(unit * 2);
    fire.update(dt, time.value, 0.45, 5 * unit, 9 * unit, { z: FIRE_Z, y: jetTarget.y, stiffness: 14 });
    smoke.update(dt, time.value, 0.3, 0.35, 1.4);

    flameMid.copy(mouth).lerp(jetTarget, 0.6);
    const [firePos, tailPos, rosePos] = lightUniforms.uLightPos.value;
    const [fireColor, tailColor, roseColor, fillColor] = lightUniforms.uLightColor.value;
    firePos!.copy(flameMid);
    fireColor!.set(1.3, 0.5, 0.14).multiplyScalar(state.fire * 1.7);
    rig.transform(anchors.tailTip, ROOT_BONE, tailPos!).add(scratch.set(0, 4, 3));
    tailColor!.set(1.6, 0.55, 0.14).multiplyScalar(state.tail * (0.7 + 0.5 * state.sleep));
    // Light 2 glows from "rose" while the phrase is whole, then becomes a low warm light just above
    // the sleeping head so its silhouette (snout, horns, closed eye) stays readable.
    const whole = 1 - smoothstep(0.75, 1, state.phrase);
    roseAnchor(rosePos!);
    rig.transform(anchors.head, HEAD_BONE, headLight).add(scratch.set(4, 14, 16));
    rosePos!.lerp(headLight, 1 - whole);
    roseColor!
      .set(0.9, 0.22, 0.06)
      .multiplyScalar(state.rose * whole * 0.9)
      .addScaledVector(headLightColor, state.sleep * 1.25);
    fillColor!.set(0.35, 0.22, 0.18).multiplyScalar(state.light * (1 - 0.55 * state.sleep));
    lightUniforms.uKeyColor.value.set(0.95, 0.62, 0.5).multiplyScalar(state.light * (1 - 0.35 * state.sleep) * (0.85 + 0.15 * Math.sin(time.value * 0.8)));
    lightUniforms.uRimColor.value.set(1.6, 0.7, 0.9).lerp(scratch.set(1.3, 0.95, 1.2), state.sleep).multiplyScalar(state.light * (1 + 0.25 * state.sleep));

    dragonUniforms.uEyes.value = state.eyes;
    dragonUniforms.uEyelid.value = state.eyelid;
    dragonUniforms.uFire.value = state.fire;
    dragonUniforms.uTail.value = state.tail;
    dragonUniforms.uSmoke.value = state.smoke;
    dragonUniforms.uBackGlow.value = 0.05 * state.light * state.wake * (1 - state.sleep) + 0.4 * state.fire;
    // Slow, shallow breaths asleep, deeper and quicker awake; held, chest swollen, before the fire;
    // deep and slow after it, settling as the dragon lies down.
    const awake = state.wake * (1 - state.sleep);
    breathPhase += dt * lerp(0.9, 1.5, awake) * (1 - 0.8 * state.inhale) * (1 - 0.35 * state.heave);
    dragonUniforms.uBreathPhase.value = breathPhase;
    dragonUniforms.uBreathDepth.value = (0.014 * lerp(0.7, 1, awake) + 0.024 * state.heave) * (1 - state.inhale);
    dragonUniforms.uSwell.value = 0.045 * state.inhale;
  }

  /** World position of the letters of "rose". */
  function roseAnchor(out: Vector3): Vector3 {
    const centers = text?.letterCenters ?? [];
    const last = centers[centers.length - 2];
    if (!last) return out.copy(textGroup.position);
    return textGroup.localToWorld(out.set(last.x, last.y, 0)).setZ(TEXT_Z - 16);
  }

  function project(point: Vector3): { x: number; y: number } {
    const p = point.clone().project(camera);
    return { x: (p.x * 0.5 + 0.5) * width, y: (-p.y * 0.5 + 0.5) * height };
  }

  function projectedRadius(point: Vector3, radius: number): number {
    const a = project(point);
    const b = project(point.clone().add(new Vector3(radius, 0, 0)));
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function updateHeat(): void {
    if (state.fire <= 0.001) {
      pipeline.setHeat(0, 0, 1, 0, time.value);
      return;
    }
    const mid = project(scratch.copy(mouth).lerp(jetTarget, 0.6));
    const extent = project(jetTarget);
    const radius = Math.max(0.12, Math.hypot(mid.x - extent.x, mid.y - extent.y) / height + 0.1);
    pipeline.setHeat(mid.x / width, 1 - mid.y / height, radius * (0.4 + 0.6 * layout.fireScale), state.fire * 0.9 * layout.fireScale, time.value);
  }

  /** Just under the front of the sleeping dragon, where the Launch app button appears. */
  function launchAnchor(): { x: number; y: number } {
    return project(new Vector3(frame.focus.x, 0, frame.front));
  }

  function renderFrame(dt: number): void {
    time.value += dt;
    progressSpring = stepSpring(progressSpring ?? { value: target, velocity: 0 }, target, PROGRESS_OMEGA, dt);
    state = sequenceAt(progressSpring.value);
    updateCamera();
    updateText();
    updatePose(dt);
    simulate(dt);
    updateHeat();
    fade = Math.min(1, fade + dt * 1.6);
    pipeline.setFade(fade);
    pipeline.render(scene, camera);
    options.onFrame?.({ launch: launchAnchor(), launchReady: state.launchReady });
  }

  function loop(now: number): void {
    if (!running) return;
    frameHandle = requestAnimationFrame(loop);
    const dtMs = lastTime === 0 ? 16.7 : now - lastTime;
    lastTime = now;
    renderFrame(Math.min(dtMs, 50) / 1000);

    if (options.forcedTier === null) {
      const next = sampleFrame(quality, dtMs);
      quality = next.state;
      if (next.changed) applyTier(quality.tierIndex);
    }
    statWindow.frames += 1;
    statWindow.elapsed += dtMs;
    if (now - statWindow.last > 500 && statWindow.frames > 0) {
      options.onStats?.({
        fps: (1000 * statWindow.frames) / statWindow.elapsed,
        frameMs: statWindow.elapsed / statWindow.frames,
        tier: QUALITY_TIERS[tierIndex]!.name,
        particles: fire.live + smoke.live,
      });
      statWindow.frames = 0;
      statWindow.elapsed = 0;
      statWindow.last = now;
    }
  }

  function renderStatic(): void {
    target = 1;
    progressSpring = { value: 1, velocity: 0 };
    aimReady = false;
    fade = 1;
    for (let i = 0; i < 180; i += 1) {
      time.value += 1 / 30;
      state = sequenceAt(1);
      updateCamera();
      updateText();
      updatePose(1 / 30);
      simulate(1 / 30);
    }
    updateHeat();
    pipeline.setFade(1);
    pipeline.render(scene, camera);
    options.onFrame?.({ launch: launchAnchor(), launchReady: true });
  }

  const onContextLost = (event: Event) => {
    event.preventDefault();
    running = false;
    cancelAnimationFrame(frameHandle);
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const api: LandingScene = {
    prepare() {
      return pipeline.compile(scene, camera);
    },
    setProgress(value) {
      target = clamp01(value);
    },
    hitTest(x, y) {
      const tip = rig.transform(anchors.tailTip, ROOT_BONE, new Vector3());
      const tail = project(tip);
      if (Math.hypot(x - tail.x, y - tail.y) < Math.max(24, projectedRadius(tip, 7))) return "tail";
      const regions: [Vector3, number][] = [
        [rig.transform(anchors.head, HEAD_BONE, new Vector3()), 13],
        ...JOINTS.map((joint, i): [Vector3, number] => [rig.transform(joint, BODY_BONE + i, new Vector3()), 8]),
        ...WINGS.map((wing): [Vector3, number] => [rig.transform(wing.elbow, wing.arm, new Vector3()), 14]),
        ...anchors.body.map(({ point, radius }): [Vector3, number] => [rig.transform(point, BODY_BONE, new Vector3()), radius]),
        ...anchors.tail.map(({ point, radius }): [Vector3, number] => [rig.transform(point, ROOT_BONE, new Vector3()), radius]),
      ];
      for (const [point, radius] of regions) {
        const center = project(point);
        if (Math.hypot(x - center.x, y - center.y) < projectedRadius(point, radius)) return "dragon";
      }
      return null;
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth));
      height = Math.max(1, Math.round(nextHeight));
      layout = width / height < 1 ? PORTRAIT : LANDSCAPE;
      fitStandingShot(layout.stand, standShot);
      rebuildText();
      updateCamera();
      applyTier(tierIndex);
      if (options.staticFrame) renderStatic();
    },
    start() {
      if (running || options.staticFrame) return;
      running = true;
      lastTime = 0;
      frameHandle = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frameHandle);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(frameHandle);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      fire.dispose();
      smoke.dispose();
      pipeline.dispose();
      dragon.geometry.dispose();
      (dragon.material as ShaderMaterial).dispose();
      if (textMesh) {
        textMesh.geometry.dispose();
        (textMesh.material as ShaderMaterial).dispose();
      }
      renderer.dispose();
    },
  };
  return api;
}
