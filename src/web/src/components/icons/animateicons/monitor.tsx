"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MonitorIcon = createAnimatedIcon(["monitor"], function useArtwork(controls, duration) {
    const screenVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -5, 4, -2, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect width="20" height="14" x="2" y="3" rx="2" variants={screenVariants} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}/>
      <line x1="8" x2="16" y1="21" y2="21"/>
      <line x1="12" x2="12" y1="17" y2="21"/>
     </m.g>);
});
