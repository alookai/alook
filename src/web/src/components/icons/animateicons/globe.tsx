"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const GlobeIcon = createAnimatedIcon(["globe"], function useArtwork(controls, duration) {
    const meridianVariants: Variants = {
        normal: { scaleX: 1 },
        animate: {
            scaleX: [1, -1, 1],
            transition: { duration: 0.9 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <circle cx="12" cy="12" r="10"/>
      <m.path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" variants={meridianVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <path d="M2 12h20"/>
     </m.g>);
});
