"use client";

import { useEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Fades the edge of a sideways-scrolling row that hides content (a tab row, a wide table on a
 * phone), so it reads as scrollable without a scrollbar. A mask, not an overlay: it works on any
 * background. `overflow` is true while some content is out of view. Content that grows inside a
 * row of constant width (a count badge arriving after a load) resizes nothing, so a caller whose
 * content changes passes a `contentKey` that changes with it.
 */
export function useEdgeFade(ref: RefObject<HTMLElement | null>, contentKey = ""): { style: CSSProperties | undefined; overflow: boolean } {
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    // `observe` reports the element's size once, so each run of this effect (on mount and on every
    // new `contentKey`) measures the row.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [ref, contentKey]);
  const overflow = edges.start || edges.end;
  const fade = overflow ? `linear-gradient(to right, ${edges.start ? "transparent, black 24px" : "black, black"}, ${edges.end ? "black calc(100% - 24px), transparent" : "black, black"})` : null;
  return { style: fade ? { maskImage: fade, WebkitMaskImage: fade } : undefined, overflow };
}
