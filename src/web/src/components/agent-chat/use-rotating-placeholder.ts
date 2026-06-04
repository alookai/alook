"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Rotating capability hints for the main chat composer's empty-state
 * placeholder. Each maps to a REAL Alook capability — the placeholder teaches
 * by example. Copy LOCKED by Gus 2026-06-01 (natural-imperative voice).
 *
 * This is the ONE place to edit the copy. Keep every entry ≤ ~45 chars so the
 * overlay never wraps / truncates at the smallest mobile width.
 */
export const CHAT_PLACEHOLDER_HINTS = [
  "Email the team this week's launch update",
  "Recruit a QA agent to review my PRs",
  "Remind me to follow up with Acme on Thursday",
  "What did we ship last week?",
  "Fix the failing test in the checkout flow",
] as const;

/** Hold each hint ~6s before cross-fading to the next. */
export const HINT_HOLD_MS = 6000;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Random start index in [0, len). Kept pure + exported so the "random start"
 * behavior is unit-testable without rendering the hook (web suite is node-env,
 * no jsdom/RTL). Pass a custom `rand` (defaulting to Math.random) in tests.
 */
export function randomStartIndex(
  len: number,
  rand: () => number = Math.random,
): number {
  if (len <= 0) return 0;
  return Math.floor(rand() * len) % len;
}

/** Next index in a sequential cycle, wrapping to 0 after the last. */
export function nextIndex(current: number, len: number): number {
  if (len <= 0) return 0;
  return (current + 1) % len;
}

/**
 * The placeholder rotates ONLY when the field is empty, unfocused, not in a
 * task-in-progress state, and reduced-motion is not requested. Pure predicate,
 * exported for direct unit testing.
 */
export function shouldRotate(state: {
  isEmpty: boolean;
  isFocused: boolean;
  isTaskActive: boolean;
  reducedMotion: boolean;
}): boolean {
  return (
    state.isEmpty &&
    !state.isFocused &&
    !state.isTaskActive &&
    !state.reducedMotion
  );
}

/**
 * Reads + subscribes to `prefers-reduced-motion`. Inlines the same matchMedia
 * convention used elsewhere in the codebase (home/feature-showcase.tsx) rather
 * than adding a shared hook. SSR-safe (defaults to false when no window).
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface RotatingPlaceholderState {
  isEmpty: boolean;
  isFocused: boolean;
  isTaskActive: boolean;
}

export interface RotatingPlaceholder {
  /** The hint to show right now. */
  hint: string;
  /** True while the placeholder should actively cross-fade between hints. */
  isRotating: boolean;
}

/**
 * Owns the rotating-placeholder state: a random start index, a sequential
 * ~3.5s cycle, freeze-on-focus/typing, resume-on-empty-blur, and the
 * reduced-motion short-circuit (one static hint, never advances).
 *
 * NO TipTap / DOM dependency beyond matchMedia — the overlay rendering and
 * cross-fade live in chat-composer.tsx.
 */
export function useRotatingPlaceholder(
  state: RotatingPlaceholderState,
): RotatingPlaceholder {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(() =>
    randomStartIndex(CHAT_PLACEHOLDER_HINTS.length),
  );

  const rotating = shouldRotate({ ...state, reducedMotion });

  // Advance on a fixed interval only while rotating. Re-arming on `rotating`
  // change means focus/typing freezes immediately and empty-blur resumes.
  // The latest index is read from a ref so the effect doesn't re-run (and
  // reset the timer) on every advance.
  const indexRef = useRef(index);
  indexRef.current = index; // eslint-disable-line react-hooks/refs -- sync ref to avoid stale closure in interval

  useEffect(() => {
    if (!rotating) return;
    const id = setInterval(() => {
      setIndex(nextIndex(indexRef.current, CHAT_PLACEHOLDER_HINTS.length));
    }, HINT_HOLD_MS);
    return () => clearInterval(id);
  }, [rotating]);

  return {
    hint: CHAT_PLACEHOLDER_HINTS[index] ?? CHAT_PLACEHOLDER_HINTS[0],
    isRotating: rotating,
  };
}
