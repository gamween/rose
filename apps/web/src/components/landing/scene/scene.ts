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
  WebGLRenderer,
} from "three";
import { buildDragon, type DragonModel } from "@/lib/voxel/dragon";
import type { Vec3 } from "@/lib/voxel/grid";
import { sequenceAt, lerp, clamp01, type SequenceState } from "@/lib/landing/timeline";
import { QUALITY_TIERS, createQualityState, sampleFrame, type QualityState, type QualityTier } from "@/lib/landing/quality";
import { ParticlePool, instancedBox } from "./particles";
import { DitherPipeline } from "./post";
import {
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
  /** Tail tip in CSS pixels relative to the canvas. */
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
  setProgress: (progress: number) => void;
  setPointer: (x: number, y: number) => void;
  hitTest: (x: number, y: number) => HitTarget;
  resize: (width: number, height: number) => void;
  start: () => void;
  stop: () => void;
  dispose: () => void;
};

const FOV = 32;
const TEXT_Z = 60;
const LOOK_AT = new Vector3(0, 30, 0);
const CAMERA_HEIGHT = 36;
const SLEEP_PITCH = 0.55;
const SLEEP_YAW = -0.12;

function bend(point: Vec3, pivot: Vec3, pitch: number, yaw: number, weight = 1): Vector3 {
  const p = pitch * weight;
  const y = yaw * weight;
  const lx = point[0] - pivot[0];
  const ly = point[1] - pivot[1];
  const lz = point[2] - pivot[2];
  const ry = ly * Math.cos(p) - lz * Math.sin(p);
  const rz = ly * Math.sin(p) + lz * Math.cos(p);
  const fx = lx * Math.cos(y) + rz * Math.sin(y);
  const fz = -lx * Math.sin(y) + rz * Math.cos(y);
  return new Vector3(fx + pivot[0], ry + pivot[1], fz + pivot[2]);
}

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

