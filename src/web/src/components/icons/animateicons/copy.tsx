"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CopyIcon = createAnimatedIcon(["copy"], function useArtwork(controls, duration) {
    const frontVariants: Variants = {
        normal: { x: 0, y: 0, rotate: 0, transition: { duration: 0 } },
        animate: {
            x: [0, -3, 0],
            y: [0, -3, 0],
            rotate: [0, 360],
            transition: { duration: 0.9 * duration, ease: "easeInOut" },
        },
    };
    const backVariants: Variants = {
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, 3, 0],
            y: [0, 3, 0],
            transition: { duration: 0.9 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect width="14" height="14" x="8" y="8" rx="2" ry="2" variants={frontVariants} style={{ transformBox: "view-box", originX: "15px", originY: "15px" }}/>
      <m.path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" variants={backVariants}/>
     </m.g>);
});
