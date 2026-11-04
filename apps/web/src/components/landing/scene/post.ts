import {
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from "three";
import { blurFragment, brightFragment, ditherFragment, fullscreenVertex } from "./shaders";

function target(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  });
}

/**
 * Post-processing chain: HDR scene target, a quarter-resolution bloom (bright pass + two
 * separable Gaussian iterations), and the final palette dither pass to the canvas.
 */
export class DitherPipeline {
  private readonly renderer: WebGLRenderer;
  private readonly sceneTarget: WebGLRenderTarget;
  private readonly bloomA: WebGLRenderTarget;
  private readonly bloomB: WebGLRenderTarget;
  private readonly quadScene = new Scene();
  private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly bright: ShaderMaterial;
  private readonly blur: ShaderMaterial;
  private readonly dither: ShaderMaterial;
  bloomEnabled = true;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.sceneTarget = target(1, 1);
    this.bloomA = target(1, 1);
    this.bloomB = target(1, 1);
    this.bloomA.depthBuffer = false;
    this.bloomB.depthBuffer = false;

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.bright = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: brightFragment,
      uniforms: { uScene: { value: this.sceneTarget.texture } },
      depthTest: false,
      depthWrite: false,
    });
    this.blur = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: blurFragment,
      uniforms: { uInput: { value: null }, uDirection: { value: new Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.dither = new ShaderMaterial({
      vertexShader: fullscreenVertex,
      fragmentShader: ditherFragment,
      uniforms: {
        uScene: { value: this.sceneTarget.texture },
        uBloom: { value: this.bloomA.texture },
        uBloomStrength: { value: 0.9 },
        uFade: { value: 1 },
        uTime: { value: 0 },
        uHeat: { value: new Vector4() },
        uAspect: { value: new Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(geometry, this.dither);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    this.sceneTarget.setSize(Math.max(1, width), Math.max(1, height));
    const bw = Math.max(1, Math.round(width / 4));
    const bh = Math.max(1, Math.round(height / 4));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    (this.dither.uniforms.uAspect!.value as Vector2).set(width / Math.max(1, height), 1);
  }

  setFade(value: number): void {
    this.dither.uniforms.uFade!.value = value;
  }

  /** Heat shimmer: center in uv space, radius as a fraction of the height, strength 0..1. */
  setHeat(x: number, y: number, radius: number, strength: number, time: number): void {
    (this.dither.uniforms.uHeat!.value as Vector4).set(x, y, radius, strength);
    this.dither.uniforms.uTime!.value = time;
  }

  render(scene: Scene, camera: Camera): void {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear();
    renderer.render(scene, camera);

    if (this.bloomEnabled) {
      this.pass(this.bright, this.bloomA);
      const texel = new Vector2(1 / this.bloomA.width, 1 / this.bloomA.height);
      for (let i = 0; i < 2; i += 1) {
        this.blur.uniforms.uInput!.value = this.bloomA.texture;
        (this.blur.uniforms.uDirection!.value as Vector2).set(texel.x * (1 + i), 0);
        this.pass(this.blur, this.bloomB);
        this.blur.uniforms.uInput!.value = this.bloomB.texture;
        (this.blur.uniforms.uDirection!.value as Vector2).set(0, texel.y * (1 + i));
        this.pass(this.blur, this.bloomA);
      }
    }
    this.dither.uniforms.uBloomStrength!.value = this.bloomEnabled ? 0.65 : 0;
    this.pass(this.dither, null);
  }

  private pass(material: ShaderMaterial, output: WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(output);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.quad.geometry.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.dither.dispose();
  }
}
