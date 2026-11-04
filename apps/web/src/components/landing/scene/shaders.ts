import { EMBER_PALETTE, hexToRgb } from "@/lib/dither";

/** Shared lighting: up to four point lights with soft quadratic falloff, plus a dim warm rim. */
const LIGHTING = /* glsl */ `
uniform vec3 uLightPos[4];
uniform vec3 uLightColor[4];
uniform float uLightRange[4];

vec3 shade(vec3 worldPos, vec3 normal) {
  vec3 total = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 toLight = uLightPos[i] - worldPos;
    float dist = length(toLight);
    float lambert = max(dot(normal, toLight / max(dist, 1e-3)), 0.0);
    float falloff = 1.0 / (1.0 + (dist * dist) / (uLightRange[i] * uLightRange[i]));
    total += uLightColor[i] * (0.15 + 0.85 * lambert) * falloff;
  }
  float rim = pow(1.0 - max(normal.z, 0.0), 2.0) * max(normal.y + 0.35, 0.0);
  return total + vec3(0.08, 0.055, 0.045) * rim;
}
`;

/** Neck bend shared by the dragon vertex shader and the CPU (mouth position). */
const BEND = /* glsl */ `
uniform vec3 uPivot;
uniform float uPitch;
uniform float uYaw;

mat3 bendMatrix(float w) {
  float p = uPitch * w;
  float y = uYaw * w;
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cos(p), sin(p), 0.0, -sin(p), cos(p));
  mat3 ry = mat3(cos(y), 0.0, -sin(y), 0.0, 1.0, 0.0, sin(y), 0.0, cos(y));
  return ry * rx;
}
`;

export const dragonVertex = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aColor;
attribute vec4 aData;
uniform float uTime;
uniform float uBreath;
varying vec3 vColor;
varying vec4 vData;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vReveal;
uniform float uBody;
uniform vec3 uEyeCenter;
${BEND}

