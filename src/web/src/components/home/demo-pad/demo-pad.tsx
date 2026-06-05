"use client";

import { useEffect, useRef } from "react";
import { useStepSequence } from "./use-step-sequence";
import { AnimatedStep } from "./animated-step";

interface DemoPadProps {
  totalSteps: number;
  stepInterval?: number;
  loopPause?: number;
  children: (props: {
    currentStep: number;
    isResetting: boolean;
    showAll: boolean;
    Step: typeof AnimatedStep;
  }) => React.ReactNode;
}

export function DemoPad({
  totalSteps,
  stepInterval = 2500,
  loopPause = 5000,
  children,
}: DemoPadProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { currentStep, isResetting, showAll, activate, deactivate } =
    useStepSequence({ totalSteps, stepInterval, loopPause });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          activate();
        } else {
          deactivate();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [activate, deactivate]);

  return (
    <div ref={containerRef}>
      {children({ currentStep, isResetting, showAll, Step: AnimatedStep })}
    </div>
  );
}
