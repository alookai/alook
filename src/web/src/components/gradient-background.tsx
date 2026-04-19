"use client";

import { useId } from "react";

export function GradientBackground() {
  const filterId = useId();

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[oklch(0.90_0.12_55)] dark:bg-transparent"
    >
      {/* Noise texture overlay */}
      <svg className="absolute inset-0 hidden w-full h-full opacity-[0.25] mix-blend-multiply pointer-events-none dark:block dark:mix-blend-overlay">
        <filter id={filterId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch" />
          <feComponentTransfer>
            <feFuncR type="linear" slope="0.5" intercept="0" />
            <feFuncG type="linear" slope="0.5" intercept="0" />
            <feFuncB type="linear" slope="0.5" intercept="0" />
          </feComponentTransfer>
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </svg>
    </div>
  );
}
