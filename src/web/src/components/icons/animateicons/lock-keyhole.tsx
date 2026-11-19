"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const LockKeyholeIcon = createAnimatedIcon(["lock-keyhole"], function useArtwork(controls, duration) {
    const lockVariants: Variants = {
        normal: { x: 0, rotate: 0 },
        animate: {
            x: [0, -3, 3, -3, 0],
            rotate: [0, -2, 2, -2, 0],
            transition: { duration: 0.55 * duration, ease: "easeInOut" },
        },
    };
    const holeVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.5, 1],
            transition: {
                duration: 0.4 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={lockVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <m.circle cx="12" cy="16" r="1" variants={holeVariants} style={{ transformBox: "view-box", originX: "12px", originY: "16px" }}/>
       <rect x="3" y="10" width="18" height="12" rx="2"/>
       <path d="M7 10V7a5 5 0 0 1 10 0v3"/>
      </m.g>
     </m.g>);
});
