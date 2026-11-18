"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MailWarningIcon = createAnimatedIcon(["mail-exclamation-point", "mail-warning", "mail-alert"], function useArtwork(controls, duration) {
    const flapVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, -0.8, -0.8, 1],
            transition: {
                duration: 0.8 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.65, 1],
            },
        },
    };
    const markVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -14, 12, -6, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                delay: 0.2 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <path d="M22 10.5V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12c0 1.1.9 2 2 2h12.5"/>
      <m.path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" variants={flapVariants} style={{ transformBox: "view-box", originX: "12px", originY: "7px" }}/>
      <m.g variants={markVariants} style={{ transformBox: "view-box", originX: "20px", originY: "18px" }}>
       <path d="M20 14v4"/>
       <path d="M20 22v.01"/>
      </m.g>
     </m.g>);
});
