"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CameraIcon = createAnimatedIcon(["camera"], function useArtwork(controls, duration) {
    const lensVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0.6, 1.15, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const bodyVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 0.97, 1],
            transition: { duration: 0.35 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z" variants={bodyVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}/>
      <m.circle cx="12" cy="13" r="3" variants={lensVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}/>
     </m.g>);
});
