"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const LoaderCircleIcon = createAnimatedIcon(["loader-circle", "loader-2"], function useArtwork(controls, duration) {
    const spinVariants: Variants = {
        normal: { rotate: 0, transition: { duration: 0 } },
        animate: {
            rotate: [0, 360],
            transition: { duration: 0.9 * duration, ease: "easeInOut" },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M21 12a9 9 0 1 1-6.219-8.56" variants={spinVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
     </m.g>);
});
