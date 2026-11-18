"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CodeXmlIcon = createAnimatedIcon(["code-xml", "code-2"], function useArtwork(controls, duration) {
    const leftVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -1, 0.3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const rightVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, 1, -0.3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const slashVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, 10, -3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m18 16 4-4-4-4" variants={rightVariants}/>
      <m.path d="m6 8-4 4 4 4" variants={leftVariants}/>
      <m.path d="m14.5 4-5 16" variants={slashVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
