"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const AtSignIcon = createAnimatedIcon(["at-sign"], function useArtwork(controls, duration) {
    const spinVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, 24, -8, 0],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const coreVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0.8, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: 0.2 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="12" r="4" variants={coreVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" variants={spinVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
