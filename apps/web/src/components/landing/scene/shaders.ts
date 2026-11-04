import { EMBER_PALETTE, hexToRgb } from "@/lib/dither";
import { BONE_COUNT } from "@/lib/voxel/dragon";

/**
 * Shared lighting: four point lights with soft quadratic falloff (fire, tail ember, rose glow,
 * fill), a dim directional key from the upper right and a cold rim from behind.
 */
const LIGHTING = /* glsl */ `
uniform vec3 uLightPos[4];
uniform vec3 uLightColor[4];
uniform float uLightRange[4];
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;

vec3 pointLights(vec3 worldPos, vec3 normal, float fillWeight) {
  vec3 total = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 toLight = uLightPos[i] - worldPos;
    float dist = length(toLight);
    float lambert = max(dot(normal, toLight / max(dist, 1e-3)), 0.0);
    float falloff = 1.0 / (1.0 + (dist * dist) / (uLightRange[i] * uLightRange[i]));
    total += uLightColor[i] * (0.12 + 0.88 * lambert) * falloff * (i == 3 ? fillWeight : 1.0);
  }
  return total;
}

vec3 shade(vec3 worldPos, vec3 normal) {
  vec3 total = pointLights(worldPos, normal, 1.0);
  total += uKeyColor * (0.08 + 0.92 * max(dot(normal, uKeyDir), 0.0));
  total += uRimColor * pow(max(dot(normal, uRimDir), 0.0), 1.5);
  return total;
}
`;

export const dragonVertex = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aColor;
attribute vec4 aData;
uniform mat4 uBones[${BONE_COUNT + 1}];
uniform float uTime;
uniform float uBreath;
uniform float uBody;
uniform vec3 uChest;
uniform vec3 uEyeCenter;
varying vec3 vColor;
varying vec4 vData;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vReveal;
varying vec2 vNdc;

void main() {
  vec3 local = position + aOffset;
  int bone = int(floor(aData.y));
  float blend = fract(aData.y);
  mat4 skin = uBones[bone] * (1.0 - blend) + uBones[bone + 1] * blend;
  float chest = exp(-dot(aOffset - uChest, aOffset - uChest) / 900.0);
  local += (local - uChest) * (sin(uTime * uBreath) * 0.014 * chest) * step(aData.y, 0.5);
  vec4 posed = skin * vec4(local, 1.0);
  vec4 world = modelMatrix * posed;
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * mat3(skin) * normal);
  vColor = aColor;
  vData = aData;
  float distanceFromEyes = length(aOffset - uEyeCenter) / 150.0;
  vReveal = smoothstep(distanceFromEyes - 0.05, distanceFromEyes + 0.05, uBody * 1.2 - aData.z * 0.08);
  gl_Position = projectionMatrix * viewMatrix * world;
  vNdc = gl_Position.xy / gl_Position.w;
}
`;

export const dragonFragment = /* glsl */ `
uniform float uTime;
uniform float uEyes;
uniform float uEyelid;
uniform float uFire;
uniform float uTail;
uniform float uSmoke;
uniform float uBackGlow;
uniform vec4 uVeilBox;
uniform vec2 uVeilSoft;
uniform float uVeil;
varying vec3 vColor;
varying vec4 vData;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vReveal;
varying vec2 vNdc;
${LIGHTING}

// 1 inside the phrase screen box (NDC), fading to 0 over uVeilSoft around it.
float veilMask() {
  vec2 outside = max(abs(vNdc - uVeilBox.xy) - uVeilBox.zw, 0.0) / uVeilSoft;
  return 1.0 - smoothstep(0.0, 1.0, length(outside));
}

void main() {
  float kind = vData.x;
  float seed = vData.z;
  float local = vData.w;
  vec3 n = normalize(vNormal);
  vec3 lit = vColor * shade(vWorld, n) * vReveal;
  vec3 emissive = vec3(0.0);
  float flicker = 0.75 + 0.25 * sin(uTime * (2.0 + seed * 3.0) + seed * 40.0);

  if (kind < 0.5) {
  } else if (kind < 1.5) {
    float open = mix(0.05, 1.0, uEyelid);
    emissive = vec3(1.0, 0.62, 0.18) * (1.2 * uEyes * open) * (0.92 + 0.08 * flicker);
    lit *= mix(0.6, 1.0, uEyelid);
  } else if (kind < 2.5) {
    emissive = vec3(1.0, 0.3, 0.06) * (uFire * 0.35 * (1.0 - local) + uSmoke * 0.06 * flicker) * vReveal;
  } else if (kind < 3.5) {
    emissive = vColor * uTail * (0.25 + 1.3 * local) * (0.82 + 0.18 * sin(uTime * 1.7 + local * 3.0)) * max(vReveal, 0.5);
  } else if (kind < 4.5) {
    emissive = vColor * (0.08 + uFire * 1.2 + uTail * 0.15) * flicker * vReveal;
  } else if (kind < 5.5) {
    emissive = vColor * uBackGlow * vReveal;
  } else {
    emissive = vec3(0.9, 0.3, 0.08) * (uFire * 0.6 + uSmoke * 0.12 * flicker) * vReveal;
  }
  float shadowed = 1.0 - uVeil * veilMask();
  if (kind < 0.5 || kind > 4.5) emissive *= shadowed;
  gl_FragColor = vec4(lit * shadowed + emissive, 0.45);
}
`;

export const textVertex = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aLetter;
varying vec3 vLetter;
varying vec3 vNormal;
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position + aOffset, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vLetter = aLetter;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The phrase: deep shadow until the flame front passes a letter, then lit bone white with a hot
 * flash while the fire is on it; "rose" smolders from the start and grows to a blaze. Alpha is the
 * dither amount read by the final pass: 0 keeps the letters crisp (the dragon writes 0.45 so its
 * flat faces snap to the palette and only its gradients pattern; everything else dithers fully).
 */
export const textFragment = /* glsl */ `
uniform float uTime;
uniform float uFront;
uniform float uFire;
uniform float uRose;
varying vec3 vLetter;
varying vec3 vNormal;
varying vec3 vWorld;
${LIGHTING}

