"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const GaugeIcon = createAnimatedIcon(["gauge"], function useArtwork(controls, duration) {
    const needleVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -95, 25, -5, 0],
            transition: {
                duration: 0.9 * duration,
                ease: "easeInOut",
                times: [0, 0.3, 0.65, 0.85, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m12 14 4-4" variants={needleVariants} style={{ transformBox: "view-box", originX: "12px", originY: "14px" }}/>
      <path d="M3.34 19a10 10 0 1 1 17.32 0"/>
     </m.g>);
});
