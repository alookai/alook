"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MaximizeIcon = createAnimatedIcon(["maximize"], function useArtwork(controls, duration) {
    const cornerVariants = (dx: number, dy: number): Variants => ({
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, dx, -dx * 0.2, 0],
            y: [0, dy, -dy * 0.2, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M8 3H5a2 2 0 0 0-2 2v3" variants={cornerVariants(-1.5, -1.5)}/>
      <m.path d="M21 8V5a2 2 0 0 0-2-2h-3" variants={cornerVariants(1.5, -1.5)}/>
      <m.path d="M3 16v3a2 2 0 0 0 2 2h3" variants={cornerVariants(-1.5, 1.5)}/>
      <m.path d="M16 21h3a2 2 0 0 0 2-2v-3" variants={cornerVariants(1.5, 1.5)}/>
     </m.g>);
});
