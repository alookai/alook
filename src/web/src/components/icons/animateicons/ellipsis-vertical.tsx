"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const EllipsisVerticalIcon = createAnimatedIcon(["ellipsis-vertical", "more-vertical"], function useArtwork(controls, duration) {
    const dotVariants: Variants = {
        normal: { x: 0 },
        animate: (i: number) => ({
            x: [0, -3, 0],
            transition: {
                duration: 0.55 * duration,
                delay: i * 0.12 * duration,
                ease: "easeInOut",
            },
        }),
    };
    return (<m.g initial="normal" animate={controls} style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.circle cx="12" cy="5" r="1" variants={dotVariants} custom={0}/>
      <m.circle cx="12" cy="12" r="1" variants={dotVariants} custom={1}/>
      <m.circle cx="12" cy="19" r="1" variants={dotVariants} custom={2}/>
     </m.g>);
});
