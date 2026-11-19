"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const DatabaseIcon = createAnimatedIcon(["database"], function useArtwork(controls, duration) {
    const recordVariants: Variants = {
        normal: { y: 0, opacity: 0 },
        animate: {
            y: [-11, 0, 0.6, 0],
            opacity: [0, 1, 1, 0, 0],
            transition: {
                y: {
                    duration: 0.8 * duration,
                    times: [0, 0.4, 0.5, 1],
                    ease: ["easeIn", "easeOut", "easeInOut"],
                },
                opacity: {
                    duration: 0.8 * duration,
                    times: [0, 0.1, 0.4, 0.5, 1],
                    ease: "easeInOut",
                },
            },
        },
    };
    const lidVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, 0, 1, -0.3, 0],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.58, 0.8, 1],
            },
        },
    };
    const ringVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, 0, 1.4, -0.35, 0],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.63, 0.84, 1],
            },
        },
    };
    const bodyVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1, 0.96, 1.01, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.6, 0.82, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.ellipse cx="12" cy="5" rx="4" ry="1.3" variants={recordVariants}/>
      <m.ellipse cx="12" cy="5" rx="9" ry="3" variants={lidVariants}/>
      <m.g variants={bodyVariants} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}>
       <path d="M3 5V19A9 3 0 0 0 21 19V5"/>
      </m.g>
      <m.path d="M3 12A9 3 0 0 0 21 12" variants={ringVariants}/>
     </m.g>);
});
