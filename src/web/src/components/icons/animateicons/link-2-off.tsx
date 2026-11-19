"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const Link2OffIcon = createAnimatedIcon(["link-2-off"], function useArtwork(controls, duration) {
  const shakeVariants: Variants = {
    normal: { x: 0 },
    animate: {
      x: [0, -1.5, 1.5, 0],
      transition: { duration: 0.4 * duration, ease: "easeInOut" },
    },
  };
  return (
    <m.g animate={controls} initial="normal" variants={shakeVariants}>
      <path d="M9 17H7A5 5 0 0 1 7 7" />
      <path d="M15 7h2a5 5 0 0 1 4 8" />
      <line x1="8" x2="12" y1="12" y2="12" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </m.g>
  );
});
