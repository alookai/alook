"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CheckIcon = createAnimatedIcon(["check"], function useArtwork(controls, duration) {
    const tickVariants: Variants = {
        normal: { strokeDashoffset: 0, scale: 1, opacity: 1 },
        animate: {
            strokeDashoffset: [20, 0],
            scale: [0.9, 1.12, 1],
            opacity: [0, 1],
            transition: {
                strokeDashoffset: { duration: 0.5 * duration, ease: "easeOut" },
                scale: {
                    duration: 0.55 * duration,
                    ease: "easeInOut",
                    times: [0, 0.6, 1],
                },
                opacity: { duration: 0.25 * duration, ease: "easeOut" },
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M5 13l4 4L19 7" strokeDasharray="20" strokeDashoffset="0" variants={tickVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
