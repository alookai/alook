"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ArrowDownIcon = createAnimatedIcon(["arrow-down"], function useArtwork(controls, duration) {
    const nudgeVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -2, 4, 0],
            transition: {
                duration: 0.6 * duration,
                times: [0, 0.2, 0.6, 1],
                ease: "easeInOut",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" variants={nudgeVariants} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M12 5v14"/>
      <path d="m19 12-7 7-7-7"/>
     </m.g>);
});
