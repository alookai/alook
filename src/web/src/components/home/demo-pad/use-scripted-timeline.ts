"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface TimelineStep {
  id: string;
  duration: number; // ms to hold this step visible before advancing
}

interface UseScriptedTimelineOptions {
  steps: TimelineStep[];
  holdAfterComplete?: number; // ms to hold after all steps shown (default 4000)
  resetDuration?: number; // ms for fade-out before restart (default 300)
}

export function useScriptedTimeline({
  steps,
  holdAfterComplete = 4000,
  resetDuration = 300,
}: UseScriptedTimelineOptions) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [isResetting, setIsResetting] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    if (mq.matches) {
      setVisibleCount(steps.length);
    }
    const handler = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
      if (e.matches) {
        setVisibleCount(steps.length);
        setIsResetting(false);
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [steps.length]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isActive || reducedMotionRef.current) {
      clearTimer();
      return;
    }

    setVisibleCount(0);
    setIsResetting(false);

    function showNext(index: number) {
      if (index >= steps.length) {
        // All steps shown — hold then reset
        timerRef.current = setTimeout(() => {
          setIsResetting(true);
          timerRef.current = setTimeout(() => {
            setIsResetting(false);
            setVisibleCount(0);
            // Restart after a brief pause
            timerRef.current = setTimeout(() => showNext(0), 200);
          }, resetDuration);
        }, holdAfterComplete);
        return;
      }

      setVisibleCount(index + 1);
      timerRef.current = setTimeout(
        () => showNext(index + 1),
        steps[index].duration,
      );
    }

    // Initial delay before starting
    timerRef.current = setTimeout(() => showNext(0), 500);

    return clearTimer;
  }, [isActive, steps, holdAfterComplete, resetDuration, clearTimer]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsActive(entry.isIntersecting);
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return {
    visibleCount,
    isResetting,
    containerRef,
    isStepVisible: (index: number) => index < visibleCount,
  };
}
