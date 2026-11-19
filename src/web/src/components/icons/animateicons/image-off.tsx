"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const ImageOffIcon = createAnimatedIcon(["image-off"], function useArtwork(controls, duration) {
    const bodyVariants: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.4, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
            },
        },
    };
    const slashVariants: Variants = {
        normal: { strokeDashoffset: 0 },
        animate: {
            strokeDashoffset: [29, 0],
            transition: {
                duration: 0.45 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={bodyVariants}>
       <path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/>
       <line x1="13.5" x2="6" y1="13.5" y2="21"/>
       <line x1="18" x2="21" y1="12" y2="15"/>
       <path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/>
       <path d="M21 15V5a2 2 0 0 0-2-2H9"/>
      </m.g>
      <m.line x1="2" x2="22" y1="2" y2="22" strokeDasharray="29" strokeDashoffset="0" variants={slashVariants}/>
     </m.g>);
});
