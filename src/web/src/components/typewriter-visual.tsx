"use client";

import { useRef, useCallback } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { TypewriterCityArt } from "./typewriter-city-art";

const KEY_ROWS = [9, 7, 9];

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
  paper?: React.ReactNode;
  blobScale?: number;
  blobBottom?: string;
}

export function TypewriterVisual({
  className,
  entranceDelay = 0.3,
  paper,
  blobScale = 1,
  blobBottom,
}: TypewriterVisualProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const el = containerRef.current;
      if (!el) return;
      const scene = el.querySelector<HTMLElement>(".typewriter-scene");
      if (!scene) return;
      const rect = el.getBoundingClientRect();
      const nx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const ny = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      scene.style.transition = "transform 0.12s ease-out";
      scene.style.transform = `rotateY(${-20 + nx * 15}deg) rotateX(${10 + ny * -10}deg)`;
    },
    []
  );

  const handleMouseLeave = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const scene = el.querySelector<HTMLElement>(".typewriter-scene");
    if (!scene) return;
    scene.style.transition = "transform 0.8s cubic-bezier(0.2, 0.8, 0.2, 1)";
    scene.style.transform = "";
  }, []);

  useGSAP(() => {
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

            <div className="tw-body-front">
              <div className="tw-paper-track">
                <div className="tw-paper">
                  {paper ?? <TypewriterCityArt />}
                </div>
              </div>
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
