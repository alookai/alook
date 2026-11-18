"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ExternalLinkIcon = createAnimatedIcon(["external-link"], function useArtwork(controls, duration) {
    const arrowVariants: Variants = {
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, 1.5, -0.4, 0],
            y: [0, -1.5, 0.4, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={arrowVariants}>
       <path d="M15 3h6v6"/>
       <path d="M10 14 21 3"/>
      </m.g>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
     </m.g>);
});
