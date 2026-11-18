"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const NetworkIcon = createAnimatedIcon(["network"], function useArtwork(controls, duration) {
    const nodeVariants = (delay: number, size: number): Variants => ({
        normal: { scale: 1 },
        animate: {
            scale: [1, size, 0.96, 1],
            transition: {
                duration: 0.4 * duration,
                ease: "easeInOut",
                times: [0, 0.4, 0.75, 1],
                delay: delay * duration,
            },
        },
    });
    const stemVariants: Variants = {
        normal: { strokeDashoffset: 0, opacity: 1 },
        animate: {
            strokeDashoffset: [-5, 0],
            opacity: [0, 1],
            transition: {
                strokeDashoffset: {
                    duration: 0.25 * duration,
                    ease: "easeOut",
                    delay: 0.1 * duration,
                },
                opacity: { duration: 0.25 * duration, delay: 0.1 * duration },
            },
        },
    };
    const branchVariants: Variants = {
        normal: { scaleX: 1, opacity: 1 },
        animate: {
            scaleX: [0, 1],
            opacity: [0, 1],
            transition: {
                scaleX: {
                    duration: 0.3 * duration,
                    ease: "easeOut",
                    delay: 0.3 * duration,
                },
                opacity: { duration: 0.25 * duration, delay: 0.3 * duration },
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.rect x="16" y="16" width="6" height="6" rx="1" variants={nodeVariants(0.55, 1.2)} style={{ transformBox: "view-box", originX: "19px", originY: "19px" }}/>
      <m.rect x="2" y="16" width="6" height="6" rx="1" variants={nodeVariants(0.55, 1.2)} style={{ transformBox: "view-box", originX: "5px", originY: "19px" }}/>
      <m.rect x="9" y="2" width="6" height="6" rx="1" variants={nodeVariants(0, 1.2)} style={{ transformBox: "view-box", originX: "12px", originY: "5px" }}/>
      <m.path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" variants={branchVariants} style={{ transformBox: "view-box", originX: "12px", originY: "12px" }}/>
      <m.path d="M12 12V8" strokeDasharray="5" strokeDashoffset="0" variants={stemVariants}/>
     </m.g>);
});
