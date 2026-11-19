"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const SmileIcon = createAnimatedIcon(["smile"], function useArtwork(controls, duration) {
  const faceVariants: Variants = {
    normal: { scale: 1, rotate: 0 },
    animate: {
      scale: [1, 1.07, 1],
      rotate: [0, -5, 4, 0],
      transition: { duration: 0.45 * duration, ease: "easeInOut" },
    },
  };
  return (
    <m.g animate={controls} initial="normal" variants={faceVariants} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <circle cx="12" cy="12" r="10" />
      <path d="M16.472 15a6 6 0 01-8.943 0" />
      <path d="M9 10V9" />
      <path d="M15 10V9" />
    </m.g>
  );
});
