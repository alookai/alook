"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_STAGE_DURATION_MS = 3800;

export function useTriggerFlowPlayback({
  stageCount,
  initialStage = 0,
  reducedMotion,
  stageDurationMs = DEFAULT_STAGE_DURATION_MS,
}: {
  stageCount: number;
  initialStage?: number;
  reducedMotion: boolean;
  stageDurationMs?: number;
}) {
  const lastIndex = Math.max(0, stageCount - 1);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.min(lastIndex, Math.max(0, initialStage)),
  );
  const [playing, setPlaying] = useState(false);
  const hasAutoPlayed = useRef(false);
  const hasManualInteraction = useRef(false);
  const containerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (reducedMotion || stageCount <= 1) return;
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && !hasAutoPlayed.current && !hasManualInteraction.current) {
          hasAutoPlayed.current = true;
          setPlaying(true);
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [reducedMotion, stageCount]);

  useEffect(() => {
    if (!playing || reducedMotion || stageCount <= 1) return;
    const timer = window.setTimeout(() => {
      setActiveIndex((current) => {
        if (current >= lastIndex) {
          setPlaying(false);
          return lastIndex;
        }
        return current + 1;
      });
    }, stageDurationMs);
    return () => window.clearTimeout(timer);
  }, [playing, activeIndex, lastIndex, reducedMotion, stageCount, stageDurationMs]);

  const selectStage = (index: number) => {
    hasManualInteraction.current = true;
    setPlaying(false);
    setActiveIndex(index);
  };

  const togglePlay = () => {
    hasManualInteraction.current = true;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (activeIndex >= lastIndex) {
      setActiveIndex(0);
    }
    setPlaying(true);
  };

  const replay = () => {
    hasManualInteraction.current = true;
    setActiveIndex(0);
    setPlaying(!reducedMotion);
  };

  return {
    containerRef,
    activeIndex,
    playing,
    selectStage,
    togglePlay,
    replay,
  };
}
