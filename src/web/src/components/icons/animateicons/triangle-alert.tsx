"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const TriangleAlertIcon = createAnimatedIcon(["triangle-exclamation-point", "alert-triangle", "triangle-alert"], function useArtwork(controls, duration) {
    const shapeVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.07, 0.97, 1],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const markVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -14, 12, -6, 0],
            transition: { duration: 0.6 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" variants={shapeVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}/>
      <m.g variants={markVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}>
       <path d="M12 9v4"/>
       <path d="M12 17h.01"/>
      </m.g>
     </m.g>);
});