void main() {
  float order = vLetter.x;
  float isRose = vLetter.y;
  float seed = vLetter.z;
  vec3 n = normalize(vNormal);
  float face = n.z > 0.5 ? 1.0 : (n.y > 0.5 ? 0.72 : 0.5);
  float reached = smoothstep(-0.015, 0.012, uFront - order);
  float heat = reached * exp(-max(uFront - order, 0.0) * 9.0) * uFire;

  vec3 shadow = vec3(0.028, 0.02, 0.018) * face;
  vec3 litColor = vec3(1.1, 0.95, 0.78) * face;
  vec3 color = mix(shadow, litColor, reached) + pointLights(vWorld, n, 0.12) * 0.3 * face;
  color += vec3(2.4, 1.0, 0.3) * heat;

  if (isRose > 0.5) {
    float ember = 0.65 + 0.35 * sin(uTime * (2.3 + seed * 2.0) + seed * 31.0) * sin(uTime * 0.7 + seed * 9.0);
    float hot = pow(0.5 + 0.5 * sin(uTime * (1.2 + seed * 2.6) + seed * 47.0), 10.0);
    vec3 smolder = (vec3(0.42, 0.05, 0.03) * ember + vec3(1.6, 0.5, 0.1) * hot) * face;
    vec3 blaze = vec3(3.2, 1.1, 0.3) * (0.88 + 0.12 * ember) * face;
    color = mix(smolder * (0.5 + uRose), blaze, smoothstep(0.4, 1.0, uRose));
    color += vec3(2.4, 1.0, 0.3) * heat;
  }
  gl_FragColor = vec4(color, 0.0);
}
`;

export const particleVertex = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aInfo;
uniform vec3 uFrontPoint;
uniform vec3 uFrontDir;
varying vec4 vInfo;
varying vec3 vNormal;
varying float vFade;

void main() {
  float size = aInfo.y;
  if (aInfo.z > 1.5) size *= 1.0 - smoothstep(0.55, 1.0, aInfo.x);
  float past = dot(aPos - uFrontPoint, uFrontDir);
  vFade = aInfo.z < 0.5 ? 1.0 - smoothstep(1.0, 9.0, past) : 1.0;
  size *= aInfo.z < 0.5 ? mix(0.6, 1.0, vFade) : 1.0;
  vec4 world = vec4(position * size + aPos, 1.0);
  vInfo = aInfo;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** Fire and sparks: additive voxels with a temperature ramp by normalized age. */
export const fireFragment = /* glsl */ `
varying vec4 vInfo;
varying vec3 vNormal;
varying float vFade;

vec3 ramp(float t) {
  vec3 white = vec3(0.5, 0.34, 0.14);
  vec3 orange = vec3(0.42, 0.14, 0.035);
  vec3 red = vec3(0.26, 0.04, 0.012);
  vec3 dark = vec3(0.05, 0.012, 0.008);
  if (t < 0.15) return mix(white, orange, t / 0.15);
  if (t < 0.55) return mix(orange, red, (t - 0.15) / 0.4);
  return mix(red, dark, (t - 0.55) / 0.45);
}

void main() {
  float age = vInfo.x;
  float kind = vInfo.z;
  float face = vNormal.z > 0.5 ? 1.0 : (vNormal.y > 0.5 ? 0.8 : 0.55);
  vec3 color = kind > 0.5 ? vec3(2.2, 0.8, 0.2) * (1.0 - age) : ramp(age);
  float alpha = kind > 0.5 ? (1.0 - age) : smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.6, 1.0, age)) * vFade;
  gl_FragColor = vec4(color * alpha * face, 1.0);
}
`;

/** Smoke: opaque wisps that lighten as they rise, then shrink and fade out, so no sorting is needed. */
export const smokeFragment = /* glsl */ `
varying vec4 vInfo;
varying vec3 vNormal;
uniform vec3 uSmokeColor;

