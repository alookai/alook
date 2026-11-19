"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const DicesIcon = createAnimatedIcon(["dices"], function useArtwork(controls, duration) {
  const frontDie: Variants = {
    normal: { rotate: 0 },
    animate: {
      rotate: [0, -10, 6, 0],
      transition: { duration: 0.45 * duration, ease: "easeInOut" },
    },
  };
  const backDie: Variants = {
    normal: { rotate: 0, translateY: 0 },
    animate: {
      rotate: [0, 8, -4, 0],
      translateY: [0, -1, 0],
      transition: { duration: 0.45 * duration, ease: "easeInOut" },
    },
  };
  return (
    <>
      <m.g animate={controls} initial="normal" variants={frontDie} style={{ transformBox: "view-box", originX: "8px", originY: "16px" }}>
        <rect width="12" height="12" x="2" y="10" rx="2" ry="2" />
        <path d="M6 18h.01" />
        <path d="M10 14h.01" />
      </m.g>
      <m.g animate={controls} initial="normal" variants={backDie} style={{ transformBox: "view-box", originX: "15px", originY: "8px" }}>
        <path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6" />
        <path d="M15 6h.01" />
        <path d="M18 9h.01" />
      </m.g>
    </>
  );
});
