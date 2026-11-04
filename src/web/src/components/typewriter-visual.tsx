"use client";

import { useCallback, useEffect, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { TypewriterCityArt } from "./typewriter-city-art";

const KEY_ROWS = [9, 7, 9];
// rest angle of .typewriter-scene in globals.css
const REST_RX = -10;
const REST_RY = -20;

const TW_VARS: React.CSSProperties = {
  "--tw-body": "oklch(0.25 0.01 60)",
  "--tw-body-hi": "oklch(0.30 0.01 60)",
  "--tw-body-lo": "oklch(0.18 0.01 55)",
  "--tw-body-top": "oklch(0.28 0.01 60)",
  "--tw-chrome": "oklch(0.72 0.01 75)",
  "--tw-chrome-hi": "oklch(0.82 0.005 80)",
  "--tw-paper": "oklch(0.97 0.008 80)",
  "--tw-blob": "var(--tw-blob-theme, oklch(0.88 0.025 82))",
  "--tw-roller": "oklch(0.15 0.01 55)",
} as React.CSSProperties;

interface TypewriterVisualProps {
  className?: string;
  entranceDelay?: number;
  animateEntrance?: boolean;
  paper?: React.ReactNode;
  blobScale?: number;
  blobBottom?: string;
  onPaperSettled?: () => void;
}

export function TypewriterVisual({
  className,
  entranceDelay = 0.3,
  animateEntrance = true,
  paper,
  blobScale = 1,
  blobBottom,
  onPaperSettled,
}: TypewriterVisualProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Pointer tilt with the same damped follow as the sign-in typewriter: the pointer only sets a target and a
  // frame loop eases the pose toward it (time constant ~100 ms), so fast or jittery input never makes it shake.
  const poseRef = useRef({ rx: REST_RX, ry: REST_RY });
  const targetRef = useRef({ rx: REST_RX, ry: REST_RY });
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);

  const tick = useCallback(function step(timestamp: number) {
    const scene = containerRef.current?.querySelector<HTMLElement>(".typewriter-scene");
    const pose = poseRef.current, target = targetRef.current;
    const elapsed = lastFrameRef.current === null ? 1000 / 60 : Math.min(32, Math.max(0, timestamp - lastFrameRef.current));
    lastFrameRef.current = timestamp;
    const blend = 1 - Math.exp(-elapsed / 100);
    let moving = false;
    for (const key of ["rx", "ry"] as const) {
      pose[key] += (target[key] - pose[key]) * blend;
      if (Math.abs(target[key] - pose[key]) < 0.01) pose[key] = target[key];
      else moving = true;
    }
    if (scene) {
      scene.style.transition = "none";
      const atRest = pose.rx === REST_RX && pose.ry === REST_RY && target.rx === REST_RX && target.ry === REST_RY;
      scene.style.transform = atRest ? "" : `rotateY(${pose.ry.toFixed(2)}deg) rotateX(${pose.rx.toFixed(2)}deg)`;
    }
    if (moving) rafRef.current = window.requestAnimationFrame(step);
    else { rafRef.current = null; lastFrameRef.current = null; }
  }, []);

  const schedule = useCallback(() => {
    if (rafRef.current === null) rafRef.current = window.requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => { if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current); }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const el = containerRef.current;
      if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const rect = el.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)));
      const ny = Math.max(-1, Math.min(1, (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)));
      targetRef.current = { rx: REST_RX + ny * -10, ry: REST_RY + nx * 15 };
      schedule();
    },
    [schedule]
  );

  const handleMouseLeave = useCallback(() => {
    targetRef.current = { rx: REST_RX, ry: REST_RY };
    schedule();
  }, [schedule]);

  useGSAP(() => {
    if (!animateEntrance) return;
    const paperEl = containerRef.current?.querySelector<HTMLElement>(".tw-paper");
    if (!paperEl) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.set(paperEl, { y: 0, opacity: 1 });
      return;
    }
    gsap.fromTo(paperEl,
      { y: paperEl.offsetHeight, opacity: 1 },
      { y: 0, duration: 3, delay: entranceDelay, ease: "power1.out" },
    );
  }, { scope: containerRef });

  const paperTrack = (
    <div className="tw-paper-track">
      <div className={`tw-paper${paper == null ? " tw-paper-city" : ""}`} style={animateEntrance ? undefined : { opacity: 1 }}>
        {paper ?? <TypewriterCityArt onSettled={onPaperSettled} />}
      </div>
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`typewriter-visual${className ? ` ${className}` : ""}`}
      style={TW_VARS}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div className="typewriter-blob" style={(blobScale !== 1 || blobBottom) ? { "--blob-scale": blobScale, ...(blobBottom ? { "--blob-bottom": blobBottom } : {}) } as React.CSSProperties : undefined} />

      <div className="typewriter-scene">
        <div className="tw-machine">
          <div className="tw-body">
            <div className="tw-body-back" />
            <div className="tw-body-left" />
            <div className="tw-body-right" />
            <div className="tw-body-top" />
            <div className="tw-body-bottom" />
            <div className="tw-body-edge tw-body-edge-tl" />
            <div className="tw-body-edge tw-body-edge-tr" />
            <div className="tw-body-edge tw-body-edge-bl" />
            <div className="tw-body-edge tw-body-edge-br" />

            {!animateEntrance && paperTrack}
            <div className="tw-body-front">
              {animateEntrance && paperTrack}
              <div className="tw-roller-assembly">
                <div className="tw-knob tw-knob-left" />
                <div className="tw-roller" />
                <div className="tw-knob tw-knob-right" />
              </div>
              <div className="tw-typebar-fan" />
              <div className="tw-keys-layer">
                {KEY_ROWS.map((count, ri) => (
                  <div key={ri} className="tw-key-row">
                    {Array.from({ length: count }, (_, ki) => <div key={ki} className="tw-key" />)}
                    {ri === 1 && (
                      <div className="tw-key tw-return-key" aria-hidden="true">
                        <span className="tw-return-label">{"\u21B5"}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="tw-bars">
                <div className="tw-bar tw-bar-long" />
                <div className="tw-bar tw-bar-short" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
