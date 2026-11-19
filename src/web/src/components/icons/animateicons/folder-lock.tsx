"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const FolderLockIcon = createAnimatedIcon(["folder-lock"], function useArtwork(controls, duration) {
    const folderVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -1.2, 0.4, 0],
            transition: {
                duration: 0.6 * duration,
                ease: "easeInOut",
                times: [0, 0.35, 0.7, 1],
            },
        },
    };
    const shackleVariants: Variants = {
        normal: { y: 0 },
        animate: {
            y: [0, -2, 0.5, 0],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.72, 1],
                delay: 0.1 * duration,
            },
        },
    };
    const bodyVariants: Variants = {
        normal: { scaleY: 1 },
        animate: {
            scaleY: [1, 1, 0.88, 1],
            transition: {
                duration: 0.7 * duration,
                ease: "easeInOut",
                times: [0, 0.45, 0.72, 1],
                delay: 0.1 * duration,
            },
        },
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.path d="M10 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2.5" variants={folderVariants}/>
      <m.path d="M20 17v-2a2 2 0 1 0-4 0v2" variants={shackleVariants}/>
      <m.rect width="8" height="5" x="14" y="17" rx="1" variants={bodyVariants} style={{ transformBox: "view-box", originX: "18px", originY: "22px" }}/>
     </m.g>);
});
