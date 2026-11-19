"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const SunIcon = createAnimatedIcon(["sun"], function useArtwork(controls, duration) {
    const svgVariant: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, 14, -6, 0],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const centerVariant: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.18, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
            },
        },
    };
    const rayVariant: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.7, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
            },
        },
    };
    return (<m.g animate={controls} initial="normal" variants={svgVariant} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="12" r="4" variants={centerVariant}/>
      <m.path d="M12 2v2" variants={rayVariant}/>
      <m.path d="M12 20v2" variants={rayVariant}/>
      <m.path d="m4.93 4.93 1.41 1.41" variants={rayVariant}/>
      <m.path d="m17.66 17.66 1.41 1.41" variants={rayVariant}/>
      <m.path d="M2 12h2" variants={rayVariant}/>
      <m.path d="M20 12h2" variants={rayVariant}/>
      <m.path d="m6.34 17.66-1.41 1.41" variants={rayVariant}/>
      <m.path d="m19.07 4.93-1.41 1.41" variants={rayVariant}/>
     </m.g>);
});
