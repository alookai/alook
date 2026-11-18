"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const PaletteIcon = createAnimatedIcon(["palette"], function useArtwork(controls, duration) {
    const paletteVariants: Variants = {
        normal: { rotate: 0 },
        animate: {
            rotate: [0, -10, 8, -4, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    const dotVariants: Variants = {
        normal: { scale: 1 },
        animate: (i: number) => ({
            scale: [1, 0, 1.8, 1],
            transition: {
                duration: 0.4 * duration,
                ease: "easeOut",
                times: [0, 0.2, 0.6, 1],
                delay: i * 0.08 * duration,
            },
        }),
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={paletteVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}>
       <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/>
       <m.circle cx="6.5" cy="12.5" r=".5" fill="currentColor" variants={dotVariants} custom={0} style={{
            transformBox: "view-box",
            originX: "6.5px",
            originY: "12.5px",
        }}/>
       <m.circle cx="8.5" cy="7.5" r=".5" fill="currentColor" variants={dotVariants} custom={1} style={{ transformBox: "view-box", originX: "8.5px", originY: "7.5px" }}/>
       <m.circle cx="13.5" cy="6.5" r=".5" fill="currentColor" variants={dotVariants} custom={2} style={{
            transformBox: "view-box",
            originX: "13.5px",
            originY: "6.5px",
        }}/>
       <m.circle cx="17.5" cy="10.5" r=".5" fill="currentColor" variants={dotVariants} custom={3} style={{
            transformBox: "view-box",
            originX: "17.5px",
            originY: "10.5px",
        }}/>
      </m.g>
     </m.g>);
});
