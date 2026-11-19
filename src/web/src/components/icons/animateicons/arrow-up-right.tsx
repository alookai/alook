"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ArrowUpRightIcon = createAnimatedIcon(["arrow-up-right"], function useArtwork(controls, duration) {
    const nudgeVariants: Variants = {
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, -1.5, 3, 0],
            y: [0, 1.5, -3, 0],
            transition: {
                duration: 0.6 * duration,
                times: [0, 0.2, 0.6, 1],
                ease: "easeInOut",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" variants={nudgeVariants} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M7 7h10v10"/>
      <path d="M7 17 17 7"/>
     </m.g>);
});
