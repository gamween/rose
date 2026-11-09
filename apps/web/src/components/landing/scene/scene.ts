import {
  Color,
  Group,
  InstancedBufferAttribute,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { FAR_WING_BONE, HEAD_BONE, JOINTS, buildDragonInSteps, type DragonModel } from "@/lib/voxel/dragon";
import { sequenceAt, lerp, clamp01, smoothstep, type SequenceState } from "@/lib/landing/timeline";
import { QUALITY_TIERS, createQualityState, sampleFrame, type QualityState, type QualityTier } from "@/lib/landing/quality";
import { ParticlePool, instancedBox } from "./particles";
import { DitherPipeline } from "./post";
import { DragonRig } from "./rig";
import {
  backdropFragment,
  backdropVertex,
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
  setProgress: (progress: number) => void;
  setPointer: (x: number, y: number) => void;
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
const BACKDROP_Z = -130;
const SLEEP_PITCH = 1.05;
const SLEEP_YAW = -0.22;
const WAKE_PITCH = -0.1;
/** Largest lift of the head toward the jet (radians, in the picture plane). */
const MAX_LIFT = 1.9;
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

/** Composition per orientation. */
type Layout = {
  /** The dragon asleep at the bottom of the frame, under the phrase. */
  open: Shot;
  /** The close-up the camera dollies into, where the dragon breathes fire. */
  close: Shot;
  /** The final frame: the dragon asleep, small in the dark. */
  far: Shot;
  /** Share of the screen width the phrase spans at rest, and how much wider it grows. */
  textShare: number;
  textGrow: number;
  /** Vertical position of the phrase (NDC) at rest and at the end of its rise. */
  textY: number;
  textTop: number;
  /** Furthest the jet reaches toward the screen edges (NDC). */
  sweepEdge: number;
  /** Fire emission and particle size relative to the landscape jet. */
  fireScale: number;
};

const LANDSCAPE: Layout = {
  open: { share: 0.42, x: 0, y: -0.6, elevation: 0.14 },
  close: { share: 0.85, x: 0.3, y: -0.62, elevation: 0.08 },
  far: { share: 0.22, x: 0, y: -0.12, elevation: 0.2 },
  textShare: 0.54,
  textGrow: 0.45,
  textY: 0.16,
  textTop: 0.62,
  sweepEdge: 0.88,
  fireScale: 1,
};

const PORTRAIT: Layout = {
  open: { share: 0.9, x: 0, y: -0.62, elevation: 0.14 },
  close: { share: 1.3, x: 0.5, y: -0.62, elevation: 0.08 },
  far: { share: 0.5, x: 0, y: -0.1, elevation: 0.2 },
  textShare: 0.8,
  textGrow: 0.1,
  textY: 0.14,
  textTop: 0.56,
  sweepEdge: 0.92,
  fireScale: 0.6,
};

function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

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
  geometry.instanceCount = text.count;
  const mesh = new Mesh(geometry, new ShaderMaterial({ vertexShader: textVertex, fragmentShader: textFragment, uniforms }));
  mesh.frustumCulled = false;
  return mesh;
}

/** Ends the current task so the browser can paint and handle input between the setup steps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Bounds of the dragon in its rest pose: the width the shots frame and the point they center. */
function dragonFrame(model: DragonModel): { width: number; focus: Vector3; front: number } {
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const point = new Vector3();
  for (let i = 0; i < model.count; i += 1) {
    point.fromArray(model.positions, i * 3);
    min.min(point);
    max.max(point);
  }
  return { width: max.x - min.x, focus: new Vector3((min.x + max.x) / 2, min.y + 0.35 * (max.y - min.y), (min.z + max.z) / 2), front: max.z };
}

/**
 * Builds the scene in short tasks: the voxel dragon first (pure CPU, one task per body part), then
 * the GPU objects, so the page stays responsive while the landing loads.
 */
export async function createLandingScene(options: SceneOptions): Promise<LandingScene> {
  const { canvas } = options;
  const model = await buildDragonInSteps(nextTask);
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(new Color(0x000000), 1);
  renderer.autoClear = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 2400);
  const pipeline = new DitherPipeline(renderer);
  const { anchors } = model;
  const frame = dragonFrame(model);
  const restSnout = Math.atan2(anchors.mouth[1] - anchors.head[1], anchors.mouth[0] - anchors.head[0]);
  const rig = new DragonRig();

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
    uBreath: { value: 0.5 },
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

  const backdropUniforms = {
    uGlow: { value: [new Vector4(), new Vector4(), new Vector4()] },
    uGlowColor: { value: [new Vector3(1, 0.32, 0.1), new Vector3(1, 0.5, 0.16), new Vector3(0.9, 0.2, 0.12)] },
    uHaze: { value: new Vector4(frame.focus.x, 0, 130, 0) },
  };
  const backdrop = new Mesh(
    new PlaneGeometry(2600, 1600),
    new ShaderMaterial({ vertexShader: backdropVertex, fragmentShader: backdropFragment, uniforms: backdropUniforms }),
  );
  backdrop.position.set(0, 40, BACKDROP_Z);
  backdrop.frustumCulled = false;
  scene.add(backdrop);

  const textUniforms = {
    ...lightUniforms,
    uTime: time,
    uWidth: { value: 1 },
    uCracks: { value: new Vector2(-1, -1) },
    uSweep: { value: -1 },
    uShatter: { value: 0 },
    uFire: { value: 0 },
    uRose: { value: 0 },
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
  let progress = 0;
  let state: SequenceState = sequenceAt(0);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const pose = { pitch: SLEEP_PITCH, yaw: SLEEP_YAW, lift: 0, jaw: 0, wingFold: 1 };
  const shot: Shot = { ...LANDSCAPE.open };
  const shotScratch: Shot = { ...LANDSCAPE.open };
  let fireAccumulator = 0;
  let smokeAccumulator = 0;
  let sparkAccumulator = 0;
  let debrisAccumulator = 0;
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
  const neckTop = new Vector3();
  const jetDirection = new Vector3(1, 0, 0);
  const jetTarget = new Vector3();
  const flameMid = new Vector3();
  const headLight = new Vector3();
  const headLightColor = new Vector3(0.75, 0.42, 0.3);
  const lastJoint = JOINTS[JOINTS.length - 1]!;

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

  function updateCamera(dt: number): void {
    layout = width / height < 1 ? PORTRAIT : LANDSCAPE;
    mixShot(mixShot(layout.open, layout.close, state.dolly, shotScratch), layout.far, state.retreat, shot);
    const aspect = width / height;
    const distance = frame.width / (shot.share * 2 * TAN_HALF_FOV * aspect);
    const halfHeight = distance * TAN_HALF_FOV;
    pointer.sx = damp(pointer.sx, pointer.x, 2.5, dt);
    pointer.sy = damp(pointer.sy, pointer.y, 2.5, dt);
    const driftX = (pointer.sx * 0.03 + Math.sin(time.value * 0.21) * 0.012) * halfHeight;
    const driftY = (pointer.sy * 0.02 + Math.sin(time.value * 0.17) * 0.006) * halfHeight;

    camera.aspect = aspect;
    camera.rotation.set(-shot.elevation, 0, 0);
    forward.set(0, -Math.sin(shot.elevation), -Math.cos(shot.elevation));
    up.set(0, Math.cos(shot.elevation), -Math.sin(shot.elevation));
    camera.position
      .copy(frame.focus)
      .addScaledVector(forward, -distance)
      .addScaledVector(right, -shot.x * halfHeight * aspect + driftX)
      .addScaledVector(up, -shot.y * halfHeight - driftY);
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

  function updateText(): void {
    if (!text) return;
    const rise = 1 - (1 - state.phrase) ** 2;
    phrase.y = lerp(layout.textY, layout.textTop, rise);
    phrase.share = layout.textShare * (1 + layout.textGrow * rise);
    phrase.left = Math.max(-phrase.share - 0.06, -layout.sweepEdge);
    phrase.right = Math.min(phrase.share + 0.06, layout.sweepEdge);
    onPlane(0, phrase.y, TEXT_Z, textGroup.position);
    const visibleWidth = 2 * depthOf(textGroup.position) * TAN_HALF_FOV * camera.aspect;
    textGroup.scale.setScalar((phrase.share * visibleWidth) / text.width);
    textGroup.quaternion.copy(camera.quaternion);
    textGroup.visible = state.shatter < 1;
    textGroup.updateMatrixWorld();
    textUniforms.uCracks.value.set(crackFront(state.cracks[0]), crackFront(state.cracks[1]));
    textUniforms.uSweep.value = acrossPhrase(state.aim);
    textUniforms.uShatter.value = state.shatter * 1.1;
    textUniforms.uFire.value = state.fire;
    textUniforms.uRose.value = state.rose;
    onPlane(lerp(phrase.left, phrase.right, state.aim), phrase.y, FIRE_Z, jetTarget);
    updateVeil();
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
    dragonUniforms.uVeil.value = VEIL_STRENGTH * (1 - smoothstep(0, 0.4, state.shatter));
  }

  function updatePose(dt: number): void {
    const awake = state.wake * (1 - state.sleep);
    rig.transform(lastJoint, HEAD_BONE - 1, neckTop);
    const toTarget = Math.atan2(jetTarget.y - neckTop.y, jetTarget.x - neckTop.x);
    const liftGoal = Math.min(MAX_LIFT, Math.max(0, toTarget - restSnout)) * awake;
    const idlePitch = WAKE_PITCH + Math.sin(time.value * 0.5) * 0.025;
    const idleYaw = Math.sin(time.value * 0.33) * 0.04;
    const pitchGoal = lerp(lerp(SLEEP_PITCH, idlePitch, state.wake), SLEEP_PITCH, state.sleep);
    const yawGoal = lerp(lerp(SLEEP_YAW, idleYaw, state.wake), SLEEP_YAW, state.sleep);
    pose.pitch = damp(pose.pitch, pitchGoal, 3.5, dt);
    pose.yaw = damp(pose.yaw, yawGoal, 3.5, dt);
    pose.lift = damp(pose.lift, liftGoal, 7, dt);
    pose.jaw = damp(pose.jaw, Math.min(1, state.fire * 1.4), 6, dt);
    pose.wingFold = damp(pose.wingFold, 1 - awake, 2.5, dt);
    rig.update(pose);
    rig.transform(anchors.mouth, HEAD_BONE, mouth);
    jetDirection.copy(jetTarget).sub(mouth).normalize();
  }

  function simulate(dt: number): void {
    const tier = QUALITY_TIERS[tierIndex]!;
    const unit = depthOf(mouth) / PARTICLE_UNIT_DISTANCE;
    const jetLength = jetTarget.distanceTo(mouth);
    fireAccumulator += state.fire * 420 * layout.fireScale * dt * (tier.particles / maxParticles + 0.3);
    while (fireAccumulator >= 1) {
      fireAccumulator -= 1;
      const speed = jetLength * random(1.15, 1.5);
      const spread = 0.1;
      const along = Math.random() ** 2 * 0.7;
      fire.spawn({
        x: mouth.x + jetDirection.x * speed * along + random(-0.8, 0.8) * unit,
        y: mouth.y + jetDirection.y * speed * along + random(-0.8, 0.8) * unit,
        z: mouth.z + jetDirection.z * speed * along + random(-0.8, 0.8) * unit,
        vx: (jetDirection.x + random(-spread, spread)) * speed,
        vy: (jetDirection.y + random(-spread, spread)) * speed,
        vz: (jetDirection.z + random(-spread * 0.5, spread * 0.5)) * speed,
        life: random(1.1, 1.5),
        size: random(0.6, 1.1) * unit * (0.5 + 0.5 * layout.fireScale),
        growth: random(0.8, 1.6),
        kind: 0,
        age: along,
      });
    }

    if (text && textMesh && textGroup.visible) {
      if (roseVoxels.length > 0 && state.shatter < 0.4) {
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
      debrisAccumulator += state.shatter > 0 ? 160 * layout.fireScale * dt : 0;
      const shatter = state.shatter * 1.1;
      while (debrisAccumulator >= 1) {
        debrisAccumulator -= 1;
        const index = Math.floor(Math.random() * text.count);
        const delay = (text.cracks[index * 4 + 2]! / text.width + 0.5) * 0.55 + text.cracks[index * 4 + 1]! * 0.3;
        const broken = (shatter - delay) / 0.25;
        if (broken <= 0 || broken >= 0.6) continue;
        const world = textGroup.localToWorld(scratch.set(text.offsets[index * 3]!, text.offsets[index * 3 + 1]!, 1.2));
        fire.spawn({
          x: world.x,
          y: world.y,
          z: world.z,
          vx: random(-3, 3) * unit,
          vy: random(-1, 5) * unit,
          vz: random(-1, 1),
          life: random(0.8, 1.8),
          size: textGroup.scale.x * random(0.4, 0.8),
          growth: -0.7,
          kind: 1,
        });
      }
    }

    smokeAccumulator += (state.smoke * 12 + state.wake * (1 - state.fire) * (1 - state.sleep) * 3) * dt;
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
    fireColor!.set(1.3, 0.5, 0.14).multiplyScalar(state.fire * 1.4);
    tailPos!.set(anchors.tailTip[0], anchors.tailTip[1] + 4, anchors.tailTip[2] + 3);
    tailColor!.set(1.6, 0.55, 0.14).multiplyScalar(state.tail * (0.7 + 0.5 * state.sleep));
    // Light 2 glows from "rose" while the phrase is whole, then becomes a low warm light just above
    // the sleeping head so its silhouette (snout, horns, closed eye) stays readable.
    const whole = 1 - smoothstep(0, 0.5, state.shatter);
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
    dragonUniforms.uBreath.value = lerp(lerp(0.5, 1.1, state.wake), 0.5, state.sleep);

    const [chestGlow, fireGlow, tailGlow] = backdropUniforms.uGlow.value;
    const wide = 1 - 0.7 * state.retreat;
    chestGlow!.set(anchors.chest[0] + 10, anchors.chest[1] + 16, 150, 0.008 * state.light * (1 - 0.4 * state.sleep) * wide);
    fireGlow!.set(flameMid.x, flameMid.y, 110, 0.012 * state.fire);
    tailGlow!.set(anchors.tailTip[0], anchors.tailTip[1] + 4, 60, 0.014 * state.tail);
    backdropUniforms.uHaze.value.w = 0.05 * state.light * wide;
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
    state = sequenceAt(progress);
    updateCamera(dt);
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
    progress = 1;
    pose.pitch = SLEEP_PITCH;
    pose.yaw = SLEEP_YAW;
    pose.lift = 0;
    pose.wingFold = 1;
    fade = 1;
    for (let i = 0; i < 180; i += 1) {
      time.value += 1 / 30;
      state = sequenceAt(1);
      updateCamera(1 / 30);
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
      progress = clamp01(value);
    },
    setPointer(x, y) {
      pointer.x = x;
      pointer.y = y;
    },
    hitTest(x, y) {
      const tip = new Vector3(...anchors.tailTip);
      const tail = project(tip);
      if (Math.hypot(x - tail.x, y - tail.y) < Math.max(24, projectedRadius(tip, 7))) return "tail";
      const regions: [Vector3, number][] = [
        [rig.transform(anchors.head, HEAD_BONE, new Vector3()), 13],
        ...JOINTS.map((joint, i): [Vector3, number] => [rig.transform(joint, i, new Vector3()), 8]),
        [rig.transform(anchors.farWingElbow, FAR_WING_BONE, new Vector3()), 14],
        ...anchors.body.map(({ point, radius }): [Vector3, number] => [new Vector3(...point), radius]),
        ...anchors.tail.map(({ point, radius }): [Vector3, number] => [new Vector3(...point), radius]),
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
      rebuildText();
      updateCamera(0);
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
      backdrop.geometry.dispose();
      backdrop.material.dispose();
      if (textMesh) {
        textMesh.geometry.dispose();
        (textMesh.material as ShaderMaterial).dispose();
      }
      renderer.dispose();
    },
  };
  return api;
}
