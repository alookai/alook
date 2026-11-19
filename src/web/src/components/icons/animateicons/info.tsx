"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const InfoIcon = createAnimatedIcon(["info"], function useArtwork(controls, duration) {
    const ringVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.08, 0.97, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const dotVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -2, 0.6, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.08 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="12" r="10" variants={ringVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <path d="M12 16v-4"/>
      <m.path d="M12 8h.01" variants={dotVariants}/>
     </m.g>);
});
