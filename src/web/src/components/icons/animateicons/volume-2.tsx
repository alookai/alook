"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const Volume2Icon = createAnimatedIcon(["volume-2"], function useArtwork(controls, duration) {
    const speakerVariants: Variants = {
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
    const waveVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, 1.5, -0.4, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.1 * duration,
            },
        },
    };
    const outerWaveVariants: Variants = {
        normal: { x: 0 },
        animate: {
            x: [0, 0.9, -0.3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.2 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" variants={speakerVariants} style={{ transformBox: "view-box", originX: "6.5px", originY: "12px" }}/>
      <m.path d="M16 9a5 5 0 0 1 0 6" variants={waveVariants}/>
      <m.path d="M19.364 18.364a9 9 0 0 0 0-12.728" variants={outerWaveVariants}/>
     </m.g>);
});
