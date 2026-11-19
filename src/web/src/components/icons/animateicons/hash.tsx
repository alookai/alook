"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const HashIcon = createAnimatedIcon(["hash"], function useArtwork(controls, duration) {
    const slideVariants = (dx: number, dy: number, delay: number): Variants => ({
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, dx, dx * -0.27, 0],
            y: [0, dy, dy * -0.27, 0],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: delay * duration,
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.line x1="4" x2="20" y1="9" y2="9" variants={slideVariants(1.5, 0, 0)}/>
      <m.line x1="4" x2="20" y1="15" y2="15" variants={slideVariants(-1.5, 0, 0.07)}/>
      <m.line x1="10" x2="8" y1="3" y2="21" variants={slideVariants(0, -1.5, 0.14)}/>
      <m.line x1="16" x2="14" y1="3" y2="21" variants={slideVariants(0, 1.5, 0.21)}/>
     </m.g>);
});
