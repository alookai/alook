"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const SearchIcon = createAnimatedIcon(["search"], function useArtwork(controls, duration) {
    const lensVariants: Variants = {
        normal: { x: 0, y: 0, rotate: 0, opacity: 1 },
        animate: {
            x: [0, 2, -2, 1, 0],
            y: [0, -1, 2, -1, 0],
            rotate: [0, 6, -6, 4, 0],
            transition: {
                duration: 1 * duration,
                ease: "easeInOut" as const,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={lensVariants}>
       <m.circle cx="11" cy="11" r="8"/>
       <path d="m21 21-4.34-4.34"/>
      </m.g>
     </m.g>);
});
