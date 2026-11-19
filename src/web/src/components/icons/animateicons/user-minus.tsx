"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const UserMinusIcon = createAnimatedIcon(["user-minus"], function useArtwork(controls, duration) {
    const headVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.5, 0.5, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const minusVariants: Variants = {
        normal: { rotate: 0, scale: 1, transition: { duration: 0 } },
        animate: {
            rotate: [0, 180],
            scale: [1, 0.7, 1],
            transition: { duration: 0.5 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <m.circle cx="9" cy="7" r="4" variants={headVariants}/>
      <m.line x1="22" x2="16" y1="11" y2="11" variants={minusVariants} style={{ transformBox: "view-box", originX: "19px", originY: "11px" }}/>
     </m.g>);
});
