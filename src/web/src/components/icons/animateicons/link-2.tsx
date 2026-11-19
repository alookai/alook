"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const Link2Icon = createAnimatedIcon(["link-2"], function useArtwork(controls, duration) {
  const leftVariants: Variants = {
    normal: { x: 0 },
    animate: {
      x: [0, -1.5, 0],
      transition: { duration: 0.4 * duration, ease: "easeInOut" },
    },
  };
  const rightVariants: Variants = {
    normal: { x: 0 },
    animate: {
      x: [0, 1.5, 0],
      transition: { duration: 0.4 * duration, ease: "easeInOut" },
    },
  };
  return (
    <>
      <m.path d="M9 17H7A5 5 0 0 1 7 7h2" animate={controls} initial="normal" variants={leftVariants} />
      <m.path d="M15 7h2a5 5 0 1 1 0 10h-2" animate={controls} initial="normal" variants={rightVariants} />
      <line x1="8" x2="16" y1="12" y2="12" />
    </>
  );
});
