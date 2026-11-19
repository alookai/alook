"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MessagesSquareIcon = createAnimatedIcon(["messages-square"], function useArtwork(controls, duration) {
    const bubbleVariants: Variants = {
        normal: { scale: 1 },
        animate: (i: number) => ({
            scale: [1, 0.85, 1.08, 1],
            transition: {
                duration: 0.55 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
                delay: i * 0.25 * duration,
            },
        }),
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" variants={bubbleVariants} custom={0} style={{ transformBox: "view-box", originX: "9px", originY: "7px" }}/>
      <m.path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" variants={bubbleVariants} custom={1} style={{ transformBox: "view-box", originX: "15px", originY: "14px" }}/>
     </m.g>);
});
