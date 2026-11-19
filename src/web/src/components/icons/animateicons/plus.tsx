"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PlusIcon = createAnimatedIcon(["plus"], function useArtwork(controls, duration) {
    const popVariants: Variants = {
        normal: { rotate: 0, scale: 1, transition: { duration: 0 } },
        animate: {
            rotate: [0, 90],
            scale: [1, 1.2, 1],
            transition: { duration: 0.5 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M5 12h14M12 5v14" variants={popVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
