"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const SquareIcon = createAnimatedIcon(["square"], function useArtwork(controls, duration) {
    const tumbleVariants: Variants = {
        normal: { rotate: 0, scale: 1, y: 0, transition: { duration: 0 } },
        animate: {
            rotate: [0, 90],
            scale: [1, 0.8, 1],
            y: [0, -1, 0],
            transition: { duration: 0.6 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect width="18" height="18" x="3" y="3" rx="2" variants={tumbleVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
