"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const TagIcon = createAnimatedIcon(["tag"], function useArtwork(controls, duration) {
    const swingVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -12, 9, -4, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={swingVariants} style={{ transformBox: "view-box", originX: "7.5px", originY: "7.5px" }}>
       <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/>
       <circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>
      </m.g>
     </m.g>);
});
