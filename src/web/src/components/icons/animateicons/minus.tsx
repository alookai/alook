"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MinusIcon = createAnimatedIcon(["minus"], function useArtwork(controls, duration) {
    const iconVariants: Variants = {
        normal: { rotate: 0, scale: 1, transition: { duration: 0 } },
        animate: {
            rotate: [0, 180],
            scale: [1, 0.7, 1],
            transition: { duration: 0.5 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g initial="normal" animate={controls} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M5 12h14" variants={iconVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
