"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const RocketIcon = createAnimatedIcon(["rocket"], function useArtwork(controls, duration) {
    const launchVariants: Variants = {
        normal: { x: 0, y: 0 },
        animate: {
            x: [0, 24, -24, 0],
            y: [0, -24, 24, 0],
            transition: {
                duration: 0.9 * duration,
                ease: ["easeIn", "linear", "easeOut"],
                times: [0, 0.4, 0.4001, 1],
            },
        },
    };
    const flameVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.5, 0.9, 1.4, 1],
            transition: {
                duration: 0.4 * duration,
                ease: "easeInOut",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={launchVariants}>
       <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
       <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
       <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
       <m.path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" variants={flameVariants} style={{
            transformBox: "view-box",
            originX: "5.5px",
            originY: "18.5px",
        }}/>
      </m.g>
     </m.g>);
});