void main() {
  float age = vInfo.x;
  float face = vNormal.y > 0.5 ? 1.0 : (vNormal.z > 0.5 ? 0.8 : 0.55);
  float fade = smoothstep(0.0, 0.2, age) * pow(1.0 - age, 1.6);
  gl_FragColor = vec4(uSmokeColor * face * (0.35 + 0.65 * fade), 1.0);
}
`;

export const backdropVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** Backdrop: a very dim ember haze behind the dragon, so the final dither pattern has gradients to draw. */
export const backdropFragment = /* glsl */ `
uniform vec4 uGlow[3];
uniform vec3 uGlowColor[3];
uniform float uHaze;
varying vec3 vWorld;

void main() {
  vec3 color = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec2 d = (vWorld.xy - uGlow[i].xy) / max(uGlow[i].z, 1.0);
    color += uGlowColor[i] * uGlow[i].w * exp(-dot(d, d));
  }
  color += vec3(0.16, 0.07, 0.05) * uHaze * exp(-max(vWorld.y, 0.0) / 28.0);
  gl_FragColor = vec4(color, 1.0);
}
`;

export const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const brightFragment = /* glsl */ `
uniform sampler2D uScene;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(0.7, 2.0, l), 1.0);
}
`;

export const blurFragment = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uDirection;
varying vec2 vUv;
void main() {
  vec3 sum = texture2D(uInput, vUv).rgb * 0.227027;
  sum += texture2D(uInput, vUv + uDirection * 1.3846).rgb * 0.316216;
  sum += texture2D(uInput, vUv - uDirection * 1.3846).rgb * 0.316216;
  sum += texture2D(uInput, vUv + uDirection * 3.2308).rgb * 0.070270;
  sum += texture2D(uInput, vUv - uDirection * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}
`;

const palette = EMBER_PALETTE.map(hexToRgb);

const paletteGlsl = palette
  .map(([r, g, b]) => `vec3(${(r / 255).toFixed(4)}, ${(g / 255).toFixed(4)}, ${(b / 255).toFixed(4)})`)
  .join(",\n  ");

/**
 * Final pass: heat shimmer around the flame, scene + bloom, filmic tone map, gamma, then ordered
 * dithering (Bayer 8x8) between the two nearest colors of the ember palette. Pixels flagged crisp
 * (scene alpha 0: the phrase) take the nearest palette color without a pattern.
 */
export const ditherFragment = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uFade;
uniform float uTime;
uniform vec4 uHeat;
uniform vec2 uAspect;
varying vec2 vUv;

const int PALETTE_SIZE = ${palette.length};
const vec3 PALETTE[PALETTE_SIZE] = vec3[](
  ${paletteGlsl}
);

float bayer8(ivec2 p) {
  int x = p.x & 7;
  int y = p.y & 7;
  int a = x ^ y;
  int v = ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

vec3 tonemap(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float distance2(vec3 a, vec3 b) {
  vec3 d = a - b;
  return dot(d * d, vec3(0.3, 0.59, 0.11));
}

void main() {
  vec2 toHeat = (vUv - uHeat.xy) * uAspect / max(uHeat.z, 1e-3);
  float heat = uHeat.w * exp(-dot(toHeat, toHeat));
  vec2 shimmer = vec2(sin(vUv.y * 90.0 + uTime * 11.0) + sin(vUv.y * 37.0 - uTime * 7.0), cos(vUv.x * 70.0 + uTime * 9.0)) * 0.0035 * heat;
  vec2 uv = vUv + shimmer;
  vec4 src = texture2D(uScene, uv);
  vec3 hdr = src.rgb + texture2D(uBloom, uv).rgb * uBloomStrength;
  vec2 v = vUv - 0.5;
  hdr *= 1.0 - dot(v, v) * 0.8;
  vec3 color = pow(tonemap(hdr * 1.1), vec3(1.0 / 2.2)) * uFade;
  float crisp = 1.0 - clamp(src.a, 0.0, 1.0);

  int first = 0;
  float best = 1e9;
  for (int i = 0; i < PALETTE_SIZE; i++) {
    float d = distance2(color, PALETTE[i]);
    if (d < best) { best = d; first = i; }
  }
  vec3 c1 = PALETTE[first];
  vec3 c2 = c1;
  float t = 0.0;
  float bestSegment = 1e9;
  for (int i = 0; i < PALETTE_SIZE; i++) {
    if (i == first) continue;
    vec3 edge = PALETTE[i] - c1;
    float along = clamp(dot(color - c1, edge) / max(dot(edge, edge), 1e-6), 0.0, 1.0);
    float d = distance2(color, c1 + edge * along);
    if (along > 0.0 && d < bestSegment) { bestSegment = d; c2 = PALETTE[i]; t = along; }
  }
  float threshold = mix(bayer8(ivec2(gl_FragCoord.xy)), 0.5, crisp);
  vec3 dithered = t > threshold ? c2 : c1;
  gl_FragColor = vec4(dithered, 1.0);
}
`;
