"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const XIcon = createAnimatedIcon(["x"], function useArtwork(controls, duration) {
    const crossVariants: Variants = {
        normal: { rotate: 0, scale: 1, transition: { duration: 0 } },
        animate: {
            rotate: [0, 90],
            scale: [1, 1.2, 1],
            transition: { duration: 0.5 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={crossVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <path d="M18 6 6 18"/>
       <path d="m6 6 12 12"/>
      </m.g>
     </m.g>);
});
