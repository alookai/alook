"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PencilIcon = createAnimatedIcon(["pencil"], function useArtwork(controls, duration) {
    const writeVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -4.5, 4, -2, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={writeVariants} style={{ transformBox: "view-box", originX: "3px", originY: "21px" }}>
       <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>
       <path d="m15 5 4 4"/>
      </m.g>
     </m.g>);
});
