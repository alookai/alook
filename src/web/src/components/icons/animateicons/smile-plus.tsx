"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const SmilePlusIcon = createAnimatedIcon(["smile-plus"], function useArtwork(controls, duration) {
  const faceVariants: Variants = {
    normal: { scale: 1 },
    animate: {
      scale: [1, 1.05, 1],
      transition: { duration: 0.4 * duration, ease: "easeInOut" },
    },
  };
  const plusVariants: Variants = {
    normal: { scale: 1, rotate: 0 },
    animate: {
      scale: [1, 1.2, 1],
      rotate: [0, 90],
      transition: { duration: 0.4 * duration, ease: "easeOut" },
    },
  };
  return (
    <>
      <m.g animate={controls} initial="normal" variants={faceVariants} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
        <path d="M13.267 2.08a10 10 0 108.653 8.653" />
        <path d="M16.472 15a6 6 0 01-8.943 0" />
        <path d="M9 10V9" />
        <path d="M15 10V9" />
      </m.g>
      <m.g animate={controls} initial="normal" variants={plusVariants} style={{ transformBox: "view-box", originX: "19px", originY: "5px" }}>
        <path d="M16 5h6" />
        <path d="M19 2v6" />
      </m.g>
    </>
  );
});
