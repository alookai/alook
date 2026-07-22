"use client";

import { BoringAvatar } from "./boring-avatar";

/**
 * A seeded marble gradient that fills its positioned parent — the SVG
 * replacement for the old `style={{ background: gradientFromSeed(id) }}`.
 *
 * Render it as the first child of a `relative overflow-hidden` container; the
 * letter/content that used to sit on the CSS gradient stays on top. `object-fit`
 * doesn't apply to an inline `<svg>`, so we size the SVG to 100% and let the
 * container clip it.
 */
export function MarbleBackground({ seed }: { seed: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 [&>svg]:size-full">
      <BoringAvatar seed={seed} variant="marble" square size="100%" preserveAspectRatio="none" />
    </span>
  );
}
