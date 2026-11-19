"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ChevronRightIcon = createAnimatedIcon(["chevron-right"], function useArtwork(controls, duration) {
    const nudgeVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, 2.5, -0.625, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m9 18 6-6-6-6" variants={nudgeVariants}/>
     </m.g>);
});
