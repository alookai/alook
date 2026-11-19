"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const HouseIcon = createAnimatedIcon(["house", "home"], function useArtwork(controls, duration) {
    const houseVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0.8, 1.06, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.75, 1],
            },
        },
    };
    const doorVariants: Variants = {
        normal: { strokeDashoffset: 0, opacity: 1 },
        animate: {
            strokeDashoffset: [25, 0],
            opacity: [0, 1],
            transition: {
                strokeDashoffset: {
                    duration: 0.45 * duration,
                    ease: "easeOut",
                    delay: 0.35 * duration,
                },
                opacity: { duration: 0.25 * duration, delay: 0.35 * duration },
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={houseVariants} style={{ transformBox: "view-box", originX: "12px", originY: "21px" }}>
       <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
       <m.path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" strokeDasharray="25" strokeDashoffset="0" variants={doorVariants}/>
      </m.g>
     </m.g>);
});
