"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const UserRoundIcon = createAnimatedIcon(["user-round", "user-2"], function useArtwork(controls, duration) {
    const headVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.5, 0.5, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const bodyVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.88, 1.04, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="8" r="5" variants={headVariants}/>
      <m.path d="M20 21a8 8 0 0 0-16 0" variants={bodyVariants} style={{ transformBox: "view-box", originX: "12px", originY: "21px" }}/>
     </m.g>);
});
