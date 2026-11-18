"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ListChevronsUpDownIcon = createAnimatedIcon(["list-chevrons-up-down"], function useArtwork(controls, duration) {
    const rowVariants = (delay: number): Variants => ({
        normal: { scaleX: 1 },
        animate: {
            scaleX: [1, 0.6, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: delay * duration,
            },
        },
    });
    const chevronVariants = (dy: number): Variants => ({
        normal: { y: 0 },
        animate: {
            y: [0, dy, -dy * 0.25, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    });
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M3 5h8" variants={rowVariants(0)} style={{ transformBox: "view-box", originX: "3px", originY: "5px" }}/>
      <m.path d="M3 12h8" variants={rowVariants(0.1)} style={{ transformBox: "view-box", originX: "3px", originY: "12px" }}/>
      <m.path d="M3 19h8" variants={rowVariants(0.2)} style={{ transformBox: "view-box", originX: "3px", originY: "19px" }}/>
      <m.path d="m15 8 3-3 3 3" variants={chevronVariants(-2)}/>
      <m.path d="m15 16 3 3 3-3" variants={chevronVariants(2)}/>
     </m.g>);
});
