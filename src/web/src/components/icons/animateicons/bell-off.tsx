"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BellOffIcon = createAnimatedIcon(["bell-off"], function useArtwork(controls, duration) {
    const bodyVariants: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.45, 1],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const slashVariants: Variants = {
        normal: { strokeDashoffset: 0 },
        animate: {
            strokeDashoffset: [31, 0],
            transition: {
                duration: 0.45 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={bodyVariants}>
       <path d="M10.268 21a2 2 0 0 0 3.464 0"/>
       <path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/>
       <path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>
      </m.g>
      <m.path d="m2 2 20 20" strokeDasharray="30 200" strokeDashoffset="0" variants={slashVariants}/>
     </m.g>);
});
