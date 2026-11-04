import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { GLYPH_HEIGHT, GLYPH_PIXELS, GLYPH_WIDTH } from "@/components/brand/glyph";
import { ditheredGlow } from "@/lib/og/glow";
import { encodePng } from "@/lib/og/png";
import { SITE_TAGLINE } from "@/lib/site";

export const alt = "rose: What was locked, rose. Sealed liquidity rounds for locked token allocations.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const departureMono = await readFile(join(process.cwd(), "src/fonts/departure-mono/DepartureMono-Regular.otf"));
const background = `data:image/png;base64,${encodePng(size.width, size.height, ditheredGlow(size.width, size.height, 6)).toString("base64")}`;
const glyph = `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}" shape-rendering="crispEdges">${GLYPH_PIXELS.map(
    ({ x, y, color }) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`,
  ).join("")}</svg>`,
).toString("base64")}`;

export default function OpenGraphImage() {
  const lead = SITE_TAGLINE.slice(0, SITE_TAGLINE.indexOf("rose")).trim();
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#050404", fontFamily: "Departure Mono" }}>
        <img alt="" src={background} width={size.width} height={size.height} style={{ position: "absolute", inset: 0 }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 80px", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <img alt="" src={glyph} width={GLYPH_WIDTH * 5} height={GLYPH_HEIGHT * 5} />
            <span style={{ fontSize: 44, color: "#f7f2ec" }}>rose</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <div style={{ display: "flex", gap: 40, fontSize: 72, color: "#e9e1d9" }}>
              <span>{lead}</span>
              <span style={{ color: "#ff9a3d" }}>rose.</span>
            </div>
            <span style={{ fontSize: 26, color: "#c9beb4" }}>Sealed, uniform-price liquidity rounds for locked tokens.</span>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "Departure Mono", data: departureMono, style: "normal", weight: 400 }] },
  );
}
