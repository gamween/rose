/**
 * Isometric voxel illustrations drawn as SVG. Each voxel shows three faces: a lit top, a mid
 * right face and a left face shaded with an ordered 2x2 dither, which keeps the dithered voxel
 * language of the landing in static UI. Pattern ids are derived from the preset, so repeated
 * instances share identical definitions.
 */

type Shade = { top: string; right: string; left: string; dark: string };

const SHADES: Record<string, Shade> = {
  k: { top: "#3a332e", right: "#2a2521", left: "#201c19", dark: "#12100e" },
  g: { top: "#554b44", right: "#3a332e", left: "#2a2521", dark: "#191614" },
  r: { top: "#d8333c", right: "#9b1f2e", left: "#7a1826", dark: "#5c1420" },
  e: { top: "#ff9a3d", right: "#f2622e", left: "#c9481c", dark: "#8a3012" },
  y: { top: "#ffe1a8", right: "#ffcf7a", left: "#ff9a3d", dark: "#f2622e" },
};

/** Layers from bottom to top; each layer is rows (y, back to front) of columns (x, left to right). */
export const VOXEL_PRESETS = {
  vault: [
    ["kkkk", "kkkk", "kkkk"],
    ["kgkk", "kkkk", "kkkk"],
    ["gggg", "gkkg", "gyeg"],
    ["....", ".rr.", "...."],
  ],
  ember: [
    ["gkk", "kkg", "gkk"],
    [".k.", "kek", ".k."],
    ["...", ".y.", "..."],
  ],
  ledger: [
    ["kkk", "kkk"],
    ["ggg", "ggg"],
    ["kkk", "kkk"],
    ["rrr", "rre"],
  ],
  tender: [
    ["k.k.k", ".....", "..r.."],
    ["k.k.k", ".....", "..r.."],
    ["g.g.g", ".....", "..e.."],
  ],
  exit: [
    ["kk.rr", "kk.rr"],
    ["k..r.", "g..e."],
  ],
  advance: [
    ["kkk", "kkk", "kkk"],
    ["kk.", "kk.", "kk."],
    ["k..", "e..", "k.."],
  ],
} as const satisfies Record<string, readonly (readonly string[])[]>;

export type VoxelPreset = keyof typeof VOXEL_PRESETS;

const W = 8;
const H = 4;
const Z = 8;

type Voxel = { x: number; y: number; z: number; shade: Shade };

function parse(layers: readonly (readonly string[])[]): Voxel[] {
  const voxels: Voxel[] = [];
  layers.forEach((rows, z) => {
    rows.forEach((row, y) => {
      [...row].forEach((key, x) => {
        const shade = SHADES[key];
        if (shade) voxels.push({ x, y, z, shade });
      });
    });
  });
  return voxels.sort((a, b) => a.x + a.y - (b.x + b.y) || a.z - b.z);
}

export function VoxelArt({ preset, size = 96, className }: { preset: VoxelPreset; size?: number; className?: string }) {
  const id = `voxel-${preset}`;
  const voxels = parse(VOXEL_PRESETS[preset]);
  const points = voxels.map(({ x, y, z }) => ({ sx: (x - y) * W, sy: (x + y) * H - z * Z }));
  const minX = Math.min(...points.map((p) => p.sx)) - W;
  const maxX = Math.max(...points.map((p) => p.sx)) + W;
  const minY = Math.min(...points.map((p) => p.sy)) - Z;
  const maxY = Math.max(...points.map((p) => p.sy)) + 2 * H + 1;
  const width = maxX - minX;
  const height = maxY - minY;
  const shadeKeys = [...new Set(voxels.map((voxel) => Object.keys(SHADES).find((key) => SHADES[key] === voxel.shade)!))];

  return (
    <svg
      viewBox={`${minX} ${minY} ${width} ${height}`}
      width={size}
      height={(size * height) / width}
      shapeRendering="crispEdges"
      aria-hidden
      className={className}
    >
      <defs>
        {shadeKeys.map((key) => {
          const shade = SHADES[key]!;
          return (
            <pattern key={key} id={`${id}-${key}`} width="2" height="2" patternUnits="userSpaceOnUse">
              <rect width="2" height="2" fill={shade.left} />
              <rect width="1" height="1" fill={shade.dark} />
              <rect x="1" y="1" width="1" height="1" fill={shade.dark} />
            </pattern>
          );
        })}
      </defs>
      {voxels.map((voxel, index) => {
        const { sx, sy } = points[index]!;
        const key = Object.keys(SHADES).find((k) => SHADES[k] === voxel.shade)!;
        const top = `${sx},${sy} ${sx + W},${sy + H} ${sx},${sy + 2 * H} ${sx - W},${sy + H}`;
        const left = `${sx - W},${sy + H} ${sx},${sy + 2 * H} ${sx},${sy + 2 * H + Z} ${sx - W},${sy + H + Z}`;
        const right = `${sx},${sy + 2 * H} ${sx + W},${sy + H} ${sx + W},${sy + H + Z} ${sx},${sy + 2 * H + Z}`;
        return (
          <g key={`${voxel.x}-${voxel.y}-${voxel.z}`}>
            <polygon points={left} fill={`url(#${id}-${key})`} />
            <polygon points={right} fill={voxel.shade.right} />
            <polygon points={top} fill={voxel.shade.top} />
          </g>
        );
      })}
    </svg>
  );
}
