"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ShieldIcon = createAnimatedIcon(["shield"], function useArtwork(controls, duration) {
    const blockVariants: Variants = {
        normal: { rotate: 0, x: 0 },
        animate: {
            rotate: [0, -7, 4, -1.5, 0],
            x: [0, -0.6, 0.25, -0.1, 0],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.2, 0.5, 0.78, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={blockVariants} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}>
       <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
      </m.g>
     </m.g>);
});
