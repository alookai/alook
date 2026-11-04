"use client";

import { useCallback, useEffect, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { TypewriterCityArt } from "./typewriter-city-art";

const KEY_ROWS = [9, 7, 9];
// rest angle of .typewriter-scene in globals.css
const REST_RX = 10;
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
} as React.CSSProperties;

// Body box: 420 × 260 × 160 px with a 24 px corner radius. Each depth edge is a quarter cylinder built from
// EDGE_SEGMENTS flat strips; a strip's lightness blends between the two faces it joins.
// The body is a wedge: BODY_D deep at the base and SLOPE px shallower at the top deck, matching the keyboard
// face's lean in globals.css (.tw-body-front, .tw-body-left/right clip paths).
const BODY_W = 420, BODY_H = 260, BODY_D = 160, SLOPE = 60, RADIUS = 24, EDGE_SEGMENTS = 6;
// Face lightness by outward normal angle, clockwise from straight up: top, right, bottom, left.
const FACE_L = [0.28, 0.18, 0.14, 0.22];
const EDGE_CENTERS = [[BODY_W - RADIUS, RADIUS], [BODY_W - RADIUS, BODY_H - RADIUS], [RADIUS, BODY_H - RADIUS], [RADIUS, RADIUS]];
const STRIP_W = 2 * RADIUS * Math.sin(Math.PI / 4 / EDGE_SEGMENTS) + 1; // chord plus 1 px overlap against seams
const EDGE_STRIPS: React.CSSProperties[] = EDGE_CENTERS.flatMap(([cx, cy], corner) =>
  Array.from({ length: EDGE_SEGMENTS }, (_, k) => {
    const t = (k + 0.5) / EDGE_SEGMENTS;
    const angle = (corner + t) * 90;
    const rad = (angle * Math.PI) / 180;
    const x = cx + RADIUS * Math.sin(rad), y = cy - RADIUS * Math.cos(rad);
    const lightness = FACE_L[corner] + (FACE_L[(corner + 1) % 4] - FACE_L[corner]) * t;
    // From the back plane to the slanted front at this height, plus 1 px tucked behind the front face.
    const depth = BODY_D - SLOPE * (1 - y / BODY_H) + 1;
    const z = (depth - BODY_D) / 2;
    return {
      width: `${STRIP_W.toFixed(2)}px`,
      height: `${depth.toFixed(2)}px`,
      background: `oklch(${lightness.toFixed(3)} 0.01 57)`,
      transform: `translate3d(${(x - STRIP_W / 2).toFixed(2)}px, ${(y - depth / 2).toFixed(2)}px, ${z.toFixed(2)}px) rotateZ(${angle}deg) rotateX(90deg)`,
    };
  }),
);

// Platen and knobs are real cylinders along the x axis, built from shaded strips (light from top-front).
// Axis sits on the top deck (see .tw-roller-assembly); x is measured on the 420 px body.
function cylinderStrips(x0: number, length: number, radius: number, segments: number, base: number, gain: number, ribbed = false): React.CSSProperties[] {
  const stripH = 2 * radius * Math.sin(Math.PI / segments) + 2; // overlap hides anti-aliased seams
  const endOverlap = 0.6; // Intersect the end caps so their joint cannot show the background.
  return Array.from({ length: segments }, (_, k) => {
    const angle = (k * 360) / segments;
    const rad = (angle * Math.PI) / 180;
    const lit = Math.max(0, 0.65 * Math.sin(rad) + 0.35 * Math.cos(rad));
    const lightness = base + gain * lit ** 1.4 + (ribbed && k % 2 ? -0.025 : 0);
    return {
      left: `${x0 - endOverlap}px`,
      top: `${(-stripH / 2).toFixed(2)}px`,
      width: `${length + 2 * endOverlap}px`,
      height: `${stripH.toFixed(2)}px`,
      background: `oklch(${lightness.toFixed(3)} 0.008 60)`,
      transform: `rotateX(${angle}deg) translateZ(${radius}px)`,
    };
  });
}
const PLATEN_R = 13, KNOB_R = 19, KNOB_W = 18, PLATEN_X0 = 4, PLATEN_X1 = BODY_W - 4;
const ROLLER_STRIPS = [
  ...cylinderStrips(PLATEN_X0, PLATEN_X1 - PLATEN_X0, PLATEN_R, 16, 0.11, 0.32),
  ...cylinderStrips(PLATEN_X0 - KNOB_W, KNOB_W, KNOB_R, 24, 0.15, 0.24, true),
  ...cylinderStrips(PLATEN_X1, KNOB_W, KNOB_R, 24, 0.15, 0.24, true),
];
// Knob end caps: [x, facing +x?]
// Caps are a hair larger than the 24-sided band so its flat strips never leave a light crescent at the rim.
const KNOB_CAP_R = KNOB_R + 0.8;
const KNOB_CAPS: [number, boolean][] = [[PLATEN_X0 - KNOB_W, false], [PLATEN_X0, true], [PLATEN_X1, false], [PLATEN_X1 + KNOB_W, true]];

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
          <div className="tw-floor-shadow" aria-hidden="true" />
          <div className="tw-body">
            <div className="tw-body-back" />
            <div className="tw-body-left" />
            <div className="tw-body-right" />
            <div className="tw-body-top" />
            <div className="tw-body-bottom" />
            {EDGE_STRIPS.map((style, i) => <div key={i} className="tw-body-edge" style={style} />)}

            {paperTrack}
            <div className="tw-paper-guide" aria-hidden="true" />
            <div className="tw-roller-assembly" aria-hidden="true">
              {ROLLER_STRIPS.map((style, i) => <div key={i} className="tw-roller-strip" style={style} />)}
              {KNOB_CAPS.map(([x, outward], i) => (
                <div
                  key={`cap-${i}`}
                  className="tw-knob-cap"
                  style={{ left: `${x - KNOB_CAP_R}px`, top: `${-KNOB_CAP_R}px`, width: `${2 * KNOB_CAP_R}px`, height: `${2 * KNOB_CAP_R}px`, transform: `rotateY(${outward ? 90 : -90}deg)` }}
                />
              ))}
            </div>
            <div className="tw-body-front">
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
