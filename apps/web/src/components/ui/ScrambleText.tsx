"use client";

import { useEffect, useState } from "react";

const HEX = "0123456789abcdef";
const STEP_MS = 40;
const DURATION_MS = 720;

/**
 * Opaque data (a ciphertext hash) that decodes from random hex into its value, left to right, the
 * first time it shows (adapted from Motion Primitives' TextScramble, MIT, see THIRD_PARTY_LICENSES.md: a timer instead of a
 * motion component, hex glyphs only). The final text is always exactly `text`; reduced motion
 * shows it at once.
 */
export function ScrambleText({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const steps = DURATION_MS / STEP_MS;
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      const revealed = Math.floor((step / steps) * text.length);
      if (step >= steps) {
        window.clearInterval(timer);
        setDisplay(text);
        return;
      }
      let next = text.slice(0, revealed);
      for (let i = revealed; i < text.length; i += 1) next += HEX[Math.floor(Math.random() * HEX.length)];
      setDisplay(next);
    }, STEP_MS);
    return () => {
      window.clearInterval(timer);
      setDisplay(text);
    };
  }, [text]);

  return <span className={className}>{display}</span>;
}
