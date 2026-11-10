export function messageScrollBehavior(behavior: ScrollBehavior = "smooth"): ScrollBehavior {
  if (behavior !== "smooth") return behavior
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
}
