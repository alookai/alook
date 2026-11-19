"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ImageIcon = createAnimatedIcon(["image"], function useArtwork(controls, duration) {
    const sunVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.35, 0.9, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const hillVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1.15, 0.97, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.08 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
      <m.circle cx="9" cy="9" r="2" variants={sunVariants} style={{ transformBox: "view-box", originX: "9px", originY: "9px" }}/>
      <m.path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" variants={hillVariants} style={{ transformBox: "view-box", originX: "12px", originY: "21px" }}/>
     </m.g>);
});
