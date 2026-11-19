"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const HighlighterIcon = createAnimatedIcon(["highlighter"], function useArtwork(controls, duration) {
    const swipeVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, 10, -6, 4, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={swipeVariants} style={{ transformBox: "view-box", originX: "5px", originY: "19px" }}>
       <path d="m9 11-6 6v3h9l3-3"/>
       <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
      </m.g>
     </m.g>);
});
