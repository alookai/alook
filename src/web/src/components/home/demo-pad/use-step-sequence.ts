"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseStepSequenceOptions {
  totalSteps: number;
  stepInterval?: number;
  loopPause?: number;
  resetDuration?: number;
}

interface StepSequenceState {
  currentStep: number;
  isResetting: boolean;
  showAll: boolean;
}

export function useStepSequence({
  totalSteps,
  stepInterval = 2500,
  loopPause = 5000,
  resetDuration = 200,
}: UseStepSequenceOptions) {
  const [state, setState] = useState<StepSequenceState>({
    currentStep: -1,
    isResetting: false,
    showAll: false,
  });
  const [isActive, setIsActive] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setState({ currentStep: totalSteps - 1, isResetting: false, showAll: true });
    }
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setState({ currentStep: totalSteps - 1, isResetting: false, showAll: true });
      } else {
        setState({ currentStep: -1, isResetting: false, showAll: false });
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [totalSteps]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isActive || state.showAll) {
      clearTimer();
      return;
    }

    setState({ currentStep: -1, isResetting: false, showAll: false });

    function scheduleNext(currentStep: number) {
      timerRef.current = setTimeout(() => {
        const nextStep = currentStep + 1;
        if (nextStep >= totalSteps) {
          timerRef.current = setTimeout(() => {
            setState((s) => ({ ...s, isResetting: true }));
            timerRef.current = setTimeout(() => {
              setState((s) => ({ ...s, currentStep: -1, isResetting: false }));
              scheduleNext(-1);
            }, resetDuration);
          }, loopPause);
          return;
        }
        setState((s) => ({ ...s, currentStep: nextStep }));
        scheduleNext(nextStep);
      }, stepInterval);
    }

    scheduleNext(-1);

    return clearTimer;
  }, [isActive, state.showAll, totalSteps, stepInterval, loopPause, resetDuration, clearTimer]);

  const activate = useCallback(() => setIsActive(true), []);
  const deactivate = useCallback(() => {
    setIsActive(false);
  }, []);

  return {
    currentStep: state.currentStep,
    isResetting: state.isResetting,
    activate,
    deactivate,
    showAll: state.showAll,
  };
}
