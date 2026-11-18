"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const TerminalIcon = createAnimatedIcon(["terminal"], function useArtwork(controls, duration) {
    const promptVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, 2, -0.4, 0],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const cursorVariants: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.1, 1, 0.1, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                delay: 0.15 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M12 19h8" variants={cursorVariants}/>
      <m.path d="m4 17 6-6-6-6" variants={promptVariants}/>
     </m.g>);
});
