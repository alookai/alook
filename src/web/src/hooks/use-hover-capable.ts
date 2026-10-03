import { useAtom, useCreateAtom } from "@tanstack/react-store";
import * as React from "react";

// True when the primary input is a precise pointer that can hover (mouse /
// trackpad), false on touch / coarse pointers. Used to pick the per-message
// action affordance: hover-reveal toolbar on hover-capable devices, long-press
// action sheet on touch — keyed off INPUT CAPABILITY, not viewport width, so a
// touch laptop gets the sheet and a narrow desktop window stays on hover.
//
// Defaults to `true` until mounted (SSR has no matchMedia); the toolbar is the
// safe default — it's hidden until hover anyway, so a touch device briefly
// preferring it is invisible before the effect corrects it on first paint.
const QUERY = "(hover: hover) and (pointer: fine)";

export function useHoverCapable(): boolean {
  const [hoverCapable, setHoverCapable] = useAtom(useCreateAtom(true));

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const onChange = () => setHoverCapable(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [setHoverCapable]);

  return hoverCapable;
}
