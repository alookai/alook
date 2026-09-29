"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./hero-scroll-cue.module.css";

export function HeroScrollCue({ targetId }: { targetId: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let visible = false;
    const update = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return (
    <a
      ref={ref}
      href={`#${targetId}`}
      className={styles.cue}
      aria-label="Explore what’s below"
      onClick={(event) => {
        const target = document.getElementById(targetId);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
          block: "start",
        });
        target.focus({ preventScroll: true });
      }}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ animationPlayState: active ? "running" : "paused" }}>
        <path d="M12 4v16m-6-6 6 6 6-6" />
      </svg>
    </a>
  );
}
