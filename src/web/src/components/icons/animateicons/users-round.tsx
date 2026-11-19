"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const UsersRoundIcon = createAnimatedIcon(["users-round", "users-2"], function useArtwork(controls, duration) {
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
    const sideVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.2, 0.4, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M18 21a8 8 0 0 0-16 0"/>
      <m.circle cx="10" cy="8" r="5" variants={headVariants}/>
      <m.path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" variants={sideVariants}/>
     </m.g>);
});
