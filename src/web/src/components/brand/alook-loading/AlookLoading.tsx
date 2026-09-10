"use client";
import { useEffect, useRef, useState } from "react";
import { LoadingFrame } from "./LoadingFrame";
import { DURATION } from "./motion";
export type AlookLoadingProps = {
  size?: number;
  paused?: boolean;
  label?: string;
  className?: string;
};
export const AlookLoading = ({
  size = 96,
  paused = false,
  label = "Loading",
  className,
}: AlookLoadingProps) => {
  const element = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(0);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let last: number | undefined;
    let request = 0;
    const tick = (now: number) => {
      if (last !== undefined) elapsed.current += now - last;
      last = now;
      setFrame(Math.floor((elapsed.current * 60) / 1000) % DURATION);
      request = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(request);
      last = undefined;
      if (media.matches) setFrame(180);
      else if (!paused && visible && !document.hidden)
        request = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    if (element.current) observer.observe(element.current);
    media.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      media.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [paused]);
  return (
    <span
      ref={element}
      role="status"
      aria-label={label}
      className={className}
      style={{
        display: "inline-block",
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "block",
          position: "absolute",
          width: 1080,
          height: 1080,
          transform: `scale(${size / 1080})`,
          transformOrigin: "top left",
        }}
      >
        <LoadingFrame frame={frame} />
      </span>
    </span>
  );
};
