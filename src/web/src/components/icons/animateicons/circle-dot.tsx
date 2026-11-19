"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CircleDotIcon = createAnimatedIcon(["circle-dot"], function useArtwork(controls, duration) {
    const ringVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0.92, 1.03, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const dotVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0, 2.2, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeOut",
                times: [0, 0.25, 0.65, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="12" r="10" variants={ringVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.circle cx="12" cy="12" r="1" variants={dotVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
