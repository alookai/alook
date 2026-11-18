"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BrainIcon = createAnimatedIcon(["brain"], function useArtwork(controls, duration) {
    const brainVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.06, 0.97, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const thoughtVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.4, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: 0.15 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={brainVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <path d="M12 18V5"/>
       <m.path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" variants={thoughtVariants} style={{ transformBox: "view-box", originX: "12px", originY: "11px" }}/>
       <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/>
       <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/>
       <path d="M18 18a4 4 0 0 0 2-7.464"/>
       <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/>
       <path d="M6 18a4 4 0 0 1-2-7.464"/>
       <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>
      </m.g>
     </m.g>);
});
