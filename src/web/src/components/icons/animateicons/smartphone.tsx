"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const SmartphoneIcon = createAnimatedIcon(["smartphone"], function useArtwork(controls, duration) {
    const buzzVariants: Variants = {
        normal: { x: 0, rotate: 0 },
        animate: {
            x: [0, -1, 1, -0.5, 0],
            rotate: [0, -4, 4, -2, 0],
            transition: { duration: 0.6 * duration, ease: "easeInOut" },
        },
    };
    const dotVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.6, 0.9, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={buzzVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <rect width="14" height="20" x="5" y="2" rx="2" ry="2"/>
       <m.path d="M12 18h.01" variants={dotVariants} style={{ transformBox: "view-box", originX: "12px", originY: "18px" }}/>
      </m.g>
     </m.g>);
});
