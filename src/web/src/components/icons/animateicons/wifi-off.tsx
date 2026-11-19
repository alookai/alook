"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const WifiOffIcon = createAnimatedIcon(["wifi-off"], function useArtwork(controls, duration) {
    const bodyVariants: Variants = {
        normal: { opacity: 1 },
        animate: {
            opacity: [1, 0.4, 1],
            transition: { duration: 0.7 * duration, ease: "easeInOut" },
        },
    };
    const slashVariants: Variants = {
        normal: { strokeDashoffset: 0 },
        animate: {
            strokeDashoffset: [32, 0],
            transition: {
                duration: 0.45 * duration,
                ease: "easeInOut",
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={bodyVariants}>
       <path d="M12 20h.01"/>
       <path d="M8.5 16.429a5 5 0 0 1 7 0"/>
       <path d="M5 12.859a10 10 0 0 1 5.17-2.69"/>
       <path d="M19 12.859a10 10 0 0 0-2.007-1.523"/>
       <path d="M2 8.82a15 15 0 0 1 4.177-2.643"/>
       <path d="M22 8.82a15 15 0 0 0-11.288-3.764"/>
      </m.g>
      <m.path d="m2 2 20 20" strokeDasharray="30 200" strokeDashoffset="0" variants={slashVariants}/>
     </m.g>);
});
