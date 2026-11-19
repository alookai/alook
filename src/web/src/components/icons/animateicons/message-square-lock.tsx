"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MessageSquareLockIcon = createAnimatedIcon(["message-square-lock"], function useArtwork(controls, duration) {
    const bubbleVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 0.7, 1.05, 1],
            transition: {
                duration: 0.65 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.75, 1],
            },
        },
    };
    const shackleVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -2, 0.5, 0],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.72, 1],
                delay: 0.1 * duration,
            },
        },
    };
    const lockVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1, 0.88, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.72, 1],
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={bubbleVariants} style={{ transformBox: "view-box", originX: "4px", originY: "20px" }}>
       <path d="M22 8.5V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v16.286a.71.71 0 0 0 1.212.502l2.202-2.202A2 2 0 0 1 6.828 19H10"/>
       <m.path d="M20 15v-2a2 2 0 0 0-4 0v2" variants={shackleVariants}/>
       <m.rect x="14" y="15" width="8" height="5" rx="1" variants={lockVariants} style={{ transformBox: "view-box", originX: "18px", originY: "20px" }}/>
      </m.g>
     </m.g>);
});
