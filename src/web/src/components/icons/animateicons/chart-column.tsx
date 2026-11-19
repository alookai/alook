"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ChartColumnIcon = createAnimatedIcon(["chart-column", "bar-chart-3"], function useArtwork(controls, duration) {
    const barVariants = (i: number): Variants => ({
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.4, 1.05, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.75, 1],
                delay: i * 0.1 * duration,
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M3 3v16a2 2 0 0 0 2 2h16"/>
      <m.path d="M8 17v-3" variants={barVariants(0)} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}/>
      <m.path d="M13 17V5" variants={barVariants(1)} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}/>
      <m.path d="M18 17V9" variants={barVariants(2)} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}/>
     </m.g>);
});
