"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const MonitorDotIcon = createAnimatedIcon(["monitor-dot"], function useArtwork(controls, duration) {
    const screenVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -5, 4, -2, 0],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const badgeVariants: Variants = {
        normal: { scale: 1 },
        animate: {
            scale: [1, 1.25, 1],
            transition: {
                duration: 0.5 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={screenVariants} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}>
       <path d="M22 12.307V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8.693"/>
       <m.circle cx="19" cy="6" r="3" variants={badgeVariants} style={{ transformBox: "view-box", originX: "19px", originY: "6px" }}/>
      </m.g>
      <path d="M12 17v4"/>
      <path d="M8 21h8"/>
     </m.g>);
});
