"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const SettingsIcon = createAnimatedIcon(["settings"], function useArtwork(controls, duration) {
    const gearVariants: Variants = {
        normal: { rotate: 0, scale: 1 },
        animate: {
            rotate: [0, 30, -6, 0],
            scale: [1, 1.05, 1.02, 1],
            transition: {
                duration: 0.9 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const hubVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.25, 0.9, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" variants={gearVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.circle cx="12" cy="12" r="3" variants={hubVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
