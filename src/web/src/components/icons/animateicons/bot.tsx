"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BotIcon = createAnimatedIcon(["bot"], function useArtwork(controls, duration) {
    const headVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.5, 0, -0.75, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    const antennaVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -16, 12, -6, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    const eyeVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.1, 0.1, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.33, 0.67, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={headVariants}>
       <m.path d="M12 8V4H8" variants={antennaVariants} style={{ transformBox: "view-box", originX: "12px", originY: "8px" }}/>
       <rect width="16" height="12" x="4" y="8" rx="2"/>
       <path d="M2 14h2"/>
       <path d="M20 14h2"/>
       <m.path d="M15 13v2" variants={eyeVariants} style={{ transformBox: "view-box", originX: "15px", originY: "14px" }}/>
       <m.path d="M9 13v2" variants={eyeVariants} style={{ transformBox: "view-box", originX: "9px", originY: "14px" }}/>
      </m.g>
     </m.g>);
});
