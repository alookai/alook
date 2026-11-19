"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const DollarSignIcon = createAnimatedIcon(["dollar-sign"], function useArtwork(controls, duration) {
    const coinVariants: Variants = {
        normal: { scaleX: 1, y: 0 },
        animate: {
            scaleX: [1, 0.2, 1],
            y: [0, -1.5, 0],
            transition: { duration: 0.6 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <line x1="12" x2="12" y1="2" y2="22"/>
      <m.path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" variants={coinVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
