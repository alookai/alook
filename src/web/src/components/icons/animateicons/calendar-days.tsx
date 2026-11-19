"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const CalendarDaysIcon = createAnimatedIcon(["calendar-days"], function useArtwork(controls, duration) {
    const ringVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, 1.6, -0.3, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
            },
        },
    };
    const dayVariants: Variants = {
        normal: { scale: 1 },
        animate: (i: number) => ({
            scale: [1, 1.7, 1],
            transition: {
                duration: 0.45 * duration,
                ease: "easeInOut",
                delay: (0.1 + i * 0.07) * duration,
            },
        }),
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M8 2v3" variants={ringVariants}/>
      <m.path d="M16 2v3" variants={ringVariants}/>
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18"/>
      <m.path d="M8 13h.01" custom={0} variants={dayVariants} style={{ transformBox: "view-box", originX: "8px", originY: "13px" }}/>
      <m.path d="M12 13h.01" custom={1} variants={dayVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}/>
      <m.path d="M16 13h.01" custom={2} variants={dayVariants} style={{ transformBox: "view-box", originX: "16px", originY: "13px" }}/>
      <m.path d="M8 17h.01" custom={3} variants={dayVariants} style={{ transformBox: "view-box", originX: "8px", originY: "17px" }}/>
      <m.path d="M12 17h.01" custom={4} variants={dayVariants} style={{ transformBox: "view-box", originX: "12px", originY: "17px" }}/>
      <m.path d="M16 17h.01" custom={5} variants={dayVariants} style={{ transformBox: "view-box", originX: "16px", originY: "17px" }}/>
     </m.g>);
});
