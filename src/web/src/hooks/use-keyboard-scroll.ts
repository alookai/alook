"use client";

import { useEffect, type RefObject } from "react";

export interface KeyboardScrollController {
  handler: () => void;
  cleanup: () => void;
}

const DEBOUNCE_MS = 150;

/**
 * Creates a resize handler that calculates the keyboard offset from the visual
 * viewport and applies a translateY to shift the input container above the keyboard.
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
      const keyboardHeight = window.innerHeight - vv.height;
      const inputContainer = el.closest(
        "[data-keyboard-offset]",
      ) as HTMLElement | null;
      if (inputContainer && keyboardHeight > 0) {
        // Calculate how much of the container is hidden behind the keyboard.
        // Only shift enough to keep it visible, not the full keyboard height.
        const rect = inputContainer.getBoundingClientRect();
        const overflow = rect.bottom - vv.height - vv.offsetTop;
        if (overflow > 0) {
          inputContainer.style.transform = `translateY(-${overflow}px)`;
          inputContainer.setAttribute("data-keyboard-active", "");
        } else {
          inputContainer.style.transform = "";
          inputContainer.removeAttribute("data-keyboard-active");
        }
      } else if (inputContainer) {
        inputContainer.style.transform = "";
        inputContainer.removeAttribute("data-keyboard-active");
      } else {
        el.scrollIntoView({ block: "end", behavior: "smooth" });
      }
    }, DEBOUNCE_MS);
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
      inputContainer.removeAttribute("data-keyboard-active");
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
 * On Chromium (Android Chrome 94+), uses the VirtualKeyboard API with CSS
 * env(keyboard-inset-height) for a smoother native experience.
 * Falls back to visualViewport + translateY for iOS Safari/Chrome.
 */
function attachVirtualKeyboardAPI(
  getTarget: () => HTMLElement | null,
  isFocused: boolean,
): (() => void) | null {
  if (typeof window === "undefined") return null;
  const vk = (navigator as any).virtualKeyboard;
  if (!vk) return null;

  vk.overlaysContent = true;

  const inputContainer = getTarget()?.closest(
    "[data-keyboard-offset]",
  ) as HTMLElement | null;
  if (!inputContainer) return null;

  const onGeometryChange = () => {
    if (!isFocused) {
      inputContainer.style.transform = "";
      inputContainer.removeAttribute("data-keyboard-active");
      return;
    }
    const { height } = vk.boundingRect;
    if (height > 0) {
      inputContainer.style.transform = `translateY(-${height}px)`;
      inputContainer.setAttribute("data-keyboard-active", "");
    } else {
      inputContainer.style.transform = "";
      inputContainer.removeAttribute("data-keyboard-active");
    }
  };

  vk.addEventListener("geometrychange", onGeometryChange);
  return () => {
    vk.removeEventListener("geometrychange", onGeometryChange);
    inputContainer.style.transform = "";
    inputContainer.removeAttribute("data-keyboard-active");
    vk.overlaysContent = false;
  };
}

/**
 * On iOS Safari, the virtual keyboard can push the focused input off-screen
 * because the layout viewport doesn't always resize in sync with the visual
 * viewport. This hook listens to `window.visualViewport` resize events and
 * applies a translateY offset to the nearest [data-keyboard-offset] ancestor.
 *
 * On Android Chrome 94+, uses VirtualKeyboard API for smoother handling.
 * No-op when `visualViewport` is unavailable or the editor isn't focused.
 */
export function useKeyboardScroll(
  targetRef: RefObject<HTMLElement | null>,
  isFocused: boolean,
) {
  useEffect(() => {
    // Try VirtualKeyboard API first (Android Chrome 94+)
    const vkDetach = attachVirtualKeyboardAPI(
      () => targetRef.current,
      isFocused,
    );
    if (vkDetach) return vkDetach;

    // Fallback: visualViewport resize (iOS Safari/Chrome)
    const detach = attachKeyboardScroll(() => targetRef.current, isFocused);
    return detach ?? undefined;
  }, [targetRef, isFocused]);
}
