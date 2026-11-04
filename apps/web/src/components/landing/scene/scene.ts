import {
  Color,
  Group,
  InstancedBufferAttribute,
  Matrix4,
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
import { buildVoxelText, type VoxelText } from "./text";

export type SceneStats = { fps: number; frameMs: number; tier: QualityTier["name"]; particles: number };

export type FrameAnchors = {
  /** Glowing tail tip in CSS pixels relative to the canvas. */
  tail: { x: number; y: number };
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
const TEXT_Z = 60;
const BACKDROP_Z = -130;
/** The fire travels in a plane just behind the phrase, so it never covers the letters. */
const FIRE_Z = 50;
const SLEEP_PITCH = 1.05;
const SLEEP_YAW = -0.22;
const IDLE_PITCH = 0.08;
/** How much the dragon darkens behind the phrase, so the letters always read on a dark band. */
const VEIL_STRENGTH = 0.82;
/** Render pixels per voxel of the phrase below which letters lose rows to aliasing. */
const MIN_TEXT_PIXELS_PER_VOXEL = 1.7;

/** Composition per orientation: camera framing, phrase placement and where the dragon stands. */
type Layout = {
  cameraHeight: number;
  lookAtY: number;
  fitWidth: number;
  fitHeight: number;
  textX: number;
  textY: number;
  textShare: number;
  dragonScale: number;
  dragonPosition: Vector3;
  dragonYaw: number;
  /** Fire emission and particle size relative to the landscape jet. */
  fireScale: number;
};

const LANDSCAPE: Layout = {
  cameraHeight: 44,
  lookAtY: 28,
  fitWidth: 130,
  fitHeight: 76,
  textX: 20,
  textY: 36,
  textShare: 0.54,
  dragonScale: 1,
  dragonPosition: new Vector3(6, 0, 0),
  dragonYaw: 0,
  fireScale: 1,
};

const PORTRAIT: Layout = {
  cameraHeight: 58,
  lookAtY: 24,
  fitWidth: 78,
  fitHeight: 150,
  textX: 2,
  textY: 46,
  textShare: 0.84,
  dragonScale: 0.62,
  dragonPosition: new Vector3(12, -8, 0),
  dragonYaw: 0.1,
  fireScale: 0.5,
};

function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

function random(min: number, max: number): number {
  return min + Math.random() * (max - min);
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
  const geometry = instancedBox(1, 1, 2.2);
  geometry.setAttribute("aOffset", new InstancedBufferAttribute(text.offsets, 3));
  geometry.setAttribute("aLetter", new InstancedBufferAttribute(text.letters, 3));
  geometry.instanceCount = text.count;
  const mesh = new Mesh(geometry, new ShaderMaterial({ vertexShader: textVertex, fragmentShader: textFragment, uniforms }));
  mesh.frustumCulled = false;
  return mesh;
}

/** Ends the current task so the browser can paint and handle input between the setup steps. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const camera = new PerspectiveCamera(FOV, 1, 1, 700);
  const pipeline = new DitherPipeline(renderer);
  const { anchors } = model;
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
    uBreath: { value: 1.1 },
    uBody: { value: 0 },
    uEyes: { value: 0 },
    uEyelid: { value: 1 },
    uFire: { value: 0 },
    uTail: { value: 0 },
    uSmoke: { value: 0 },
    uBackGlow: { value: 0 },
    uChest: { value: new Vector3(...anchors.chest) },
    uEyeCenter: { value: new Vector3(...anchors.eye) },
    uVeilBox: { value: new Vector4(0, 0, 0, 0) },
    uVeilSoft: { value: new Vector2(0.08, 0.12) },
    uVeil: { value: 0 },
  };
  const dragonGroup = new Group();
  const dragon = createDragonMesh(model, dragonUniforms);
  dragonGroup.add(dragon);
  scene.add(dragonGroup);

  const backdropUniforms = {
    uGlow: { value: [new Vector4(), new Vector4(), new Vector4()] },
    uGlowColor: { value: [new Vector3(1, 0.32, 0.1), new Vector3(1, 0.5, 0.16), new Vector3(0.9, 0.2, 0.12)] },
    uHaze: { value: 0 },
  };
  const backdrop = new Mesh(
    new PlaneGeometry(520, 360),
    new ShaderMaterial({ vertexShader: backdropVertex, fragmentShader: backdropFragment, uniforms: backdropUniforms }),
  );
  backdrop.position.set(0, 40, BACKDROP_Z);
  backdrop.frustumCulled = false;
  scene.add(backdrop);

  const textUniforms = {
    ...lightUniforms,
    uTime: time,
    uFront: { value: 0 },
    uFire: { value: 0 },
    uRose: { value: 0 },
  };
  const textGroup = new Group();
  scene.add(textGroup);
  let text: VoxelText | null = null;
  let textMesh: Mesh | null = null;
  let roseVoxels: number[] = [];
  let lines: 1 | 2 = 1;
  let textBase = { y: 0, scale: 1, visibleHeight: 1 };

  const maxParticles = QUALITY_TIERS[0]!.particles;
  const jetUniforms = { uFrontPoint: { value: new Vector3() }, uFrontDir: { value: new Vector3(1, 0, 0) } };
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
  const pose = { pitch: IDLE_PITCH, yaw: 0, jaw: 0, wingFold: 0 };
  let fireMix = 0;
  let fireAccumulator = 0;
  let smokeAccumulator = 0;
  let sparkAccumulator = 0;
  let running = false;
  let frameHandle = 0;
  let lastTime = 0;
  let fade = 0;
  const statWindow = { frames: 0, elapsed: 0, last: 0 };
  const scratch = new Vector3();
  const mouth = new Vector3();
  const jetDirection = new Vector3(1, 0, 0);
  const jetTarget = new Vector3();
  const flameMid = new Vector3();
  const headLight = new Vector3();
  const headLightColor = new Vector3(0.75, 0.42, 0.3);
  const toLocal = new Matrix4();

  /** CSS pixels per voxel of the phrase at rest (before it grows on exit). */
  function cssPixelsPerTextVoxel(): number {
    return (textBase.scale * height) / Math.max(textBase.visibleHeight, 1e-3);
  }

  function applyTier(index: number): void {
    tierIndex = index;
    const tier = QUALITY_TIERS[index]!;
    // Narrow screens draw the phrase small: keep enough render pixels per voxel for the letters to
    // stay legible whatever the tier (a 375 px screen stays far below the desktop pixel count).
    const textFloor = MIN_TEXT_PIXELS_PER_VOXEL / Math.max(cssPixelsPerTextVoxel(), 1e-3);
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
    roseVoxels = [];
    for (let i = 0; i < text.count; i += 1) if ((text.letters[i * 3 + 1] ?? 0) > 0.5) roseVoxels.push(i);
  }

  function frameCamera(): void {
    const aspect = width / height;
    layout = aspect < 1 ? PORTRAIT : LANDSCAPE;
    camera.aspect = aspect;
    const tan = Math.tan((FOV * Math.PI) / 360);
    const textDistance = Math.max(layout.fitHeight / (2 * tan), layout.fitWidth / (2 * tan * aspect));
    camera.position.set(0, layout.cameraHeight, TEXT_Z + textDistance);
    camera.lookAt(0, layout.lookAtY, 0);
    camera.updateProjectionMatrix();

    dragonGroup.position.copy(layout.dragonPosition);
    dragonGroup.scale.setScalar(layout.dragonScale);
    dragonGroup.rotation.y = layout.dragonYaw;
    dragonGroup.updateMatrixWorld();

    if (!text) return;
    const visibleHeight = 2 * textDistance * tan;
    const visibleWidth = visibleHeight * aspect;
    const scale = Math.min((visibleWidth * layout.textShare) / text.width, (visibleHeight * 0.26) / text.height);
    textBase = { y: layout.textY, scale, visibleHeight };
  }

  /** World position of the letter at the flame front (or the next one when `ahead` is set). */
  function letterTarget(front: number, out: Vector3): Vector3 {
    if (!text || text.letterCenters.length === 0) return out.set(layout.textX, textBase.y, TEXT_Z);
    const centers = text.letterCenters;
    let chosen = centers[0]!;
    for (const center of centers) if (center.order <= front + 0.02) chosen = center;
    return textGroup.localToWorld(out.set(chosen.x, chosen.y, 0));
  }

  function updateText(): void {
    const exit = state.phraseExit;
    const rise = exit * exit * (3 - 2 * exit);
    const lift = exit * exit;
    textGroup.scale.setScalar(textBase.scale * (1 + 1.6 * lift));
    textGroup.position.set(layout.textX * (1 - rise), textBase.y + rise * textBase.visibleHeight * 1.25, TEXT_Z);
    textGroup.visible = exit < 0.999;
    textGroup.updateMatrixWorld();
    textUniforms.uFront.value = state.front;
    textUniforms.uFire.value = state.fire;
    textUniforms.uRose.value = state.rose;
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
    dragonUniforms.uVeil.value = VEIL_STRENGTH * (1 - smoothstep(0, 0.45, state.phraseExit));
  }

  function updatePose(dt: number): void {
    const breathing = progress > 0.3 && progress < 0.72 ? 1 : 0;
    fireMix = damp(fireMix, breathing, 3, dt);
    letterTarget(state.front + 0.1 * state.fire, jetTarget).setZ(FIRE_Z);
    toLocal.copy(dragonGroup.matrixWorld).invert();
    const localTarget = scratch.copy(jetTarget).applyMatrix4(toLocal);
    const skull = anchors.head;
    const dx = localTarget.x - skull[0];
    const dy = localTarget.y - skull[1];
    const dz = localTarget.z - skull[2];
    const aimYaw = Math.max(-0.5, Math.min(0.5, -Math.atan2(dz, dx) * 0.8));
    const aimPitch = Math.max(-0.7, Math.min(0.5, Math.atan2(-dy, Math.hypot(dx, dz)) * 0.8));
    const idlePitch = IDLE_PITCH + Math.sin(time.value * 0.5) * 0.025;
    const idleYaw = Math.sin(time.value * 0.33) * 0.04;
    let pitchGoal = lerp(idlePitch, aimPitch, fireMix);
    let yawGoal = lerp(idleYaw, aimYaw, fireMix);
    pitchGoal = lerp(pitchGoal, SLEEP_PITCH, state.sleep);
    yawGoal = lerp(yawGoal, SLEEP_YAW, state.sleep);
    pose.pitch = damp(pose.pitch, pitchGoal, 3.5, dt);
    pose.yaw = damp(pose.yaw, yawGoal, 3.5, dt);
    pose.jaw = damp(pose.jaw, Math.min(1, state.fire * 1.4), 6, dt);
    pose.wingFold = damp(pose.wingFold, state.sleep, 2.5, dt);
    rig.update(pose);
    dragonGroup.localToWorld(rig.transform(anchors.mouth, HEAD_BONE, mouth));
    jetDirection.copy(jetTarget).sub(mouth).normalize();
  }

  function simulate(dt: number): void {
    const tier = QUALITY_TIERS[tierIndex]!;
    const jetLength = jetTarget.distanceTo(mouth);
    fireAccumulator += state.fire * 420 * layout.fireScale * dt * (tier.particles / maxParticles + 0.3);
    while (fireAccumulator >= 1) {
      fireAccumulator -= 1;
      const speed = random(50, 72);
      const spread = 0.11;
      const along = Math.random() ** 2 * Math.min(1, jetLength / speed) * 0.8;
      fire.spawn({
        x: mouth.x + jetDirection.x * speed * along + random(-0.8, 0.8),
        y: mouth.y + jetDirection.y * speed * along + random(-1.2, 1.2),
        z: mouth.z + jetDirection.z * speed * along + random(-0.8, 0.8),
        vx: (jetDirection.x + random(-spread, spread)) * speed,
        vy: (jetDirection.y + random(-spread, spread)) * speed,
        vz: (jetDirection.z + random(-spread * 0.5, spread * 0.5)) * speed,
        life: random(1.1, 1.5),
        size: random(0.6, 1.1) * layout.dragonScale * (0.5 + 0.5 * layout.fireScale),
        growth: random(0.8, 1.6),
        kind: 0,
        age: along,
      });
    }

    if (text && textMesh && roseVoxels.length > 0 && state.phraseExit < 0.9) {
      sparkAccumulator += (2 + 10 * state.rose) * dt;
      while (sparkAccumulator >= 1) {
        sparkAccumulator -= 1;
        const index = roseVoxels[Math.floor(Math.random() * roseVoxels.length)]!;
        const world = textGroup.localToWorld(scratch.set(text.offsets[index * 3]!, text.offsets[index * 3 + 1]!, 1.2));
        fire.spawn({
          x: world.x,
          y: world.y,
          z: world.z,
          vx: random(-0.6, 0.6),
          vy: random(2.5, 5.5),
          vz: random(-0.4, 0.4),
          life: random(1.4, 2.6),
          size: textGroup.scale.x * 0.7,
          growth: -0.6,
          kind: 1,
        });
      }
    }

    smokeAccumulator += (state.smoke * 12 + fireMix * (1 - state.fire) * 3) * dt;
    while (smokeAccumulator >= 1) {
      smokeAccumulator -= 1;
      const nostril = anchors.nostrils[Math.random() < 0.5 ? 0 : 1]!;
      dragonGroup.localToWorld(rig.transform(nostril, HEAD_BONE, scratch));
      smoke.spawn({
        x: scratch.x + random(-0.3, 0.3),
        y: scratch.y + random(0, 0.5),
        z: scratch.z + random(-0.3, 0.3),
        vx: random(0.6, 1.6) * layout.dragonScale,
        vy: random(1.6, 2.6) * layout.dragonScale,
        vz: random(-0.2, 0.3),
        life: random(3.5, 6),
        size: random(0.45, 0.8) * layout.dragonScale,
        growth: random(0.6, 1.2),
        kind: 2,
      });
    }

    jetUniforms.uFrontPoint.value.copy(jetTarget);
    jetUniforms.uFrontDir.value.copy(jetDirection);
    fire.update(dt, time.value, 0.45, 5, 9, { z: FIRE_Z, y: jetTarget.y, stiffness: 14 });
    smoke.update(dt, time.value, 0.3, 0.35, 1.4);

    flameMid.copy(mouth).lerp(jetTarget, 0.7);
    const [firePos, tailPos, rosePos] = lightUniforms.uLightPos.value;
    const [fireColor, tailColor, roseColor, fillColor] = lightUniforms.uLightColor.value;
    firePos!.copy(flameMid);
    fireColor!.set(1.3, 0.5, 0.14).multiplyScalar(state.fire);
    dragonGroup.localToWorld(tailPos!.set(anchors.tailTip[0], anchors.tailTip[1] + 4, anchors.tailTip[2] + 3));
    tailColor!.set(1.6, 0.55, 0.14).multiplyScalar(state.tail * (0.7 + 0.5 * state.sleep));
    // Light 2 glows from "rose" while the phrase is on screen, then becomes a low warm light just
    // above the sleeping head so its silhouette (snout, horns, closed eye) stays readable.
    const awake = 1 - state.phraseExit;
    letterTarget(0.9, rosePos!).setZ(TEXT_Z - 16);
    dragonGroup.localToWorld(rig.transform(anchors.head, HEAD_BONE, headLight)).add(scratch.set(4, 14, 16).multiplyScalar(layout.dragonScale));
    rosePos!.lerp(headLight, state.phraseExit);
    roseColor!.set(0.9, 0.22, 0.06).multiplyScalar(state.rose * awake * 0.9).addScaledVector(headLightColor, state.sleep * 1.25);
    fillColor!.set(0.35, 0.22, 0.18).multiplyScalar(state.body * (1 - 0.55 * state.sleep));
    lightUniforms.uKeyColor.value.set(0.95, 0.62, 0.5).multiplyScalar(state.body * (1 - 0.35 * state.sleep) * (0.85 + 0.15 * Math.sin(time.value * 0.8)));
    lightUniforms.uRimColor.value.set(1.6, 0.7, 0.9).lerp(scratch.set(1.3, 0.95, 1.2), state.sleep).multiplyScalar(state.body * (1 + 0.25 * state.sleep));

    dragonUniforms.uBody.value = state.body;
    dragonUniforms.uEyes.value = state.eyes;
    dragonUniforms.uEyelid.value = state.eyelid;
    dragonUniforms.uFire.value = state.fire;
    dragonUniforms.uTail.value = state.tail;
    dragonUniforms.uSmoke.value = state.smoke;
    dragonUniforms.uBackGlow.value = 0.05 * state.body * (1 - state.sleep) + 0.4 * state.fire;
    dragonUniforms.uBreath.value = lerp(1.1, 0.5, state.sleep);

    const [chestGlow, fireGlow, tailGlow] = backdropUniforms.uGlow.value;
    const chest = dragonGroup.localToWorld(scratch.set(...anchors.chest));
    chestGlow!.set(chest.x + 10, chest.y + 16, 150, 0.008 * state.body * (1 - 0.4 * state.sleep));
    fireGlow!.set(flameMid.x, flameMid.y, 110, 0.012 * state.fire);
    const tail = dragonGroup.localToWorld(scratch.set(...anchors.tailTip));
    tailGlow!.set(tail.x, tail.y + 4, 60, 0.014 * state.tail);
    backdropUniforms.uHaze.value = 0.05 * state.body;
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

  function updateCamera(dt: number): void {
    pointer.sx = damp(pointer.sx, pointer.x, 2.5, dt);
    pointer.sy = damp(pointer.sy, pointer.y, 2.5, dt);
    const drift = Math.sin(time.value * 0.21) * 2.5;
    const settle = state.sleep * 7;
    camera.position.x = pointer.sx * 4 + drift;
    camera.position.y = layout.cameraHeight + pointer.sy * 2 + Math.sin(time.value * 0.17) * 0.8 - settle;
    camera.lookAt(0, layout.lookAtY - settle * 0.6, 0);
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

  function tailAnchor(): Vector3 {
    return dragonGroup.localToWorld(new Vector3(...anchors.tailTip));
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
    options.onFrame?.({ tail: project(tailAnchor()), launchReady: state.launchReady });
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
    options.onFrame?.({ tail: project(tailAnchor()), launchReady: true });
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
      const tip = tailAnchor();
      const tail = project(tip);
      if (Math.hypot(x - tail.x, y - tail.y) < Math.max(30, projectedRadius(tip, 7 * layout.dragonScale))) return "tail";
      const regions: [Vector3, number][] = [
        [dragonGroup.localToWorld(rig.transform(anchors.head, HEAD_BONE, new Vector3())), 13],
        ...JOINTS.map((joint, i): [Vector3, number] => [dragonGroup.localToWorld(rig.transform(joint, i, new Vector3())), 8]),
        [dragonGroup.localToWorld(rig.transform(anchors.farWingElbow, FAR_WING_BONE, new Vector3())), 14],
        ...anchors.body.map(({ point, radius }): [Vector3, number] => [dragonGroup.localToWorld(new Vector3(...point)), radius]),
        ...anchors.tail.map(({ point, radius }): [Vector3, number] => [dragonGroup.localToWorld(new Vector3(...point)), radius]),
      ];
      for (const [point, radius] of regions) {
        const center = project(point);
        if (Math.hypot(x - center.x, y - center.y) < projectedRadius(point, radius * layout.dragonScale)) return "dragon";
      }
      return null;
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth));
      height = Math.max(1, Math.round(nextHeight));
      rebuildText();
      frameCamera();
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
