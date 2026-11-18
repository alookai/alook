"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BanIcon = createAnimatedIcon(["ban"], function useArtwork(controls, duration) {
    const slashVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -16, 12, -6, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <circle cx="12" cy="12" r="10"/>
      <m.path d="M4.929 4.929 19.07 19.071" variants={slashVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
