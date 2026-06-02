"use client";

import { useEffect, type RefObject } from "react";

export interface KeyboardScrollController {
  handler: () => void;
  cleanup: () => void;
}

/**
 * Creates a resize handler that calculates the keyboard offset from the visual
 * viewport and applies a CSS variable to the target element so its parent
 * container can shift above the keyboard.
 * Exported for testability — the hook wraps this with lifecycle management.
 */
export function createKeyboardScrollController(
  getTarget: () => HTMLElement | null,
  isFocused: boolean,
): KeyboardScrollController {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const handler = () => {
    if (!isFocused) return;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      const el = getTarget();
      if (!el) return;
      const vv = window.visualViewport;
      if (!vv) {
        el.scrollIntoView({ block: "end", behavior: "smooth" });
        return;
      }
      const offset = window.innerHeight - vv.height - vv.offsetTop;
      const inputContainer = el.closest(
        "[data-keyboard-offset]",
      ) as HTMLElement | null;
      if (inputContainer) {
        inputContainer.style.transform =
          offset > 0 ? `translateY(-${offset}px)` : "";
      } else {
        el.scrollIntoView({ block: "end", behavior: "smooth" });
      }
    }, 100);
  };
  const cleanup = () => {
    clearTimeout(timeoutId);
    const el = getTarget();
    if (!el) return;
    const inputContainer = el.closest(
      "[data-keyboard-offset]",
    ) as HTMLElement | null;
    if (inputContainer) {
      inputContainer.style.transform = "";
    }
  };
  return { handler, cleanup };
}

/**
 * Subscribes to visualViewport resize and scroll events. On iOS Safari the
 * virtual keyboard shrinks the visual viewport without reflowing the layout,
 * so fixed/sticky elements at the bottom can be hidden behind the keyboard.
 * This handler applies a translateY offset to move the input above the keyboard.
 *
 * Returns null if visualViewport is unavailable (SSR or unsupported browser).
 * Exported for testability without React rendering.
 */
export function attachKeyboardScroll(
  getTarget: () => HTMLElement | null,
  isFocused: boolean,
): (() => void) | null {
  const vv =
    typeof window !== "undefined" ? window.visualViewport : undefined;
  if (!vv) return null;
  const { handler, cleanup } = createKeyboardScrollController(
    getTarget,
    isFocused,
  );
  vv.addEventListener("resize", handler);
  vv.addEventListener("scroll", handler);
  return () => {
    vv.removeEventListener("resize", handler);
    vv.removeEventListener("scroll", handler);
    cleanup();
  };
}

/**
 * On iOS Safari, the virtual keyboard can push the focused input off-screen
 * because the layout viewport doesn't always resize in sync with the visual
 * viewport. This hook listens to `window.visualViewport` resize events and
 * applies a translateY offset to the nearest [data-keyboard-offset] ancestor.
 *
 * No-op when `visualViewport` is unavailable or the editor isn't focused.
 */
export function useKeyboardScroll(
  targetRef: RefObject<HTMLElement | null>,
  isFocused: boolean,
) {
  useEffect(() => {
    const detach = attachKeyboardScroll(() => targetRef.current, isFocused);
    return detach ?? undefined;
  }, [targetRef, isFocused]);
}
