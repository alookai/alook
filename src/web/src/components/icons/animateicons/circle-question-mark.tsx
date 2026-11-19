"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CircleQuestionMarkIcon = createAnimatedIcon(["circle-question-mark", "help-circle", "circle-help"], function useArtwork(controls, duration) {
    const shapeVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.1, 0.96, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const curlVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -12, 10, -4, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const dotVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.5, 0.44999999999999996, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="12" r="10" variants={shapeVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" variants={curlVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}/>
      <m.path d="M12 17h.01" variants={dotVariants}/>
     </m.g>);
});
