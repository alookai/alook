"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ActivityIcon = createAnimatedIcon(["activity"], function useArtwork(controls, duration) {
    const activityVariants: Variants = {
        normal: {
            strokeDasharray: "none",
            strokeDashoffset: 0,
            opacity: 1,
        },
        animate: {
            strokeDasharray: "60 120",
            strokeDashoffset: [0, -180],
            transition: {
                duration: 1.4 * duration,
                ease: "linear",
                repeat: Infinity,
                repeatType: "loop",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M2 12h2.49a2 2 0 0 0 1.92-1.46l2.35-8.36a.25.25 0 0 1 .48 0l5.52 19.64a.25.25 0 0 0 .48 0l2.35-8.36A2 2 0 0 1 19.52 12H22" variants={activityVariants}/>
     </m.g>);
});
