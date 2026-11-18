"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BoxIcon = createAnimatedIcon(["box"], function useArtwork(controls, duration) {
    const boxVariants: Variants = {
        normal: { y: 0, rotate: 0 },
        animate: {
            y: [0, -1, 0.3, 0],
            rotate: [0, -7, 5, 0],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={boxVariants} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}>
       <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
       <path d="m3.3 7 8.7 5 8.7-5"/>
       <path d="M12 22V12"/>
      </m.g>
     </m.g>);
});
