"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ImagePlusIcon = createAnimatedIcon(["image-plus"], function useArtwork(controls, duration) {
    const plusVariants: Variants = {
        normal: { rotate: 0, scale: 1, transition: { duration: 0 } },
        animate: {
            rotate: [0, 90],
            scale: [1, 1.2, 1],
            transition: { duration: 0.5 * duration, ease: "easeInOut" },
        },
    };
    const sunVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.35, 0.9, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M16 5h6M19 2v6" variants={plusVariants} style={{ transformBox: "view-box", originX: "19px", originY: "5px" }}/>
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/>
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
      <m.circle cx="9" cy="9" r="2" variants={sunVariants} style={{ transformBox: "view-box", originX: "9px", originY: "9px" }}/>
     </m.g>);
});
