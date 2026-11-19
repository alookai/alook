"use client";
import type { Variants } from "motion/react";
import { m } from "motion/react";
import { createAnimatedIcon } from "../animated-icon";
export const BugIcon = createAnimatedIcon(["bug"], function useArtwork(controls, duration) {
    const bodyVariants: Variants = {
        normal: { rotate: 0, y: 0 },
        animate: {
            rotate: [0, -6, 6, -4, 0],
            y: [0, -0.8, 0, -0.8, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        },
    };
    const legVariants: Variants = {
        normal: { rotate: 0 },
        animate: (dir: number) => ({
            rotate: [0, 16 * dir, -12 * dir, 10 * dir, -6 * dir, 0],
            transition: { duration: 0.8 * duration, ease: "easeInOut" },
        }),
    };
    return (<m.g animate={controls} initial="normal" style={{ transformBox: "view-box", transformOrigin: "12px 12px" }}>
      <m.g variants={bodyVariants} style={{ transformBox: "view-box", originX: "12px", originY: "13px" }}>
       <path d="M12 20v-9"/>
       <path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/>
       <path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>
       <m.path d="M14.12 3.88 16 2" variants={legVariants} custom={-1} style={{
            transformBox: "view-box",
            originX: "14.12px",
            originY: "3.88px",
        }}/>
       <m.path d="m8 2 1.88 1.88" variants={legVariants} custom={1} style={{
            transformBox: "view-box",
            originX: "9.88px",
            originY: "3.88px",
        }}/>
       <m.path d="M3 5a4 4 0 0 0 3.55 3.97" variants={legVariants} custom={1} style={{
            transformBox: "view-box",
            originX: "6.55px",
            originY: "8.97px",
        }}/>
       <m.path d="M6 13H2" variants={legVariants} custom={-1} style={{ transformBox: "view-box", originX: "6px", originY: "13px" }}/>
       <m.path d="M3 21a4 4 0 0 1 3.81-4" variants={legVariants} custom={1} style={{ transformBox: "view-box", originX: "6.81px", originY: "17px" }}/>
       <m.path d="M21 5a4 4 0 0 1-3.55 3.97" variants={legVariants} custom={-1} style={{
            transformBox: "view-box",
            originX: "17.45px",
            originY: "8.97px",
        }}/>
       <m.path d="M22 13h-4" variants={legVariants} custom={1} style={{ transformBox: "view-box", originX: "18px", originY: "13px" }}/>
       <m.path d="M21 21a4 4 0 0 0-3.81-4" variants={legVariants} custom={-1} style={{
            transformBox: "view-box",
            originX: "17.19px",
            originY: "17px",
        }}/>
      </m.g>
     </m.g>);
});
