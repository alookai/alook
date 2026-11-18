"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const Maximize2Icon = createAnimatedIcon(["maximize-2"], function useArtwork(controls, duration) {
    const arrowVariants = (dx: number, dy: number): Variants => ({
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, dx, -dx * 0.2, 0],
            y: [0, dy, -dy * 0.2, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={arrowVariants(1.5, -1.5)}>
       <path d="M15 3h6v6"/>
       <path d="m21 3-7 7"/>
      </m.g>
      <m.g variants={arrowVariants(-1.5, 1.5)}>
       <path d="m3 21 7-7"/>
       <path d="M9 21H3v-6"/>
      </m.g>
     </m.g>);
});
