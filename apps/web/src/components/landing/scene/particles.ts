import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  type IUniform,
} from "three";

/** Instanced geometry sharing the index, positions and normals of a box. */
export function instancedBox(width: number, height: number, depth: number): InstancedBufferGeometry {
  const box = new BoxGeometry(width, height, depth);
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex(box.getIndex());
  geometry.setAttribute("position", box.getAttribute("position") as BufferAttribute);
  geometry.setAttribute("normal", box.getAttribute("normal") as BufferAttribute);
  box.dispose();
  return geometry;
}

export type SpawnOptions = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  growth: number;
  kind: number;
  /** Starting age in seconds, to fill a jet instantly. */
  age?: number;
};

/** Critically damped springs pulling particles toward a plane of constant z and a line of constant y. */
export type PlaneGuide = { z: number; y: number; stiffness: number };

/**
 * CPU particle pool rendered as instanced voxels. Dead particles are swap-removed, so the live
 * range is always `[0, count)` and the draw call only covers live particles.
 */
export class ParticlePool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly capacity: number;
  private limit: number;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly info: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly growth: Float32Array;
  private readonly kind: Float32Array;
  private readonly posAttribute: InstancedBufferAttribute;
  private readonly infoAttribute: InstancedBufferAttribute;

  constructor(
    capacity: number,
    vertexShader: string,
    fragmentShader: string,
    options: { additive: boolean; uniforms?: Record<string, IUniform> },
  ) {
    this.capacity = capacity;
    this.limit = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.info = new Float32Array(capacity * 4);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.kind = new Float32Array(capacity);

    const geometry = instancedBox(1, 1, 1);
    this.posAttribute = new InstancedBufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage);
    this.infoAttribute = new InstancedBufferAttribute(this.info, 4).setUsage(DynamicDrawUsage);
    geometry.setAttribute("aPos", this.posAttribute);
    geometry.setAttribute("aInfo", this.infoAttribute);
    geometry.instanceCount = 0;

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: options.uniforms ?? {},
      transparent: options.additive,
      blending: options.additive ? AdditiveBlending : NormalBlending,
      depthWrite: !options.additive,
    });
    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  get live(): number {
    return this.count;
  }

  setLimit(limit: number): void {
    this.limit = Math.max(0, Math.min(this.capacity, Math.floor(limit)));
  }

  spawn(options: SpawnOptions): void {
    if (this.count >= this.limit) return;
    const i = this.count;
    this.count += 1;
    this.pos[i * 3] = options.x;
    this.pos[i * 3 + 1] = options.y;
    this.pos[i * 3 + 2] = options.z;
    this.vel[i * 3] = options.vx;
    this.vel[i * 3 + 1] = options.vy;
    this.vel[i * 3 + 2] = options.vz;
    this.age[i] = options.age ?? 0;
    this.life[i] = options.life;
    this.size[i] = options.size;
    this.growth[i] = options.growth;
    this.kind[i] = options.kind;
  }

  /** Integrates with drag, buoyancy, a cheap swirl and an optional pull toward a plane. */
  update(dt: number, time: number, drag: number, buoyancy: number, swirl: number, guide?: PlaneGuide): void {
    const damping = Math.exp(-drag * dt);
    const pullDamping = guide ? 2 * Math.sqrt(guide.stiffness) : 0;
    let i = 0;
    while (i < this.count) {
      const age = (this.age[i] ?? 0) + dt;
      if (age >= (this.life[i] ?? 0)) {
        this.swapRemove(i);
        continue;
      }
      this.age[i] = age;
      const p = i * 3;
      const px = this.pos[p]!;
      const py = this.pos[p + 1]!;
      const pz = this.pos[p + 2]!;
      let vx = this.vel[p]! * damping;
      let vy = this.vel[p + 1]! * damping + buoyancy * dt;
      let vz = this.vel[p + 2]! * damping;
      vx += Math.sin(py * 0.21 + time * 1.3 + i) * swirl * dt;
      vz += Math.cos(px * 0.17 + time * 1.1) * swirl * dt;
      vy += Math.sin(pz * 0.19 + time * 0.9) * swirl * 0.5 * dt;
      if (guide) {
        vz += ((guide.z - pz) * guide.stiffness - vz * pullDamping) * dt;
        vy += ((guide.y - py) * guide.stiffness * 0.1 - vy * pullDamping * 0.1) * dt;
      }
      this.vel[p] = vx;
      this.vel[p + 1] = vy;
      this.vel[p + 2] = vz;
      this.pos[p] = px + vx * dt;
      this.pos[p + 1] = py + vy * dt;
      this.pos[p + 2] = pz + vz * dt;
      const t = age / (this.life[i] ?? 1);
      this.info[i * 4] = t;
      this.info[i * 4 + 1] = (this.size[i] ?? 1) * (1 + (this.growth[i] ?? 0) * t);
      this.info[i * 4 + 2] = this.kind[i] ?? 0;
      i += 1;
    }
    this.mesh.geometry.instanceCount = this.count;
    this.posAttribute.clearUpdateRanges();
    this.infoAttribute.clearUpdateRanges();
    this.posAttribute.addUpdateRange(0, this.count * 3);
    this.infoAttribute.addUpdateRange(0, this.count * 4);
    this.posAttribute.needsUpdate = true;
    this.infoAttribute.needsUpdate = true;
  }

  private swapRemove(i: number): void {
    const last = this.count - 1;
    if (i !== last) {
      this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.info.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.age[i] = this.age[last]!;
      this.life[i] = this.life[last]!;
      this.size[i] = this.size[last]!;
      this.growth[i] = this.growth[last]!;
      this.kind[i] = this.kind[last]!;
    }
    this.count = last;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
