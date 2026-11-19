"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const WrapTextIcon = createAnimatedIcon(["text-wrap", "wrap-text"], function useArtwork(controls, duration) {
    const arrowVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, -1.5, 0.4, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const tailVariants: Variants = {
        normal: { scaleX: 1 },
        animate: {
            scaleX: [1, 1.3, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m16 16-3 3 3 3" variants={arrowVariants}/>
      <path d="M3 12h14.5a1 1 0 0 1 0 7H13"/>
      <m.path d="M3 19h6" variants={tailVariants} style={{ transformBox: "view-box", originX: "3px", originY: "19px" }}/>
      <path d="M3 5h18"/>
     </m.g>);
});
