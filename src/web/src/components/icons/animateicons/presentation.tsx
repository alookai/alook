"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PresentationIcon = createAnimatedIcon(["presentation"], function useArtwork(controls, duration) {
    const boardVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -3, 2.5, -1, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const legVariants: Variants = {
        normal: { scaleX: 1 },
        animate: {
            scaleX: [1, 1.15, 0.97, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.05 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={boardVariants} style={{ transformBox: "view-box", originX: "12px", originY: "16px" }}>
       <path d="M2 3h20"/>
       <path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/>
      </m.g>
      <m.path d="m7 21 5-5 5 5" variants={legVariants} style={{ transformBox: "view-box", originX: "12px", originY: "16px" }}/>
     </m.g>);
});
