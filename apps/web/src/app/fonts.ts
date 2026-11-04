import localFont from "next/font/local";

/** Departure Mono by Helena Zhang, SIL Open Font License 1.1 (see src/fonts/departure-mono/LICENSE). */
export const departureMono = localFont({
  src: "../fonts/departure-mono/DepartureMono-Regular.woff2",
  variable: "--font-departure",
  display: "swap",
  weight: "400",
  fallback: ["ui-monospace", "Menlo", "monospace"],
});
