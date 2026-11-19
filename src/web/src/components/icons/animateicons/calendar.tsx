"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CalendarIcon = createAnimatedIcon(["calendar"], function useArtwork(controls, duration) {
    const ringVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, 1.6, -0.3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const bodyVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1, 0.96, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.65, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M8 2v3" variants={ringVariants}/>
      <m.path d="M16 2v3" variants={ringVariants}/>
      <m.g variants={bodyVariants} style={{ transformBox: "view-box", originX: "12px", originY: "21px" }}>
       <rect x="3" y="3" width="18" height="18" rx="2"/>
       <path d="M3 9h18"/>
      </m.g>
     </m.g>);
});
