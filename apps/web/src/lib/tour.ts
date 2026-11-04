/**
 * Whether the guided tour shows. It opens by itself on a first visit and from the palette; the
 * automatic opening never covers the guided demo (`/app/demo`), which is meant to be recorded,
 * even when it fired on another page just before a client-side navigation to the demo.
 */

export type TourState = "closed" | "auto" | "requested";

export function tourVisible(state: TourState, onDemo: boolean): boolean {
  return state === "requested" || (state === "auto" && !onDemo);
}
