"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const LogOutIcon = createAnimatedIcon(["log-out"], function useArtwork(controls, duration) {
    const arrowVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -1, 1.6, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.25, 0.65, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={arrowVariants}>
       <path d="m16 17 5-5-5-5"/>
       <path d="M21 12H9"/>
      </m.g>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
     </m.g>);
});
