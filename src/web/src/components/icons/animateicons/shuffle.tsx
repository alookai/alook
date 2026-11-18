"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ShuffleIcon = createAnimatedIcon(["shuffle"], function useArtwork(controls, duration) {
    const headVariants = (delay: number): Variants => ({
        normal: { x: 0, scale: 1 },
        animate: {
            x: [0, 1, -0.2, 0],
            scale: [1, 1.15, 0.97, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                delay: delay * duration,
                times: [0, 0.35, 0.7, 1],
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m18 14 4 4-4 4" variants={headVariants(0.12)} style={{ transformBox: "view-box", originX: "22px", originY: "18px" }}/>
      <m.path d="m18 2 4 4-4 4" variants={headVariants(0)} style={{ transformBox: "view-box", originX: "22px", originY: "6px" }}/>
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/>
      <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/>
      <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>
     </m.g>);
});
