"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const VolumeXIcon = createAnimatedIcon(["volume-x"], function useArtwork(controls, duration) {
    const bodyVariants: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.4, 1],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const crossVariants = (i: number): Variants => ({
        normal: { strokeDashoffset: 0, opacity: 1, scale: 1 },
        animate: {
            strokeDashoffset: [10, 0],
            opacity: [0, 1],
            scale: [0.85, 1.1, 1],
            transition: {
                strokeDashoffset: {
                    duration: 0.45 * duration,
                    ease: "easeOut",
                    delay: (0.12 + i * 0.1) * duration,
                },
                opacity: { duration: 0.25 * duration, delay: (0.12 + i * 0.1) * duration },
                scale: {
                    duration: 0.5 * duration,
                    ease: "easeInOut",
                    delay: (0.12 + i * 0.1) * duration,
                },
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" variants={bodyVariants}/>
      <m.line x1="22" x2="16" y1="9" y2="15" strokeDasharray="10" strokeDashoffset="0" variants={crossVariants(0)} style={{ transformBox: "fill-box", originX: "50%", originY: "50%" }}/>
      <m.line x1="16" x2="22" y1="9" y2="15" strokeDasharray="10" strokeDashoffset="0" variants={crossVariants(1)} style={{ transformBox: "fill-box", originX: "50%", originY: "50%" }}/>
     </m.g>);
});
