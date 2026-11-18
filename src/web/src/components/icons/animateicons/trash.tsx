"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const TrashIcon = createAnimatedIcon(["trash", "trash-2"], function useArtwork(controls, duration) {
    const binVariants: Variants = {
        normal: { scaleY: 1, y: 0 },
        animate: {
            y: [0, 0, 1, 0],
            scaleY: [1, 1, 0.94, 1],
            transition: {
                duration: 0.9 * duration,
                times: [0, 0.55, 0.75, 1],
                ease: "easeOut",
            },
        },
    };
    const lidVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -24, -24, 0],
            transition: {
                duration: 0.9 * duration,
                times: [0, 0.2, 0.55, 1],
                ease: "easeInOut",
            },
        },
    };
    return (<m.g style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" variants={binVariants} initial="normal" animate={controls} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}/>
      <m.g animate={controls} initial="normal" variants={lidVariants} style={{ transformBox: "view-box", originX: "3px", originY: "6px" }}>
       <m.path d="M3 6h18"/>
       <m.path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </m.g>
     </m.g>);
});
