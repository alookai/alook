"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ListFilterIcon = createAnimatedIcon(["list-filter"], function useArtwork(controls, duration) {
    const lineVariants = (delay: number): Variants => ({
        normal: { scaleX: 1, opacity: 1 },
        animate: {
            scaleX: [1, 0.35, 1],
            opacity: [1, 0.6, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: delay * duration,
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M2 5h20" variants={lineVariants(0)} style={{ transformBox: "view-box", originX: "12px", originY: "5px" }}/>
      <m.path d="M6 12h12" variants={lineVariants(0.1)} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.path d="M9 19h6" variants={lineVariants(0.2)} style={{ transformBox: "view-box", originX: "12px", originY: "19px" }}/>
     </m.g>);
});
