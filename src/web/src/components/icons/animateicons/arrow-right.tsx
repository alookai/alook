"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ArrowRightIcon = createAnimatedIcon(["arrow-right"], function useArtwork(controls, duration) {
    const nudgeVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -2, 4, 0],
            transition: {
                duration: 0.6 * duration,
                times: [0, 0.2, 0.6, 1],
                ease: "easeInOut",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" variants={nudgeVariants} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M5 12h14"/>
      <path d="m12 5 7 7-7 7"/>
     </m.g>);
});
