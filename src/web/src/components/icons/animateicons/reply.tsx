"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ReplyIcon = createAnimatedIcon(["reply"], function useArtwork(controls, duration) {
    const nudgeVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -2, 0.6, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={nudgeVariants}>
       <path d="M20 18v-2a4 4 0 0 0-4-4H4"/>
       <path d="m9 17-5-5 5-5"/>
      </m.g>
     </m.g>);
});
