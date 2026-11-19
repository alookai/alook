"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MessageSquareIcon = createAnimatedIcon(["message-square"], function useArtwork(controls, duration) {
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
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" variants={bubbleVariants} style={{ transformBox: "view-box", originX: "4px", originY: "20px" }}/>
     </m.g>);
});
