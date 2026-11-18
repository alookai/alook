"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MailIcon = createAnimatedIcon(["mail"], function useArtwork(controls, duration) {
    const flapVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, -0.8, -0.8, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.65, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" variants={flapVariants} style={{ transformBox: "view-box", originX: "12px", originY: "7px" }}/>
      <rect x="2" y="4" width="20" height="16" rx="2"/>
     </m.g>);
});
