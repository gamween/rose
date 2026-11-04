/**
 * The guided demo of the configured engine: the manifest committed for
 * `NEXT_PUBLIC_ENGINE_ACCOUNT` under `src/content/demo/`, or null when that engine has none (the
 * entry points are then simply absent). Server-side helper: pages pass the result down.
 */

import { DEMO_MANIFESTS } from "@/content/demo";
import { deployed } from "@/lib/deployment";
import { parseDemoManifest, type DemoManifest } from "./manifest";

export function demoManifest(engine: string | null = deployed("engineAccount")): DemoManifest | null {
  if (!engine) return null;
  const raw = DEMO_MANIFESTS[engine];
  if (raw === undefined) return null;
  const manifest = parseDemoManifest(raw);
  if (manifest.engine !== engine) throw new Error(`The demo manifest registered for ${engine} describes ${manifest.engine}.`);
  return manifest;
}

export function demoAvailable(engine: string | null = deployed("engineAccount")): boolean {
  return demoManifest(engine) !== null;
}
