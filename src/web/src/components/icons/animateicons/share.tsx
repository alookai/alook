"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ShareIcon = createAnimatedIcon(["share"], function useArtwork(controls, duration) {
    const arrowVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, 1.5, -1, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.3, 0.7, 1],
            },
        },
    };
    const trayVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.94, 1.02, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.3, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={arrowVariants}>
       <path d="M12 2v13"/>
       <path d="m16 6-4-4-4 4"/>
      </m.g>
      <m.path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" variants={trayVariants} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}/>
     </m.g>);
});
