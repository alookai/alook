"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const FileIcon = createAnimatedIcon(["file"], function useArtwork(controls, duration) {
    const popVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.08, 0.98, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={popVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>
       <path d="M14 2v5a1 1 0 0 0 1 1h5"/>
      </m.g>
     </m.g>);
});