export function createLandingScene(options: SceneOptions): LandingScene {
  const { canvas } = options;
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  renderer.setClearColor(new Color(0x000000), 1);
  renderer.autoClear = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 600);
  const pipeline = new DitherPipeline(renderer);
  const model = buildDragon();
  const { anchors } = model;

  const lightUniforms = {
    uLightPos: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3(0, 90, 50)] },
    uLightColor: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
    uLightRange: { value: [30, 9, 30, 160] },
  };
  const time = { value: 0 };

  const dragonUniforms = {
    ...lightUniforms,
    uTime: time,
    uBreath: { value: 1.2 },
    uBody: { value: 0 },
    uEyes: { value: 0 },
    uEyelid: { value: 1 },
    uFire: { value: 0 },
    uTail: { value: 0 },
    uSmoke: { value: 0 },
    uBackGlow: { value: 0 },
    uPivot: { value: new Vector3(...anchors.neckPivot) },
    uPitch: { value: 0.1 },
    uYaw: { value: 0 },
    uEyeCenter: { value: new Vector3(0, anchors.eyes[0]![1], anchors.eyes[0]![2]) },
  };
  const dragon = createDragonMesh(model, dragonUniforms);
  scene.add(dragon);

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
  const fire = new ParticlePool(maxParticles, particleVertex, fireFragment, {
    additive: true,
    uniforms: { uFadeZ: { value: TEXT_Z + 4 } },
  });
  const smoke = new ParticlePool(420, particleVertex, smokeFragment, {
    additive: false,
    uniforms: { uFadeZ: { value: 1000 }, uSmokeColor: { value: new Vector3(0.13, 0.1, 0.09) } },
  });
  scene.add(fire.mesh, smoke.mesh);

  let tierIndex = options.forcedTier ?? options.initialTier;
  let quality: QualityState = createQualityState(tierIndex);
  let width = 1;
  let height = 1;
  let progress = 0;
  let state: SequenceState = sequenceAt(0);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const head = { pitch: 0.1, yaw: 0 };
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

  function applyTier(index: number): void {
    tierIndex = index;
    const tier = QUALITY_TIERS[index]!;
    renderer.setPixelRatio(tier.pixelRatio);
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
    camera.aspect = aspect;
    const tan = Math.tan((FOV * Math.PI) / 360);
    const needHeight = aspect < 1 ? 78 : 74;
    const needWidth = aspect < 1 ? 58 : 112;
    const distance = Math.max(needHeight / (2 * tan), needWidth / (2 * tan * aspect));
    camera.position.set(0, CAMERA_HEIGHT, distance);
    camera.lookAt(LOOK_AT);
    camera.updateProjectionMatrix();

    if (!text) return;
    const textDistance = distance - TEXT_Z;
    const visibleHeight = 2 * textDistance * tan;
    const visibleWidth = visibleHeight * aspect;
    const share = aspect < 1 ? 0.86 : Math.min(0.72, 1100 / width);
    const scale = Math.min((visibleWidth * share) / text.width, (visibleHeight * 0.3) / text.height);
    const centerY = CAMERA_HEIGHT + (LOOK_AT.y - CAMERA_HEIGHT) * (textDistance / distance);
    textBase = { y: centerY - visibleHeight * 0.04, scale, visibleHeight };
  }

  function letterTarget(front: number): Vector3 {
    if (!text || text.letterCenters.length === 0) return scratch.set(0, textBase.y, TEXT_Z);
    const centers = text.letterCenters;
    let chosen = centers[0]!;
    for (const center of centers) if (center.order <= front + 0.02) chosen = center;
    return textGroup.localToWorld(scratch.set(chosen.x, chosen.y, 0));
  }

  function updateText(): void {
    const exit = state.phraseExit;
    const scale = textBase.scale * (1 + 1.1 * exit * exit);
    textGroup.scale.setScalar(scale);
    textGroup.position.set(0, textBase.y + exit * exit * textBase.visibleHeight * 0.95, TEXT_Z);
    textGroup.visible = exit < 0.999;
    textGroup.updateMatrixWorld();
    textUniforms.uFront.value = state.front;
    textUniforms.uFire.value = state.fire;
    textUniforms.uRose.value = state.rose;
  }

  function simulate(dt: number): void {
    const inFire = progress > 0.3 && progress < 0.72 ? 1 : 0;
    fireMix = damp(fireMix, inFire, 3, dt);
    const target = letterTarget(state.front + 0.12 * state.fire).clone();
    const mouthIdle = bend(anchors.mouth, anchors.neckPivot, head.pitch, head.yaw);
    const aimYaw = Math.max(-0.55, Math.min(0.55, Math.atan2(target.x - anchors.neckPivot[0], target.z - anchors.neckPivot[2]) * 0.9));
    const aimPitch = Math.max(0.05, Math.min(0.55, Math.atan2(mouthIdle.y - target.y, target.z - mouthIdle.z) * 0.6));
    let pitchGoal = lerp(0.12 + Math.sin(time.value * 0.6) * 0.02, aimPitch, fireMix);
    let yawGoal = lerp(Math.sin(time.value * 0.35) * 0.05, aimYaw, fireMix);
    pitchGoal = lerp(pitchGoal, SLEEP_PITCH, state.sleep);
    yawGoal = lerp(yawGoal, SLEEP_YAW, state.sleep);
    head.pitch = damp(head.pitch, pitchGoal, 4, dt);
    head.yaw = damp(head.yaw, yawGoal, 4, dt);
    dragonUniforms.uPitch.value = head.pitch;
    dragonUniforms.uYaw.value = head.yaw;

    const mouth = bend(anchors.mouth, anchors.neckPivot, head.pitch, head.yaw);
    const direction = target.clone().sub(mouth).normalize();

    fireAccumulator += state.fire * 650 * dt * (QUALITY_TIERS[tierIndex]!.particles / maxParticles + 0.25);
    while (fireAccumulator >= 1) {
      fireAccumulator -= 1;
      const speed = random(48, 70);
      const spread = 0.09;
      fire.spawn({
        x: mouth.x + random(-0.8, 0.8),
        y: mouth.y + random(-0.6, 0.6),
        z: mouth.z + random(0, 1),
        vx: (direction.x + random(-spread, spread)) * speed,
        vy: (direction.y + random(-spread, spread)) * speed,
        vz: (direction.z + random(-spread * 0.5, spread * 0.5)) * speed,
        life: random(0.9, 1.3),
        size: random(0.5, 1.0),
        growth: random(1.0, 2.2),
        kind: 0,
      });
    }

    if (text && textMesh && roseVoxels.length > 0 && state.phraseExit < 0.9) {
      sparkAccumulator += (2 + 9 * state.rose) * dt;
      while (sparkAccumulator >= 1) {
        sparkAccumulator -= 1;
        const index = roseVoxels[Math.floor(Math.random() * roseVoxels.length)]!;
        const world = textGroup.localToWorld(
          scratch.set(text.offsets[index * 3]!, text.offsets[index * 3 + 1]!, 1.2),
        );
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

    smokeAccumulator += (state.smoke * 24 + fireMix * (1 - state.fire) * 4) * dt;
    while (smokeAccumulator >= 1) {
      smokeAccumulator -= 1;
      const side = Math.random() < 0.5 ? -1 : 1;
      smoke.spawn({
        x: mouth.x + side * random(0.5, 2),
        y: mouth.y + random(0, 1.5),
        z: mouth.z + random(-0.5, 0.5),
        vx: random(-0.9, 0.9),
        vy: random(1.2, 2.8),
        vz: random(-0.6, 0.8),
        life: random(3, 5.5),
        size: random(0.35, 0.7),
        growth: random(0.8, 1.6),
        kind: 2,
      });
    }

    fire.update(dt, time.value, 0.7, 8, 5);
    smoke.update(dt, time.value, 0.35, 0.6, 2.6);

    const fireLight = mouth.clone().addScaledVector(direction, 16);
    const [firePos, tailPos, rosePos] = lightUniforms.uLightPos.value;
    const [fireColor, tailColor, roseColor, fillColor] = lightUniforms.uLightColor.value;
    firePos!.copy(fireLight);
    fireColor!.set(1.9, 0.75, 0.22).multiplyScalar(state.fire);
    tailPos!.set(anchors.tailTip[0], anchors.tailTip[1] + 2.5, anchors.tailTip[2] + 2.5);
    tailColor!.set(1.4, 0.45, 0.1).multiplyScalar(state.tail);
    rosePos!.copy(letterTarget(0.9)).setZ(TEXT_Z - 20);
    roseColor!.set(0.9, 0.22, 0.06).multiplyScalar(state.rose * (1 - state.phraseExit) * 0.8);
    fillColor!.set(0.2, 0.15, 0.12).multiplyScalar(state.body * (1 - 0.7 * state.sleep));

    dragonUniforms.uBody.value = state.body;
    dragonUniforms.uEyes.value = state.eyes;
    dragonUniforms.uEyelid.value = state.eyelid;
    dragonUniforms.uFire.value = state.fire;
    dragonUniforms.uTail.value = state.tail;
    dragonUniforms.uSmoke.value = state.smoke;
    dragonUniforms.uBackGlow.value = 0.04 * state.body * (1 - state.sleep) + 0.35 * state.fire;
    dragonUniforms.uBreath.value = lerp(1.2, 0.55, state.sleep);
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

  function renderFrame(dt: number): void {
    time.value += dt;
    pointer.sx = damp(pointer.sx, pointer.x, 2.5, dt);
    pointer.sy = damp(pointer.sy, pointer.y, 2.5, dt);
    camera.position.x = pointer.sx * 4;
    camera.position.y = CAMERA_HEIGHT + pointer.sy * 2;
    camera.lookAt(LOOK_AT);
    state = sequenceAt(progress);
    updateText();
    simulate(dt);
    fade = Math.min(1, fade + dt * 1.6);
    pipeline.setFade(fade);
    pipeline.render(scene, camera);
    options.onFrame?.({ tail: project(new Vector3(...anchors.tailTip)), launchReady: state.launchReady });
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
    state = sequenceAt(1);
    head.pitch = SLEEP_PITCH;
    head.yaw = SLEEP_YAW;
    fade = 1;
    for (let i = 0; i < 150; i += 1) {
      time.value += 1 / 30;
      state = sequenceAt(1);
      updateText();
      simulate(1 / 30);
    }
    pipeline.setFade(1);
    pipeline.render(scene, camera);
    options.onFrame?.({ tail: project(new Vector3(...anchors.tailTip)), launchReady: true });
  }

  const onContextLost = (event: Event) => {
    event.preventDefault();
    running = false;
    cancelAnimationFrame(frameHandle);
    options.onContextLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const api: LandingScene = {
    setProgress(value) {
      progress = clamp01(value);
    },
    setPointer(x, y) {
      pointer.x = x;
      pointer.y = y;
    },
    hitTest(x, y) {
      const tailTip = new Vector3(...anchors.tailTip);
      const tail = project(tailTip);
      if (Math.hypot(x - tail.x, y - tail.y) < Math.max(28, projectedRadius(tailTip, 6))) return "tail";
      const headPoint = bend(anchors.head, anchors.neckPivot, head.pitch, head.yaw);
      const regions: [Vector3, number][] = [
        [headPoint, 11],
        [new Vector3(...anchors.chest), 16],
        [new Vector3(0, 8, -12), 14],
        [new Vector3(26, 30, -15), 15],
        [new Vector3(-26, 30, -15), 15],
        [new Vector3(18, 3, 6), 6],
        [new Vector3(4, 3, 17), 5],
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
      rebuildText();
      applyTier(tierIndex);
      frameCamera();
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