void main() {
  vec3 local = position + aOffset;
  vec3 normalLocal = normal;
  float w = aData.y;
  if (w > 0.0) {
    mat3 bend = bendMatrix(w);
    local = bend * (local - uPivot) + uPivot;
    normalLocal = bend * normalLocal;
  }
  local.y += sin(uTime * uBreath) * 0.18 * clamp(local.y / 40.0, 0.0, 1.0);
  vec4 world = modelMatrix * vec4(local, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normalLocal);
  vColor = aColor;
  vData = aData;
  float distanceFromEyes = length(aOffset - uEyeCenter) / 70.0;
  vReveal = smoothstep(distanceFromEyes - 0.06, distanceFromEyes + 0.06, uBody * 1.25 - aData.z * 0.12);
  gl_Position = projectionMatrix * viewMatrix * world;
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
varying vec3 vColor;
varying vec4 vData;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vReveal;
${LIGHTING}

void main() {
  float kind = vData.x;
  float seed = vData.z;
  float local = vData.w;
  vec3 lit = vColor * shade(vWorld, normalize(vNormal)) * vReveal;
  vec3 emissive = vec3(0.0);
  float flicker = 0.75 + 0.25 * sin(uTime * (2.0 + seed * 3.0) + seed * 40.0);

  if (kind < 0.5) {
  } else if (kind < 1.5) {
    float open = step(local, uEyelid * 2.0 - 0.6);
    emissive = vColor * 1.7 * uEyes * open * (0.9 + 0.1 * flicker);
    lit *= open;
  } else if (kind < 2.5) {
    emissive = vec3(1.0, 0.42, 0.12) * (uFire * (1.6 + local) + uSmoke * 0.08 * flicker);
  } else if (kind < 3.5) {
    emissive = vColor * uTail * (0.2 + 1.0 * local) * (0.8 + 0.2 * sin(uTime * 1.7)) * max(vReveal, 0.6);
  } else if (kind < 4.5) {
    emissive = vColor * (0.05 + uFire * 0.9) * flicker * vReveal;
  } else {
    emissive = vColor * uBackGlow * vReveal;
  }
  gl_FragColor = vec4(lit + emissive, 1.0);
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
  float face = n.z > 0.5 ? 1.0 : (n.y > 0.5 ? 0.7 : 0.45);
  float reached = clamp((uFront - order) * 30.0 + 0.5, 0.0, 1.0);
  float heat = reached * exp(-max(uFront - order, 0.0) * 7.0) * uFire;

  vec3 shadow = vec3(0.022, 0.017, 0.015) * face;
  vec3 litColor = vec3(0.62, 0.5, 0.4) * face;
  vec3 color = mix(shadow, litColor, reached) + shade(vWorld, n) * 0.25;
  color += vec3(2.6, 1.1, 0.35) * heat;

  if (isRose > 0.5) {
    float ember = 0.65 + 0.35 * sin(uTime * (2.3 + seed * 2.0) + seed * 31.0) * sin(uTime * 0.7 + seed * 9.0);
    float hot = pow(0.5 + 0.5 * sin(uTime * (1.2 + seed * 2.6) + seed * 47.0), 8.0);
    vec3 smolder = (vec3(0.3, 0.035, 0.025) * ember + vec3(1.5, 0.5, 0.1) * hot) * face;
    vec3 blaze = vec3(2.8, 0.85, 0.22) * (0.85 + 0.15 * ember) * face;
    color = mix(smolder * (0.6 + uRose), blaze, smoothstep(0.35, 1.0, uRose));
    color += vec3(2.6, 1.1, 0.35) * heat;
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

export const particleVertex = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aInfo;
uniform float uFadeZ;
varying vec4 vInfo;
varying vec3 vNormal;
varying float vDepthFade;

void main() {
  float size = aInfo.y;
  if (aInfo.z > 1.5) size *= 1.0 - smoothstep(0.5, 1.0, aInfo.x);
  vec4 world = vec4(position * size + aPos, 1.0);
  vInfo = aInfo;
  vNormal = normal;
  vDepthFade = 1.0 - smoothstep(uFadeZ - 10.0, uFadeZ + 4.0, aPos.z);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/** Fire, sparks: additive, temperature ramp by normalized age. */
export const fireFragment = /* glsl */ `
varying vec4 vInfo;
varying vec3 vNormal;
varying float vDepthFade;

vec3 ramp(float t) {
  vec3 white = vec3(0.75, 0.52, 0.22);
  vec3 orange = vec3(0.6, 0.2, 0.04);
  vec3 red = vec3(0.3, 0.04, 0.015);
  vec3 dark = vec3(0.04, 0.012, 0.008);
  if (t < 0.12) return mix(white, orange, t / 0.12);
  if (t < 0.5) return mix(orange, red, (t - 0.12) / 0.38);
  return mix(red, dark, (t - 0.5) / 0.5);
}

void main() {
  float age = vInfo.x;
  float kind = vInfo.z;
  float face = vNormal.z > 0.5 ? 1.0 : 0.6;
  vec3 color = kind > 0.5 ? vec3(2.2, 0.8, 0.2) * (1.0 - age) : ramp(age);
  float alpha = kind > 0.5 ? (1.0 - age) : (1.0 - smoothstep(0.55, 1.0, age)) * vDepthFade;
  gl_FragColor = vec4(color * alpha * face, 1.0);
}
`;

/** Smoke: opaque voxels that darken and crumble (shrink) as they age, so no sorting is needed. */
export const smokeFragment = /* glsl */ `
varying vec4 vInfo;
varying vec3 vNormal;
uniform vec3 uSmokeColor;

void main() {
  float age = vInfo.x;
  float face = vNormal.y > 0.5 ? 1.0 : (vNormal.z > 0.5 ? 0.75 : 0.5);
  float fade = smoothstep(0.0, 0.12, age) * pow(1.0 - age, 1.4);
  gl_FragColor = vec4(uSmokeColor * face * fade, 1.0);
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
  gl_FragColor = vec4(c * smoothstep(0.8, 2.0, l), 1.0);
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
 * Final pass: scene + bloom, filmic tone map, gamma, then ordered dithering (Bayer 8x8) between
 * the two nearest colors of the ember palette.
 */
export const ditherFragment = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uFade;
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
  vec3 hdr = texture2D(uScene, vUv).rgb + texture2D(uBloom, vUv).rgb * uBloomStrength;
  vec2 v = vUv - 0.5;
  hdr *= 1.0 - dot(v, v) * 0.9;
  vec3 color = pow(tonemap(hdr * 1.1), vec3(1.0 / 2.2)) * uFade;

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
  vec3 dithered = t > bayer8(ivec2(gl_FragCoord.xy)) ? c2 : c1;
  gl_FragColor = vec4(dithered, 1.0);
}
`;
