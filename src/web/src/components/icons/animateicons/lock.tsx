"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const LockIcon = createAnimatedIcon(["lock"], function useArtwork(controls, duration) {
    const lockVariants: Variants = {
        normal: { x: 0, rotate: 0 },
        animate: {
            x: [0, -3, 3, -3, 0],
            rotate: [0, -2, 2, -2, 0],
            transition: { duration: 0.55 * duration },
        },
    };
    return (<m.g variants={lockVariants} animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect width="18" height="11" x="3" y="11" rx="2" ry="2" initial="normal" animate={controls}/>
      <m.path d="M7 11V7a5 5 0 0 1 10 0v4" initial="normal" animate={controls}/>
     </m.g>);
});
