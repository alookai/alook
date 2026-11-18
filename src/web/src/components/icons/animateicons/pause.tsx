"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PauseIcon = createAnimatedIcon(["pause"], function useArtwork(controls, duration) {
    const barVariants = (delay: number): Variants => ({
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.55, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: delay * duration,
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect x="14" y="3" width="5" height="18" rx="1" variants={barVariants(0.15)} style={{ transformBox: "view-box", originX: "16.5px", originY: "12px" }}/>
      <m.rect x="5" y="3" width="5" height="18" rx="1" variants={barVariants(0)} style={{ transformBox: "view-box", originX: "7.5px", originY: "12px" }}/>
     </m.g>);
});
