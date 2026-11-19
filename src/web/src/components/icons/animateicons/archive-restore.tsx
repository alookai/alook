"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";

export const ArchiveRestoreIcon = createAnimatedIcon(["archive-restore"], function useArtwork(controls, duration) {
  const lidVariants: Variants = {
    normal: { y: 0 },
    animate: {
      y: [0, -1.5, 0],
      transition: { duration: 0.45 * duration, ease: "easeInOut" },
    },
  };
  const arrowVariants: Variants = {
    normal: { y: 0 },
    animate: {
      y: [0, -2, 0],
      transition: { duration: 0.45 * duration, ease: "easeOut" },
    },
  };
  return (
    <>
      <m.rect width="20" height="5" x="2" y="3" rx="1" animate={controls} initial="normal" variants={lidVariants} />
      <path d="M4 8v11a2 2 0 0 0 2 2h2" />
      <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
      <m.g animate={controls} initial="normal" variants={arrowVariants}>
        <path d="m9 15 3-3 3 3" />
        <path d="M12 12v9" />
      </m.g>
    </>
  );
});
