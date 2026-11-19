"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PinIcon = createAnimatedIcon(["pin"], function useArtwork(controls, duration) {
    const pinVariants: Variants = {
        normal: { y: 0, rotate: 0 },
        animate: {
            y: [0, 1, 0.3, 0],
            rotate: [0, -9, 7, -3, 0],
            transition: {
                y: {
                    duration: 0.5 * duration,
                    ease: "easeInOut",
                    times: [0, 0.3, 0.6, 1],
                },
                rotate: { duration: 0.7 * duration, ease: "easeInOut" },
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={pinVariants} style={{ transformBox: "view-box", originX: "12px", originY: "22px" }}>
       <path d="M12 17v5"/>
       <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
      </m.g>
     </m.g>);
});
