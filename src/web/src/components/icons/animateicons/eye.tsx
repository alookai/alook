"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const EyeIcon = createAnimatedIcon(["eye"], function useArtwork(controls, duration) {
    const blinkVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1, 0.2, 1],
            transition: {
                duration: 0.9 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.72, 1],
            },
        },
    };
    const pupilVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -2.5, 2.5, 0],
            transition: {
                duration: 0.45 * duration,
                ease: "easeInOut",
                times: [0, 0.3, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={blinkVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>
       <m.circle cx="12" cy="12" r="3" variants={pupilVariants}/>
      </m.g>
     </m.g>);
});
